//! 客户端直连入口。TLS 由回环前的本机代理终止，画面与输入使用独立连接。
mod heartbeat;
use crate::{control::Grant, node::Node, sessions::Session};
use anyhow::{Context, Result, ensure};
use futures_util::{SinkExt, StreamExt};
use heartbeat::Heartbeat;
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    time::timeout,
};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{
        Message,
        handshake::server::{Request, Response},
        protocol::WebSocketConfig,
    },
};
use tokio_util::sync::CancellationToken;

/// 入口连接数保护只限制网络资源，不作为浏览器任务容量。
const CONNECTION_LIMIT: usize = 128;
/// 在没有新帧和输入时也周期核实短租约。
const AUTH_CHECK_INTERVAL: Duration = Duration::from_millis(250);
/// 人工操作统一的执行上限，断线不触发自动重放。
const INPUT_TIMEOUT_MS: u64 = 15_000;
/// 首条消息必须在握手后五秒内完成认证。
const AUTH_TIMEOUT: Duration = Duration::from_secs(5);
/// 慢客户端不能无限保留待发送消息。
const WRITE_TIMEOUT: Duration = Duration::from_secs(3);
/// 本机流单帧的内存边界。
const FRAME_LIMIT: usize = 2 * 1024 * 1024;
/// 客户端控制消息的内存边界。
const INPUT_LIMIT: usize = 32 * 1024;
type Socket = WebSocketStream<TcpStream>;

