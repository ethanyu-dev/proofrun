//! 节点主动连接控制面。终态消息保存在 SQLite outbox，收到确认后才删除；
//! 断线不会立即取消浏览器操作，现有操作仍受租约期限约束。
use crate::{node::Node, process};
use anyhow::{Result, ensure};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::{
    sync::{Notify, mpsc},
    task::JoinSet,
    time::{interval, timeout},
};
use tokio_tungstenite::tungstenite::{
    Message, client::IntoClientRequest, protocol::WebSocketConfig,
};
use tokio_util::{
    codec::{FramedRead, FramedWrite, LinesCodec},
    sync::CancellationToken,
};

/// 普通命令的并发上限；额外空间留给续租和关闭等控制命令。
const NORMAL_JOB_LIMIT: usize = 64;
/// 包含控制命令在内的任务总上限。
const TOTAL_JOB_LIMIT: usize = 128;
/// 待发送结果的内存通道容量；终态仍由 SQLite outbox 保底。
const OUTBOUND_QUEUE_CAPACITY: usize = 64;
/// 心跳及未确认结果的重送周期。
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
/// 网关在此期限内没有任何入站消息时主动重连。
const GATEWAY_IDLE_LIMIT: Duration = Duration::from_secs(30);
/// 写入网关或本地测试管道的单次最长等待。
const SEND_TIMEOUT: Duration = Duration::from_secs(3);
/// 待上传证据的重试周期。
const ARTIFACT_RETRY_INTERVAL: Duration = Duration::from_secs(10);

