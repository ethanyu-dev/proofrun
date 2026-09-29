//! 节点命令入口：先校验并登记身份，再派发动作；结果提交后才释放会话许可。
//! 重启后未提交结果恢复为 UNKNOWN，不重放浏览器动作。
use crate::{
    artifacts::{self, Artifacts},
    config::NodeConfig,
    engine,
    error::{Fault, Result},
    process,
    protocol::{BrowserCommand, NodeCommand},
    sessions::Sessions,
    store::{Begin, Store},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::Mutex;

/// 启动时探测 systemd 和引擎版本的最长等待。
const DEPENDENCY_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// 外部身份字段的最大长度，避免把任意大字符串写入账本或 unit 标识。
const MAX_IDENTIFIER_LENGTH: usize = 128;

/// 常驻节点主服务。全局状态来自控制面；这里仅持有本机身份、会话和恢复账本。
pub struct Node {
    /// 安装后持久不变的节点身份。
    pub id: String,
    /// 每次主进程启动重新生成，用于拒绝旧进程的命令。
    pub epoch: String,
    /// 启动时校验并规范化的本机配置。
    pub config: Arc<NodeConfig>,
    /// 持久命令记录、会话状态和待确认消息。
    pub store: Store,
    /// 本机会话登记、容量准入和关闭监管。
    pub sessions: Sessions,
    /// 截图的本地落盘与上传处理。
    pub artifacts: Artifacts,
    /// 最近心跳的租约请求 ID 到发出时刻，按 CLOCK_BOOTTIME 计时。
    requests: Mutex<BTreeMap<String, u64>>,
    /// 独占 home 的文件锁，随 Node 生命周期持有。
    _lock: artifacts::HomeLock,
}
impl Node {
    /// 恢复旧会话并确认进程范围已关闭后，才开始接收新命令。
    pub async fn start(mut config: NodeConfig) -> anyhow::Result<Arc<Self>> {
        anyhow::ensure!(
            cfg!(target_os = "linux"),
            "serve requires Linux/systemd; use doctor or engine tests on macOS"
        );
        config.prepare()?;
        let lock = artifacts::lock_home(&config.home)?;
        let id = artifacts::installation_id(&config.home)?;
        let store = Store::open(&config.home.join("node.db"))?;
        // 先处理上次进程遗留的会话；无法证实关闭时保持隔离并拒绝启动。
        for mut record in store.sessions().await? {
            if record.cgroup.is_none() {
                let _ = process::identify(&mut record).await;
            }
            let closed = process::close(&record).await;
            record.state = if closed.is_ok() {
                "CLOSED"
            } else {
                "QUARANTINED"
            }
            .into();
            store.save_session(record).await?;
            if let Err(error) = closed {
                anyhow::bail!("recovery requires attention: {error}")
            }
        }
        // 上次未提交结果的命令只恢复成 UNKNOWN，绝不重新执行页面动作。
        store.recover_commands().await?;
        let mut inventory = tokio::process::Command::new("systemctl");
        inventory
            .args([
                "--user",
                "list-units",
                "--state=active,activating,deactivating",
                "--plain",
                "--no-legend",
            ])
            .arg(format!("proofrun-{id}-*.service"));
        let (ok, out, _) = process::capture(inventory, DEPENDENCY_PROBE_TIMEOUT).await?;
        anyhow::ensure!(
            ok && out.iter().all(u8::is_ascii_whitespace),
            "unreconciled units remain in this node namespace"
        );
        let mut probe = tokio::process::Command::new(&config.agent_browser_bin);
        probe.arg("--version");
        let (ok, version, _) = process::capture(probe, DEPENDENCY_PROBE_TIMEOUT).await?;
        anyhow::ensure!(
            ok && String::from_utf8_lossy(&version)
                .split_whitespace()
                .any(|part| part == engine::PINNED_AGENT_BROWSER_VERSION),
            "agent-browser version does not match pinned baseline"
        );
        let config = Arc::new(config);
        let epoch = uuid::Uuid::new_v4().to_string();
        let sessions = Sessions::new(config.clone(), store.clone(), id.clone(), epoch.clone());
        let artifacts = Artifacts::new(config.clone(), store.clone());
        Ok(Arc::new(Self {
            id,
            epoch,
            config,
            store,
            sessions,
            artifacts,
            requests: Mutex::new(BTreeMap::new()),
            _lock: lock,
        }))
    }
    /// 发布节点容量及能力，同时生成下一次租约授权要回带的请求 ID。
    pub async fn heartbeat(&self) -> anyhow::Result<Value> {
        self.sessions.reap().await;
        let request = uuid::Uuid::new_v4().to_string();
        let now = process::boot_ms();
        let mut requests = self.requests.lock().await;
        requests.retain(|_, sent| now.saturating_sub(*sent) <= self.config.max_lease_ms);
        requests.insert(request.clone(), now);
        drop(requests);
        let occupied: Vec<_> = self.store.sessions().await?.into_iter().map(|record| json!({
            "sessionId":record.session_id,"state":record.state,"leaseId":record.lease_id,"fence":record.fence
        })).collect();
        Ok(
            json!({"type":"node.heartbeat","protocolVersion":"0.1","nodeId":self.id,"nodeEpoch":self.epoch,"leaseRequestId":request,"pool":self.config.pool,"capacity":self.config.capacity,"limits":{"maxLeaseMs":self.config.max_lease_ms,"maxSessionMs":self.config.max_session_ms},"occupied":occupied,"capabilities":{"observe":true,"screenshot":true,"conditionWait":true,"writeActions":self.config.allow_unverified_writes,"engineWritesVerified":false,"networkEvidence":true,"authState":true,"liveView":true,"trace":true}}),
        )
    }
    /// 将控制面的 TTL 锚定到对应心跳的发出时刻，网络延迟也消耗租约。
    async fn deadline(&self, id: &str, ttl: u64) -> Result<u64> {
        if ttl == 0 || ttl > self.config.max_lease_ms {
            return Err(Fault::rejected(
                "INVALID_LEASE",
                "lease TTL exceeds node limit",
            ));
        }
        let requests = self.requests.lock().await;
        let sent = requests
            .get(id)
            .ok_or_else(|| Fault::rejected("INVALID_LEASE", "unknown lease request"))?;
        // 租约从节点发出请求时起算，不能让晚到的授权重新获得完整 TTL。
        let end = sent + ttl;
        if end <= process::boot_ms() {
            return Err(Fault::rejected(
                "LEASE_EXPIRED",
                "grant arrived after its conservative deadline",
            ));
        }
        Ok(end)
    }
    /// 校验、去重、派发并持久化一条命令；同 ID 重送只返回原结果或进行中状态。
    pub async fn handle(&self, value: Value) -> Value {
        let received = process::boot_ms();
        let command: NodeCommand = match crate::protocol::parse_command(value) {
            Ok(c) => c,
            Err(_) => return json!({"type":"protocol.error","code":"INVALID_COMMAND"}),
        };
        let mut meta = json!({"protocolVersion":"0.1","type":"command.result","messageId":command.command_id,"commandId":command.command_id,"sessionId":command.session_id,"nodeId":command.node_id,"nodeEpoch":command.node_epoch,"leaseId":command.lease_id,"fence":command.fence});
        if let Err(fault) = self.validate(&command) {
            return failure(meta, fault);
        }
        // hash 绑定完整命令信封，防止复用 commandId 更换会话、租约或参数。
        let hash = hex::encode(Sha256::digest(serde_json::to_vec(&command).unwrap()));
        match self
            .store
            .begin(command.command_id.clone(), hash, meta.clone())
            .await
        {
            Ok(Begin::Finished(result)) => return result,
            Ok(Begin::Pending) => {
                meta["type"] = "command.pending".into();
                return meta;
            }
            Ok(Begin::New) => {}
            Err(error) => {
                return failure(
                    meta,
                    Fault::rejected(
                        if error
                            .downcast_ref::<crate::store::AdmissionError>()
                            .is_some()
                        {
                            "COMMAND_CONFLICT"
                        } else {
                            "STORE_FAILED"
                        },
                        error.to_string(),
                    ),
                );
            }
        }
        let session = self.sessions.get(&command.session_id).await;
        let browser = matches!(
            command.command,
            BrowserCommand::BrowserAct { .. }
                | BrowserCommand::BrowserObserve { .. }
                | BrowserCommand::BrowserWait { .. }
                | BrowserCommand::BrowserAuthSave
                | BrowserCommand::BrowserInput { .. }
                | BrowserCommand::BrowserTrace { .. }
        );
        // 操作许可持有到结果落盘，不能仅凭 CLI 调用结束就放行下一条动作。
        let permit = if browser {
            session.as_ref().map(|s| s.try_acquire()).transpose()
        } else {
            Ok(None)
        };
        let result = match &permit {
            Err(error) => Err(error.clone()),
            Ok(_) => {
                self.dispatch(&command, session, received + command.timeout_ms)
                    .await
            }
        };
        let response = match result {
            Ok(mut data) => {
                match self
                    .artifacts
                    .collect(&command.session_id, &command.command_id, &mut data)
                    .await
                {
                    Ok(()) => {
                        meta["operationStatus"] = "SUCCEEDED".into();
                        meta["effect"] = "COMPLETED".into();
                        meta["data"] = data;
                        meta
                    }
                    Err(error) => {
                        failure(meta, Fault::unknown("ARTIFACT_FAILED", error.to_string()))
                    }
                }
            }
            Err(fault) => failure(meta, fault),
        };
        if let Err(error) = self
            .store
            .finish(command.command_id.clone(), response.clone())
            .await
        {
            self.sessions.shutdown().await;
            return failure(response, Fault::unknown("STORE_FAILED", error.to_string()));
        }
        tracing::info!(
            command_id = %command.command_id, session_id = %command.session_id,
            operation_status = %response["operationStatus"], effect = %response["effect"],
            elapsed_ms = process::boot_ms().saturating_sub(received), "command committed"
        );
        drop(permit);
        response
    }
    /// 在读取去重账本前检查节点身份，避免旧 epoch 借重送绕过授权。
    fn validate(&self, command: &NodeCommand) -> Result<()> {
        if command.protocol_version != "0.1"
            || command.node_id != self.id
            || command.node_epoch != self.epoch
        {
            return Err(Fault::rejected(
                "STALE_NODE",
                "protocol or node incarnation mismatch",
            ));
        }
        for id in [&command.command_id, &command.session_id, &command.lease_id] {
            if id.is_empty()
                || id.len() > MAX_IDENTIFIER_LENGTH
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                return Err(Fault::rejected("INVALID_ARGUMENT", "invalid identifier"));
            }
        }
        if command.fence == 0
            || command.timeout_ms == 0
            || command.timeout_ms > self.config.max_session_ms
        {
            return Err(Fault::rejected(
                "INVALID_ARGUMENT",
                "invalid fence or timeout",
            ));
        }
        Ok(())
    }
    /// 按命令类别分流；关闭走清理授权，其他操作要求活跃租约。
    async fn dispatch(
        &self,
        command: &NodeCommand,
        session: Option<Arc<crate::sessions::Session>>,
        command_deadline: u64,
    ) -> Result<Value> {
        if process::boot_ms() >= command_deadline {
            return Err(Fault::rejected(
                "DEADLINE_EXCEEDED",
                "command expired before dispatch",
            ));
        }
        match &command.command {
            BrowserCommand::SessionOpen {
                lease_request_id,
                lease_ttl_ms,
                max_duration_ms,
                ..
            } => {
                if *max_duration_ms == 0 || *max_duration_ms > self.config.max_session_ms {
                    return Err(Fault::rejected(
                        "INVALID_ARGUMENT",
                        "session duration exceeds limit",
                    ));
                }
                let deadline = self.deadline(lease_request_id, *lease_ttl_ms).await?;
                self.sessions
                    .open(command, deadline, *max_duration_ms, command_deadline)
                    .await
            }
            BrowserCommand::SessionClose => {
                // 当前已认证的控制面可凭原租约身份清理过期会话。
                let session =
                    session.ok_or_else(|| Fault::rejected("SESSION_MISSING", "no live session"))?;
                if session.lease_id != command.lease_id || session.fence != command.fence {
                    return Err(Fault::rejected("STALE_LEASE", "cleanup identity mismatch"));
                }
                session.close().await?;
                Ok(json!({"state":"CLOSED"}))
            }
            operation => {
                let session =
                    session.ok_or_else(|| Fault::rejected("SESSION_MISSING", "no live session"))?;
                session.authorize(&command.lease_id, command.fence)?;
                if let BrowserCommand::SessionRenew {
                    lease_request_id,
                    lease_ttl_ms,
                } = operation
                {
                    let deadline = self.deadline(lease_request_id, *lease_ttl_ms).await?;
                    session.renew(deadline)?;
                    return Ok(json!({"renewed":true}));
                }
                engine::validate(operation, self.config.allow_unverified_writes)?;
                session.execute(operation.clone(), command_deadline).await
            }
        }
    }
    /// 停止接单并等待所有受监管会话完成关闭。
    pub async fn shutdown(&self) {
        self.sessions.shutdown().await;
    }
}
/// 将稳定错误分类映射为协议状态，同时保留副作用是否可能发生的判断。
fn failure(mut meta: Value, fault: Fault) -> Value {
    meta["operationStatus"] = match fault.code.as_str() {
        "CANCELLED" => "CANCELLED",
        "DEADLINE_EXCEEDED" => "TIMED_OUT",
        _ if fault.effect == "MAY_HAVE_HAPPENED" => "UNKNOWN",
        _ => "FAILED",
    }
    .into();
    meta["effect"] = fault.effect.into();
    meta["error"] = json!({"code":fault.code,"message":fault.message});
    meta
}