/// 监听失败使整个节点停止接单，避免上报不可用的直连能力。
pub async fn serve(node: Arc<Node>, listener: TcpListener, stop: CancellationToken) -> Result<()> {
    let nodes = Arc::new(tokio::sync::RwLock::new(std::collections::BTreeMap::from(
        [(node.id.clone(), node)],
    )));
    serve_nodes(nodes, listener, stop).await
}
/// 所有绑定共用一个监听和网络连接上限。
pub async fn serve_nodes(
    nodes: crate::runtime::Nodes,
    listener: TcpListener,
    stop: CancellationToken,
) -> Result<()> {
    let permits = Arc::new(Semaphore::new(CONNECTION_LIMIT));
    let mut jobs = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = stop.cancelled() => break,
            connection = listener.accept() => {
                let (stream, _) = connection?;
                let Ok(permit) = permits.clone().try_acquire_owned() else { continue };
                let nodes = nodes.clone(); let cancelled = stop.clone();
                // 不记录帧、认证消息或输入值；异常退出至少留有可定位的通道生命周期记录。
                jobs.spawn(async move { let _permit = permit; tokio::select! { _ = cancelled.cancelled() => {}, result = accept(nodes, stream) => { if result.is_err() { tracing::warn!("客户端直连异常结束"); } } } });
            }
            _ = jobs.join_next(), if !jobs.is_empty() => {}
        }
    }
    jobs.abort_all();
    while jobs.join_next().await.is_some() {}
    Ok(())
}
/// HTTP 握手只提取路径和 Origin；凭证只允许放在 WebSocket 首条消息。
// tungstenite 握手回调固定返回完整 HTTP 错误响应，无法改为装箱错误。
#[allow(clippy::result_large_err)]
async fn accept(nodes: crate::runtime::Nodes, stream: TcpStream) -> Result<()> {
    let info = Arc::new(Mutex::new((String::new(), 0u8)));
    let captured = info.clone();
    let mut socket = timeout(
        AUTH_TIMEOUT,
        tokio_tungstenite::accept_hdr_async_with_config(
            stream,
            move |request: &Request, response: Response| {
                let media = match request.uri().path() {
                    "/hitl/frames" => 1,
                    "/live/frames" => 2,
                    _ => 0,
                };
                if request.uri().query().is_some()
                    || (media == 0 && request.uri().path() != "/hitl/control")
                {
                    return Err(tokio_tungstenite::tungstenite::http::Response::builder()
                        .status(404)
                        .body(None)
                        .unwrap());
                }
                let origin = request
                    .headers()
                    .get("Origin")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_owned();
                *captured.lock().unwrap() = (origin, media);
                Ok(response)
            },
            Some(
                WebSocketConfig::default()
                    .max_message_size(Some(INPUT_LIMIT))
                    .max_frame_size(Some(INPUT_LIMIT)),
            ),
        ),
    )
    .await??;
    let authenticated = authenticate(&nodes, &mut socket, &info).await;
    let (node, session, grant, revision, media) = match authenticated {
        Ok(value) => value,
        Err(_) => {
            let _ = send(&mut socket, json!({"type":"error","code":"HITL_INVALID","message":"直连授权已失效，请重新连接"})).await;
            return Ok(());
        }
    };
    if media > 0 {
        return frames(node, session, grant, revision, socket, media == 2).await;
    }
    let result = control(node, session.clone(), grant.clone(), revision, &mut socket).await;
    if result.is_err() {
        let _=send(&mut socket,json!({"type":"error","code":"HITL_UNAVAILABLE","message":"操作未获准或连接已失效，请重新连接检查状态；未确认操作不会重放"})).await;
    }
    // 只释放自身连接身份，旧连接退出不能撤销后来的新授权。
    let mut owner = session.control.lock().unwrap();
    if owner
        .grant
        .as_ref()
        .is_some_and(|g| g.token_hash == grant.token_hash)
    {
        owner.connected = false;
    }
    result
}
async fn authenticate(
    nodes: &crate::runtime::Nodes,
    socket: &mut Socket,
    info: &Mutex<(String, u8)>,
) -> Result<(Arc<Node>, Arc<Session>, Grant, u64, u8)> {
    let message = timeout(AUTH_TIMEOUT, socket.next())
        .await?
        .context("缺少认证")??;
    let value: Value = serde_json::from_str(message.to_text()?)?;
    ensure!(value["type"] == "authenticate", "首条消息必须认证");
    let node = {
        let nodes = nodes.read().await;
        match value["nodeId"].as_str() {
            Some(id) => nodes.get(id).cloned(),
            // 仅旧单控制面夹具兼容省略路由；显式绑定始终要求 nodeId。
            None if nodes.len() == 1 => nodes
                .values()
                .next()
                .filter(|n| n.binding.is_none())
                .cloned(),
            _ => None,
        }
        .context("绑定身份无效")?
    };
    node.authorize_binding().await?;
    let id = value["id"].as_str().context("缺少介入身份")?;
    let token = value["token"].as_str().context("缺少凭证")?;
    ensure!((32..=512).contains(&token.len()), "凭证长度错误");
    let (origin, media) = info.lock().unwrap().clone();
    for record in node.store.sessions().await? {
        let Some(session) = node.sessions.get(&record.session_id).await else {
            continue;
        };
        let matched = {
            let control = session.control.lock().unwrap();
            if media == 2 {
                control.has_watch(id)
            } else {
                control.grant.as_ref().is_some_and(|g| g.id == id)
            }
        };
        if matched {
            session.authorize(&record.lease_id, record.fence)?;
            let (grant, revision) = {
                let mut control = session.control.lock().unwrap();
                let grant = if media == 2 {
                    control.watch_auth(id, token, &origin)?
                } else {
                    control.authenticate(id, token, &origin, media == 1)?
                };
                (grant, control.revision)
            };
            return Ok((node, session, grant, revision, media));
        }
    }
    anyhow::bail!("会话不存在")
}
async fn send(socket: &mut Socket, value: Value) -> Result<()> {
    timeout(
        WRITE_TIMEOUT,
        socket.send(Message::Text(value.to_string().into())),
    )
    .await??;
    Ok(())
}
/// 导航、Cookie 与输入在节点边界再次限权，客户端不能构造任意浏览器命令。
fn operation_allowed(operation: &Value, grant: &Grant) -> Result<()> {
    ensure!(
        operation.get("tabScope").is_none(),
        "人工不能切换分组作用域"
    );
    match operation["type"].as_str() {
        Some("browser.input") => {}
        Some("browser.cookies.set") => {
            let url = reqwest::Url::parse(operation["url"].as_str().context("缺少地址")?)?;
            let target =
                reqwest::Url::parse(grant.state["targetUrl"].as_str().context("缺少目标")?)?;
            ensure!(
                url.origin() == target.origin()
                    && url.username().is_empty()
                    && url.password().is_none(),
                "Cookie 只能写入任务目标站点"
            );
        }
        Some("browser.act") => {
            let allowed: &[&str] = if operation["action"] == "navigate" {
                &["type", "action", "target"]
            } else {
                &["type", "action"]
            };
            ensure!(
                operation
                    .as_object()
                    .context("无效操作")?
                    .keys()
                    .all(|k| allowed.contains(&k.as_str())),
                "导航参数越权"
            );
            if operation["action"] == "navigate" {
                let url = reqwest::Url::parse(operation["target"].as_str().context("缺少地址")?)?;
                ensure!(
                    matches!(url.scheme(), "http" | "https")
                        && url.username().is_empty()
                        && url.password().is_none(),
                    "仅允许网页导航"
                );
            } else {
                ensure!(operation["action"] == "reload", "仅允许导航或刷新");
            }
        }
        _ => anyhow::bail!("人工操作越权"),
    }
    Ok(())
}
/// 控制连接持有核实过的会话身份，后续消息不能自行选择其他浏览器。
struct Controller {
    /// 执行入口及可靠事件账本。
    node: Arc<Node>,
    /// 当前受租约管理的会话。
    session: Arc<Session>,
    /// 该连接认证通过的能力快照。
    grant: Grant,
    /// 连接建立时的控制代次。
    revision: u64,
    /// 不可变的节点、会话与租约身份。
    record: crate::store::SessionRecord,
}
impl Controller {
    /// 无输入时也检查撤权；完成通知只有节点确认 AUTO 或无法处理事件 ACK 后发出。
    async fn poll(&self, socket: &mut Socket) -> Result<bool> {
        self.node.authorize_binding().await?;
        let (done, pending) = {
            let control = self.session.control.lock().unwrap();
            (
                !control.human && control.revision > self.revision,
                control.completion.clone(),
            )
        };
        if done {
            send(socket, json!({"type":"completed","authStatus":"disabled"})).await?;
            return Ok(false);
        }
        if let Some(event) = pending
            && event["completion"]["type"] == "unable"
            && !self
                .node
                .store
                .event_pending(event["messageId"].as_str().unwrap().to_owned())
                .await?
        {
            send(
                socket,
                json!({"type":"unable","reason":event["completion"]["reason"]}),
            )
            .await?;
            return Ok(false);
        }
        self.session
            .authorize(&self.session.lease_id, self.session.fence)?;
        self.session
            .control
            .lock()
            .unwrap()
            .active(&self.grant.token_hash, self.revision)?;
        Ok(true)
    }
    /// 返回 false 关闭当前连接；预检查失败的导航允许处理者修正，未知操作绝不重放。
    async fn message(&self, socket: &mut Socket, message: Message) -> Result<bool> {
        self.node.authorize_binding().await?;
        if let Message::Ping(data) = message {
            timeout(WRITE_TIMEOUT, socket.send(Message::Pong(data))).await??;
            return Ok(true);
        }
        if message.is_close() {
            return Ok(false);
        }
        if matches!(message, Message::Pong(_)) {
            return Ok(true);
        }
        let value: Value = serde_json::from_str(message.to_text()?)?;
        self.session
            .authorize(&self.session.lease_id, self.session.fence)?;
        {
            let control = self.session.control.lock().unwrap();
            control.active(&self.grant.token_hash, self.revision)?;
            ensure!(!control.finalizing, "交接已经提交");
        }
        match value["type"].as_str() {
            Some("command") => self.command(socket, &value).await,
            Some("complete" | "unable") => {
                self.finish(value).await?;
                Ok(true)
            }
            _ => anyhow::bail!("无效消息"),
        }
    }
    /// 人工输入共用节点执行账本；只把不含输入值的结果发送到两个外部连接。
    async fn command(&self, socket: &mut Socket, value: &Value) -> Result<bool> {
        if operation_allowed(&value["command"], &self.grant).is_err() {
            let navigation = value["command"]["type"] == "browser.act";
            send(socket,json!({"type":"error","code":if navigation {"HITL_NAVIGATION"} else {"HITL_COMMAND"},"message":"操作超出当前处理权限，请检查地址和输入"})).await?;
            return Ok(navigation);
        }
        let command = json!({"protocolVersion":"0.1","commandId":value["commandId"],"nodeId":self.node.id,"nodeEpoch":self.node.epoch,"sessionId":self.record.session_id,"leaseId":self.record.lease_id,"fence":self.record.fence,"timeoutMs":INPUT_TIMEOUT_MS,"actor":"HUMAN","controlRevision":self.revision,"command":value["command"]});
        let result = self.node.handle_human(command, &self.grant.id).await;
        if result.get("operationStatus").is_none() {
            send(socket,json!({"type":"error","code":"HITL_COMMAND","message":"命令格式无效或结果尚未确定，请重新连接检查状态"})).await?;
            return Ok(false);
        }
        send(socket,json!({"type":"result","commandId":value["commandId"],"status":result["operationStatus"],"effect":result["effect"]})).await?;
        Ok(result["operationStatus"] == "SUCCEEDED")
    }
    /// 冻结与结果落盘共享串行许可；写盘失败时回收会话，不能开放自动操作。
    async fn finish(&self, value: Value) -> Result<()> {
        validate_completion(&value, &self.grant)?;
        let _permit = self.session.try_acquire()?;
        let event = {
            let mut control = self.session.control.lock().unwrap();
            control.authorize(true, self.revision)?;
            control.finalizing = true;
            json!({"type":"hitl.finished","messageId":format!("hitl-finish:{}:{}",self.grant.id,self.revision),"nodeId":self.node.id,"nodeEpoch":self.node.epoch,"sessionId":self.record.session_id,"leaseId":self.record.lease_id,"fence":self.record.fence,"interventionId":self.grant.id,"controlRevision":self.revision,"authRevision":control.auth_revision,"completion":value})
        };
        if let Err(error) = self.node.store.event(event.clone()).await {
            let _ = self.session.close().await;
            return Err(error);
        }
        self.session.control.lock().unwrap().completion = Some(event);
        Ok(())
    }
}
/// 独立控制连接只处理输入和回执，媒体背压不会占用这个发送队列。
async fn control(
    node: Arc<Node>,
    session: Arc<Session>,
    grant: Grant,
    revision: u64,
    socket: &mut Socket,
) -> Result<()> {
    let mut initial = grant.state.clone();
    initial["finalizing"] = json!(session.control.lock().unwrap().finalizing);
    send(socket, initial).await?;
    let record = node
        .store
        .sessions()
        .await?
        .into_iter()
        .find(|r| r.lease_id == session.lease_id && r.fence == session.fence)
        .context("会话记录缺失")?;
    let controller = Controller {
        node,
        session,
        grant,
        revision,
        record,
    };
    let mut tick = tokio::time::interval(AUTH_CHECK_INTERVAL);
    let mut heartbeat = Heartbeat::new(Instant::now());
    loop {
        let keep = tokio::select! {
            _=tick.tick()=>{
                if !controller.poll(socket).await? { return Ok(()); }
                if let Some(payload) = heartbeat.tick(Instant::now())? {
                    timeout(WRITE_TIMEOUT, socket.send(Message::Ping(payload.to_vec().into()))).await??;
                }
                true
            },
            message=socket.next()=>match message {
                Some(Ok(Message::Pong(payload)))=>{heartbeat.pong(&payload);true},
                Some(message)=>controller.message(socket,message?).await?,
                None=>false,
            },
        };
        if !keep {
            return Ok(());
        }
    }
}
/// 待办必须完整且不重复；固定 policy 仍由 Agent 复核。
fn validate_completion(value: &Value, grant: &Grant) -> Result<()> {
    if value["type"] == "unable" {
        let reason = value["reason"].as_str().context("请填写原因")?;
        ensure!(
            !reason.trim().is_empty() && reason.encode_utf16().count() <= 2000,
            "原因长度错误"
        );
        ensure!(
            value
                .as_object()
                .unwrap()
                .keys()
                .all(|key| ["type", "reason"].contains(&key.as_str())),
            "额外无法处理参数"
        );
        return Ok(());
    }
    let items = grant.state["items"].as_array().context("待办缺失")?;
    let checked = value["confirmedItems"].as_array().context("请确认待办")?;
    ensure!(
        checked.len() == items.len() && (0..items.len()).all(|i| checked.contains(&json!(i))),
        "待办确认不完整"
    );
    if let Some(keys) = grant.state.get("conditionKeys") {
        let confirmed = value["confirmedConditionKeys"]
            .as_array()
            .context("条件确认缺失")?;
        let keys = keys.as_array().context("条件无效")?;
        ensure!(
            confirmed.len() == keys.len() && keys.iter().all(|k| confirmed.contains(k)),
            "条件确认不完整"
        );
    } else {
        ensure!(
            value.get("confirmedConditionKeys").is_none(),
            "当前交接没有条件键"
        );
    }
    ensure!(
        value.as_object().unwrap().keys().all(|k| [
            "type",
            "confirmedItems",
            "confirmedConditionKeys"
        ]
        .contains(&k.as_str())),
        "额外完成参数"
    );
    Ok(())
}
/// 媒体连接只发送帧；背压达到写期限则断开，绝不在媒体入口执行输入。
async fn frames(
    node: Arc<Node>,
    session: Arc<Session>,
    grant: Grant,
    revision: u64,
    mut socket: Socket,
    readonly: bool,
) -> Result<()> {
    let _permit = if readonly {
        None
    } else {
        Some(session.stream_permit()?)
    };
    let record = node
        .store
        .sessions()
        .await?
        .into_iter()
        .find(|r| r.lease_id == session.lease_id && r.fence == session.fence)
        .context("会话不存在")?;
    let path = crate::engine::socket_directory(&record.launch_id)
        .join(format!("{}.stream", record.launch_id));
    let port: u16 = tokio::fs::read_to_string(path).await?.trim().parse()?;
    let (mut local, _) = timeout(
        WRITE_TIMEOUT,
        tokio_tungstenite::connect_async_with_config(
            format!("ws://127.0.0.1:{port}/?maxFps=8&pacing=ack"),
            Some(
                WebSocketConfig::default()
                    .max_message_size(Some(FRAME_LIMIT))
                    .max_frame_size(Some(FRAME_LIMIT)),
            ),
            false,
        ),
    )
    .await??;
    let mut tick = tokio::time::interval(AUTH_CHECK_INTERVAL);
    let mut heartbeat = Heartbeat::new(Instant::now());
    loop {
        tokio::select! {
            _=tick.tick()=>{
                node.authorize_binding().await?; session.authorize(&session.lease_id,session.fence)?; frame_authorize(&session,&grant,revision,readonly)?;
                if let Some(payload) = heartbeat.tick(Instant::now())? {
                    timeout(WRITE_TIMEOUT, socket.send(Message::Ping(payload.to_vec().into()))).await??;
                }
            },
            incoming=socket.next()=>match incoming {Some(Ok(Message::Ping(data)))=>{timeout(WRITE_TIMEOUT,socket.send(Message::Pong(data))).await??;},Some(Ok(Message::Pong(data)))=>{heartbeat.pong(&data)},_=>return Ok(())},
            message=local.next()=>{
                let Some(message)=message else{return Ok(())};let message=message?;
                if let Message::Text(text)=message {
                    let value:Value=serde_json::from_str(&text)?;
                    if value["type"]!="frame" {continue}
                    ensure!(value["data"].as_str().is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))) && ["deviceWidth","deviceHeight"].iter().all(|key| value["metadata"][key].as_f64().is_some_and(|n| n>0.0 && n<=16384.0)), "无效画面");
                    node.authorize_binding().await?; session.authorize(&session.lease_id,session.fence)?;frame_authorize(&session,&grant,revision,readonly)?;
                    send(&mut socket,json!({"type":"frame","data":value["data"],"width":value["metadata"]["deviceWidth"],"height":value["metadata"]["deviceHeight"],"capturedAt":crate::control::unix_ms()})).await?;
                    if let Some(seq)=value["seq"].as_u64(){timeout(WRITE_TIMEOUT,local.send(Message::Text(json!({"type":"ack","seq":seq}).to_string().into()))).await??;}
                }
            }
        }
    }
}