/// 验证端点地址；只有本机回环允许明文连接，且 URL 不携带凭据。
pub fn validate_endpoint(value: &str) -> Result<()> {
    let url = reqwest::Url::parse(value)?;
    ensure!(
        url.username().is_empty() && url.password().is_none(),
        "credentials belong in credential_file"
    );
    let secure = matches!(url.scheme(), "https" | "wss");
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    ensure!(
        secure || (local && matches!(url.scheme(), "http" | "ws")),
        "TLS required outside loopback"
    );
    Ok(())
}
/// 处理 ACK 或下发命令；为续租和关闭预留独立的任务容量。
async fn route(
    node: &Arc<Node>,
    value: Value,
    jobs: &mut JoinSet<()>,
    out: &mpsc::Sender<Value>,
) -> Result<()> {
    if value["type"] == "hitl.attach" || value["type"] == "live.attach" {
        if jobs.len() < NORMAL_JOB_LIMIT {
            let node = node.clone();
            jobs.spawn(async move {
                if crate::live::relay(node, value).await.is_err() {
                    tracing::warn!("人工画面通道已关闭或无法连接");
                }
            });
        }
        return Ok(());
    }
    if value["type"] == "ack" {
        if let Some(id) = value["messageId"].as_str() {
            node.store.ack(id.into()).await?;
        }
        return Ok(());
    }
    let payload = if value["type"] == "command" {
        value["command"].clone()
    } else {
        value
    };
    if jobs.len() >= TOTAL_JOB_LIMIT
        || (jobs.len() >= NORMAL_JOB_LIMIT
            && !matches!(
                payload["command"]["type"].as_str(),
                Some("session.close" | "session.renew")
            ))
    {
        let _ = out.try_send(json!({"type":"protocol.error","code":"NODE_BUSY"}));
        return Ok(());
    }
    let node = node.clone();
    let out = out.clone();
    jobs.spawn(async move {
        let result = node.handle(payload).await;
        let _ = out.try_send(result);
    });
    Ok(())
}
/// 使用与正式网关相同的命令处理器运行本地 JSONL 集成测试入口。
pub async fn serve_stdio(node: Arc<Node>, stop: CancellationToken) -> Result<()> {
    let mut input = FramedRead::new(
        tokio::io::stdin(),
        LinesCodec::new_with_max_length(process::OUTPUT_LIMIT),
    );
    let mut output = FramedWrite::new(
        tokio::io::stdout(),
        LinesCodec::new_with_max_length(process::OUTPUT_LIMIT),
    );
    let (tx, mut rx) = mpsc::channel::<Value>(OUTBOUND_QUEUE_CAPACITY);
    let mut jobs = JoinSet::new();
    let mut tick = interval(HEARTBEAT_INTERVAL);
    let result = async {
        loop {
            tokio::select! {
                _ = stop.cancelled() => break,
                _ = tick.tick() => timeout(SEND_TIMEOUT, output.send(node.heartbeat().await?.to_string())).await??,
                Some(value) = rx.recv() => timeout(SEND_TIMEOUT, output.send(value.to_string())).await??,
                input = input.next() => match input {
                    Some(Ok(line)) => route(&node, serde_json::from_str(&line)?, &mut jobs, &tx).await?,
                    Some(Err(error)) => return Err(anyhow::Error::from(error)),
                    None => break,
                },
                _ = jobs.join_next(), if !jobs.is_empty() => {},
            }
        }
        Ok(())
    }.await;
    node.shutdown().await;
    while jobs.join_next().await.is_some() {}
    result
}
/// 主动连接控制面，运行心跳、命令收发、重连和证据上传循环。
pub async fn serve(node: Arc<Node>, stop: CancellationToken) -> Result<()> {
    validate_endpoint(&node.config.gateway_url)?;
    ensure!(
        matches!(
            reqwest::Url::parse(&node.config.gateway_url)?.scheme(),
            "ws" | "wss"
        ),
        "gateway_url must use ws/wss"
    );
    let token = node.config.credential()?;
    if let Some(endpoint) = &node.config.artifact_upload_url {
        validate_endpoint(endpoint)?;
        ensure!(
            matches!(reqwest::Url::parse(endpoint)?.scheme(), "http" | "https"),
            "artifact upload requires HTTP(S)"
        );
        // 上传与网关必须同源，避免机器凭据被发送到其他服务。
        let gateway = reqwest::Url::parse(&node.config.gateway_url)?;
        let upload = reqwest::Url::parse(endpoint)?;
        ensure!(
            gateway.host_str() == upload.host_str()
                && gateway.port_or_known_default() == upload.port_or_known_default(),
            "upload origin must match the gateway"
        );
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()?;
    let (tx, mut rx) = mpsc::channel::<Value>(OUTBOUND_QUEUE_CAPACITY);
    // 结果 ACK 表示控制面已登记截图清单，此时立即上传，避免每轮视觉决策等待重试周期。
    let upload_ready = Arc::new(Notify::new());
    let uploader = {
        let node = node.clone();
        let token = token.clone();
        let stop = stop.clone();
        let upload_ready = upload_ready.clone();
        let out = tx.clone();
        tokio::spawn(async move {
            let mut tick = interval(ARTIFACT_RETRY_INTERVAL);
            loop {
                tokio::select! {
                    _ = stop.cancelled() => break,
                    _ = tick.tick() => {},
                    _ = upload_ready.notified() => {},
                }
                let delivery = async {
                    node.artifacts.upload_pending(&client, &token).await?;
                    // 可用事件仍先入持久 outbox；即时发送队列满或断线时，由心跳重送保底。
                    for value in node.store.pending().await? {
                        if value["type"] == "artifact.available" {
                            let _ = out.try_send(value);
                        }
                    }
                    Ok::<_, anyhow::Error>(())
                }
                .await;
                if let Err(error) = delivery {
                    tracing::warn!(error = %error, "artifact delivery pending");
                }
            }
        })
    };
    let mut jobs = JoinSet::new();
    let mut delay = 1;
    while !stop.is_cancelled() {
        let attempt = async {
            let mut request = node.config.gateway_url.clone().into_client_request()?;
            request
                .headers_mut()
                .insert("Authorization", format!("Bearer {token}").parse()?);
            let config = WebSocketConfig::default()
                .max_message_size(Some(process::OUTPUT_LIMIT))
                .max_frame_size(Some(process::OUTPUT_LIMIT));
            let (mut socket, _) = timeout(
                Duration::from_secs(10),
                tokio_tungstenite::connect_async_with_config(request, Some(config), false),
            )
            .await??;
            delay = 1;
            let mut tick = interval(HEARTBEAT_INTERVAL);
            let mut last_received = tokio::time::Instant::now();
            loop {
                tokio::select! {
                    _ = stop.cancelled() => break,
                    _ = tick.tick() => {
                        ensure!(last_received.elapsed() < GATEWAY_IDLE_LIMIT, "gateway heartbeat expired");
                        timeout(SEND_TIMEOUT, socket.send(Message::Text(node.heartbeat().await?.to_string().into()))).await??;
                        for value in node.store.pending().await? {
                            timeout(SEND_TIMEOUT, socket.send(Message::Text(value.to_string().into()))).await??;
                        }
                    },
                    Some(value) = rx.recv() => timeout(SEND_TIMEOUT, socket.send(Message::Text(value.to_string().into()))).await??,
                    message = socket.next() => {
                        last_received = tokio::time::Instant::now();
                        match message {
                            Some(Ok(Message::Text(text))) => {
                                let value: Value = serde_json::from_str(&text)?;
                                let acknowledged = value["type"] == "ack";
                                route(&node, value, &mut jobs, &tx).await?;
                                if acknowledged {
                                    upload_ready.notify_one();
                                }
                            },
                            Some(Ok(Message::Ping(value))) => {
                                timeout(SEND_TIMEOUT, socket.send(Message::Pong(value))).await??;
                            },
                            Some(Ok(Message::Pong(_))) => {},
                            Some(Ok(Message::Close(_))) | None => break,
                            Some(Err(error)) => return Err(anyhow::Error::from(error)),
                            _ => anyhow::bail!("unsupported gateway frame"),
                        }
                    },
                    _ = jobs.join_next(), if !jobs.is_empty() => {},
                }
            }
            Ok::<_, anyhow::Error>(())
        };
        tokio::select! {
            _ = stop.cancelled() => {},
            result = attempt => {
                if let Err(error) = result {
                    tracing::warn!(error = %error, "gateway disconnected");
                }
            }
        }
        if !stop.is_cancelled() {
            tokio::select! {
                _ = stop.cancelled() => {},
                _ = tokio::time::sleep(Duration::from_secs(delay)) => {},
            }
            delay = (delay * 2).min(15);
        }
    }
    // 断线后等待在途命令结束；每条命令仍由自己的租约计时器约束。
    node.shutdown().await;
    while jobs.join_next().await.is_some() {}
    let _ = uploader.await;
    Ok(())
}
