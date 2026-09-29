//! 人工画面只经节点主动建立的独立通道发送，不进入命令 outbox，不转发任意引擎输入。
use crate::{engine, node::Node};
use anyhow::{Context, Result, ensure};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};

/// 限制单帧内存、低帧率和网络背压，画面不能拖住租约与命令通道。
const FRAME_LIMIT: usize = 2 * 1024 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Attach {
    #[serde(rename = "type")]
    kind: String,
    stream_id: String,
    session_id: String,
    node_epoch: String,
    lease_id: String,
    fence: u64,
}

/// 只信任已认证控制连接传来的会话身份；地址固定为同源中转和节点私有端口。
pub async fn relay(node: Arc<Node>, value: Value) -> Result<()> {
    let attach: Attach = serde_json::from_value(value)?;
    ensure!(
        matches!(attach.kind.as_str(), "hitl.attach" | "live.attach")
            && attach.node_epoch == node.epoch,
        "stale stream grant"
    );
    ensure!(
        uuid::Uuid::parse_str(&attach.stream_id).is_ok(),
        "invalid stream identity"
    );
    let session = node
        .sessions
        .get(&attach.session_id)
        .await
        .context("session missing")?;
    session.authorize(&attach.lease_id, attach.fence)?;
    let _permit = session.stream_permit()?;
    let record = node
        .store
        .sessions()
        .await?
        .into_iter()
        .find(|s| s.session_id == attach.session_id)
        .context("session record missing")?;
    let path =
        engine::socket_directory(&record.launch_id).join(format!("{}.stream", record.launch_id));
    let port: u16 = tokio::fs::read_to_string(path).await?.trim().parse()?;
    ensure!(port > 0, "invalid stream port");
    let config = || {
        tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
            .max_message_size(Some(FRAME_LIMIT))
            .max_frame_size(Some(FRAME_LIMIT))
    };
    let local_url = format!("ws://127.0.0.1:{port}/?maxFps=8&pacing=ack");
    let (mut local, _) = tokio::time::timeout(
        IO_TIMEOUT,
        tokio_tungstenite::connect_async_with_config(&local_url, Some(config()), false),
    )
    .await??;
    let mut url = reqwest::Url::parse(&node.config.gateway_url)?;
    url.set_path(if attach.kind == "live.attach" {
        "/v1/live/relay"
    } else {
        "/v1/hitl/relay"
    });
    url.set_query(None);
    let mut request = url.as_str().into_client_request()?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", node.config.credential()?).parse()?,
    );
    let (mut remote, _) = tokio::time::timeout(
        IO_TIMEOUT,
        tokio_tungstenite::connect_async_with_config(request, Some(config()), false),
    )
    .await??;
    remote
        .send(Message::Text(
            json!({"type":"attach","streamId":attach.stream_id,"nodeEpoch":node.epoch})
                .to_string()
                .into(),
        ))
        .await?;
    let mut lease = tokio::time::interval(Duration::from_millis(250));
    loop {
        tokio::select! {
            _ = lease.tick() => session.authorize(&attach.lease_id, attach.fence)?,
            message = remote.next() => match message {
                Some(Ok(Message::Ping(data))) => remote.send(Message::Pong(data)).await?,
                Some(Ok(Message::Pong(_))) => {},
                // 控制面只可关闭通道，绝不能经画面连接注入 CDP 或本地输入。
                _ => break,
            },
            message = local.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let value: Value = serde_json::from_str(&text)?;
                    if value["type"] == "frame" {
                        session.authorize(&attach.lease_id, attach.fence)?;
                        tokio::time::timeout(IO_TIMEOUT, remote.send(Message::Text(text))).await??;
                        if let Some(seq) = value["seq"].as_u64() {
                            tokio::time::timeout(IO_TIMEOUT, local.send(Message::Text(json!({"type":"ack","seq":seq}).to_string().into()))).await??;
                        }
                    }
                },
                Some(Ok(Message::Ping(data))) => local.send(Message::Pong(data)).await?,
                Some(Ok(Message::Pong(_))) => {},
                _ => break,
            }
        }
    }
    Ok(())
}