/// 媒体授权按连接角色检查，观看凭证始终不能用于输入。
fn frame_authorize(
    session: &Session,
    grant: &Grant,
    revision: u64,
    readonly: bool,
) -> crate::error::Result<()> {
    let control = session.control.lock().unwrap();
    if readonly {
        control.watch_active(&grant.id, revision)
    } else {
        control.active(&grant.token_hash, revision)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn grant() -> Grant {
        serde_json::from_value(json!({"id":"i","tokenHash":"a".repeat(64),"origin":"https://console.test","connectExpiresAt":1,"expiresAt":2,"authRevision":0,"state":{"targetUrl":"https://target.test/app","items":["登录","权限"],"conditionKeys":["a","b"]}})).unwrap()
    }
    // 范围：直连操作的能力边界和 Cookie origin；不执行网页、Cookie 或脚本。
    #[test]
    fn direct_operations_cannot_escape_authorized_scope() {
        let grant = grant();
        assert!(operation_allowed(&json!({"type":"session.close"}), &grant).is_err());
        assert!(
            operation_allowed(
                &json!({"type":"browser.act","action":"navigate","target":"file:///etc/passwd"}),
                &grant
            )
            .is_err()
        );
        assert!(
            operation_allowed(
                &json!({"type":"browser.cookies.set","url":"https://other.test"}),
                &grant
            )
            .is_err()
        );
        assert!(
            operation_allowed(
                &json!({"type":"browser.input","action":"click","tabScope":"other"}),
                &grant
            )
            .is_err()
        );
        assert!(
            operation_allowed(&json!({"type":"browser.act","action":"reload"}), &grant).is_ok()
        );
    }
    // 范围：完整待办与稳定条件确认，拒绝重复序号和额外字段；不证明业务环境就绪。
    #[test]
    fn completion_requires_exact_confirmation() {
        let grant = grant();
        assert!(validate_completion(&json!({"type":"complete","confirmedItems":[0,0],"confirmedConditionKeys":["a","b"]}),&grant).is_err());
        assert!(
            validate_completion(
                &json!({"type":"complete","confirmedItems":[0,1],"confirmedConditionKeys":["a"]}),
                &grant
            )
            .is_err()
        );
        assert!(validate_completion(&json!({"type":"complete","confirmedItems":[0,1],"confirmedConditionKeys":["a","b"]}),&grant).is_ok());
        let mut simple = grant.clone();
        simple
            .state
            .as_object_mut()
            .unwrap()
            .remove("conditionKeys");
        assert!(
            validate_completion(
                &json!({"type":"complete","confirmedItems":[0,1],"confirmedConditionKeys":[]}),
                &simple
            )
            .is_err()
        );
        assert!(
            validate_completion(
                &json!({"type":"unable","reason":"无法处理","extra":true}),
                &grant
            )
            .is_err()
        );
    }
}
