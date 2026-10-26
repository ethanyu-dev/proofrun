//! 本机会话准入与监管。STARTING、CLOSING 和 QUARANTINED 状态持续占用容量，
//! 直到 systemd 确认进程范围已清空。会话内浏览器操作串行，续租和关闭走独立控制路径。
pub mod host;
mod startup;
use crate::{
    config::NodeConfig,
    engine::EngineConfig,
    error::{Fault, Result},
    process,
    protocol::{BrowserCommand, NodeCommand},
    store::{SessionRecord, Store},
};
use anyhow::Context;
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
    sync::{Mutex, Semaphore, mpsc, oneshot, watch},
};
use tokio_util::{
    codec::{FramedRead, LinesCodec},
    sync::CancellationToken,
};

/// 临时 profile 创建与浏览器初始化最多等待两分钟；续租不能延长此独立启动上限。
const HOST_STARTUP_LIMIT_MS: u64 = 120_000;
/// 定期检测 systemd-run 包装进程是否意外退出。
const HOST_HEALTH_INTERVAL: Duration = Duration::from_secs(1);
/// 关闭时先给 host 一个短暂机会自行退出，再由 systemd 强制清理。
const HOST_CLOSE_NOTIFY_TIMEOUT: Duration = Duration::from_millis(200);
/// cgroup 关闭确认后等待包装进程退出的上限。
const HOST_EXIT_TIMEOUT: Duration = Duration::from_secs(2);
/// 只保存少量诊断输出，避免异常 host 无限写 stderr。
const HOST_STDERR_LIMIT: usize = 64 * 1024;

/// 主服务投递给单个 session-host 的一次浏览器操作。
struct Work {
    /// 已通过外部协议校验的操作。
    command: BrowserCommand,
    /// 命令自己的绝对截止时间，另受会话租约限制。
    deadline_ms: u64,
    /// 将事实结果传回发起请求的任务。
    result: oneshot::Sender<Result<Value>>,
}
/// 一个已预留容量的本机会话及其独立控制路径。
pub struct Session {
    /// 控制面授予的租约身份。
    pub lease_id: String,
    /// 与租约绑定的栅栏值，阻止旧执行者继续操作。
    pub fence: u64,
    /// 所有入口共用的操作者、代次与人工凭证。
    pub control: std::sync::Mutex<crate::control::Control>,
    /// 当前租约期限，使用跨进程一致的 CLOCK_BOOTTIME 毫秒。
    pub deadline: AtomicU64,
    /// 普通会话总时限；人工可续期也不能越过外部账号硬期限，始终受短租约限制。
    pub hard_deadline: u64,
    /// 控制面私有种子只在节点内存与会话目录中使用。
    identity_seed: Option<serde_json::Value>,
    /// 外部账号元数据仅绑定当前会话，不允许保存为共享 profile。
    external_account: Option<serde_json::Value>,
    network_evidence: bool,
    /// 本次会话是否初始化实时画面，实际观看和操作分别授权。
    live_view: bool,
    /// 冻结本次会话的动画偏好，与身份配置无关。
    reduced_motion: bool,
    /// 关闭、到期或故障时立即撤销执行许可。
    cancel: CancellationToken,
    /// 首个显式关闭请求的来源；停机与控制面关闭不能互相覆盖。
    close_reason: std::sync::Mutex<Option<&'static str>>,
    /// 发送给本会话监管任务的有界浏览器操作队列。
    work: mpsc::Sender<Work>,
    /// 独立于浏览器操作的租约更新通知。
    renew: watch::Sender<u64>,
    /// systemd 关闭核实结果；失败时会话占用仍被保留。
    closed: watch::Receiver<Option<std::result::Result<(), String>>>,
    /// 从准入到结果持久化期间阻止第二个浏览器操作。
    busy: Arc<Semaphore>,
    /// 同一人工会话至多一个媒体连接，只读观看使用独立凭证。
    stream_busy: Arc<Semaphore>,
}
impl Session {
    /// 保存首个显式终止来源后撤权，后续关闭重试只等待原结果。
    fn request_close(&self, reason: &'static str) {
        self.close_reason.lock().unwrap().get_or_insert(reason);
        self.cancel.cancel();
    }

    /// 画面访问独立于操作队列，但仍受原会话许可约束。
    pub fn stream_permit(&self) -> Result<tokio::sync::OwnedSemaphorePermit> {
        if !self.live_view {
            return Err(Fault::rejected(
                "LIVE_VIEW_DISABLED",
                "task did not enable live view",
            ));
        }
        self.stream_busy
            .clone()
            .try_acquire_owned()
            .map_err(|_| Fault::rejected("STREAM_BUSY", "one viewer per session"))
    }
    /// 核验租约、栅栏和有效期；已取消或正在关闭的会话不再接单。
    pub fn authorize(&self, lease: &str, fence: u64) -> Result<()> {
        if self.lease_id != lease || self.fence != fence {
            return Err(Fault::rejected("STALE_LEASE", "lease or fence mismatch"));
        }
        if self.cancel.is_cancelled()
            || self.closed.borrow().is_some()
            || process::boot_ms() >= self.deadline.load(Ordering::SeqCst)
        {
            return Err(Fault::rejected(
                "SESSION_EXPIRED",
                "session no longer accepts operations",
            ));
        }
        Ok(())
    }
    /// 延长仍有效的租约，并通知正在等待浏览器结果的控制路径。
    pub fn renew(&self, deadline: u64) -> Result<()> {
        self.authorize(&self.lease_id, self.fence)?;
        let deadline = deadline.min(self.hard_deadline);
        if deadline <= process::boot_ms() {
            return Err(Fault::rejected("LEASE_EXPIRED", "renewal arrived too late"));
        }
        self.deadline.fetch_max(deadline, Ordering::SeqCst);
        self.renew
            .send_replace(self.deadline.load(Ordering::SeqCst));
        Ok(())
    }
    /// 不排队获取会话操作许可；忙碌时立即返回 SESSION_BUSY。
    /// 控制切换等待同一操作许可，防止管理员恢复越过正在执行的人工输入。
    pub async fn acquire_control(
        &self,
        timeout_ms: u64,
    ) -> Result<tokio::sync::OwnedSemaphorePermit> {
        tokio::time::timeout(
            Duration::from_millis(timeout_ms),
            self.busy.clone().acquire_owned(),
        )
        .await
        .map_err(|_| Fault::rejected("SESSION_BUSY", "等待浏览器操作结束超时"))?
        .map_err(|_| Fault::rejected("SESSION_CLOSED", "会话已经关闭"))
    }
    pub fn try_acquire(&self) -> Result<tokio::sync::OwnedSemaphorePermit> {
        self.busy
            .clone()
            .try_acquire_owned()
            .map_err(|_| Fault::rejected("SESSION_BUSY", "one browser operation at a time"))
    }
    /// 向本会话投递已准入操作，并等待 host 返回事实或不确定结果。
    pub async fn execute(&self, command: BrowserCommand, deadline_ms: u64) -> Result<Value> {
        self.authorize(&self.lease_id, self.fence)?;
        let (result, rx) = oneshot::channel();
        self.work
            .try_send(Work {
                command,
                deadline_ms,
                result,
            })
            .map_err(|_| Fault::rejected("SESSION_BUSY", "session unavailable"))?;
        rx.await.map_err(|_| {
            Fault::unknown("SESSION_CLOSED", "session closed before result delivery")
        })?
    }
    /// 撤销操作权限，并等待进程监管任务给出物理关闭结论。
    pub async fn close(&self) -> Result<()> {
        self.request_close("SESSION_CLOSE_REQUESTED");
        let mut closed = self.closed.clone();
        closed
            .wait_for(|value| value.is_some())
            .await
            .map_err(|_| Fault::unknown("CLOSURE_UNVERIFIED", "session supervisor stopped"))?;
        closed
            .borrow()
            .as_ref()
            .unwrap()
            .clone()
            .map_err(|message| Fault::unknown("CLOSURE_UNVERIFIED", message))
    }
}
#[derive(Clone)]
/// 节点本机的会话登记表；SQLite 记录才是跨重启的容量依据。
pub struct Sessions {
    /// 会话目录和容量等本机限制。
    pub config: Arc<NodeConfig>,
    /// 持久保存创建意图、状态和关闭事件。
    pub store: Store,
    /// 用于构造不会与其他节点冲突的 systemd unit 名。
    node_id: String,
    /// 写入会话记录，供控制面识别本次进程的终态事件。
    node_epoch: String,
    /// 当前进程内的取消句柄和投递通道。
    entries: Arc<Mutex<HashMap<String, Arc<Session>>>>,
    /// 停机后阻止任何新会话占用容量。
    stopping: CancellationToken,
    /// 创建请求与心跳共享的本机资源采样和准入裁决。
    pub admission: Arc<crate::admission::Admission>,
}
impl Sessions {
    /// 构建空登记表；启动恢复由 Node 在开放网关之前执行。
    pub fn new(config: Arc<NodeConfig>, store: Store, node_id: String, node_epoch: String) -> Self {
        Self {
            config,
            store,
            node_id,
            node_epoch,
            entries: Arc::new(Mutex::new(HashMap::new())),
            stopping: CancellationToken::new(),
            admission: Arc::new(crate::admission::Admission::default()),
        }
    }
    /// 读取进程内会话句柄，不查询历史已关闭会话。
    pub async fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.entries.lock().await.get(id).cloned()
    }
    /// 先持久预留容量和创建意图，再异步启动独立 session-host。
    pub async fn open(
        &self,
        command: &NodeCommand,
        deadline: u64,
        max_ms: u64,
        command_deadline: u64,
        account_deadline: Option<u64>,
    ) -> Result<Value> {
        let id = command.session_id.clone();
        let lease_id = command.lease_id.clone();
        let fence = command.fence;
        let launch_id = uuid::Uuid::new_v4().simple().to_string();
        let record = SessionRecord {
            close_reason: None,
            session_id: id.clone(),
            unit: format!("proofrun-{}-{launch_id}.service", self.node_id),
            boot_id: process::boot_id()
                .map_err(|e| Fault::rejected("UNSUPPORTED_HOST", e.to_string()))?,
            cgroup: None,
            invocation: None,
            state: "STARTING".into(),
            launch_id: launch_id.clone(),
            lease_id: lease_id.clone(),
            fence,
            node_epoch: self.node_epoch.clone(),
        };
        let (network_evidence, live_view) = match &command.command {
            BrowserCommand::SessionOpen {
                network_evidence,
                live_view,
                ..
            } => (
                network_evidence.unwrap_or(false),
                live_view.unwrap_or(false),
            ),
            _ => (false, false),
        };
        // 可续期会话只取消初始总时长；父进程和 host 的短租约看门狗仍各自撤权。
        let renewable = matches!(
            &command.command,
            BrowserCommand::SessionOpen {
                renewable: Some(true),
                ..
            }
        );
        let hard_deadline = (if renewable {
            u64::MAX
        } else {
            process::boot_ms() + max_ms
        })
        .min(account_deadline.unwrap_or(u64::MAX));
        let (work, rx) = mpsc::channel(1);
        let (renew, renew_rx) = watch::channel(deadline.min(hard_deadline));
        let (closed_tx, closed) = watch::channel(None);
        let raw = serde_json::to_value(&command.command).unwrap();
        let external_account = raw.get("externalAccount").cloned();
        if external_account.is_some()
            && (raw.get("authState").is_some()
                || raw.get("identitySeed").is_some()
                || raw.get("externalCookies").is_none()
                || hard_deadline <= process::boot_ms())
        {
            return Err(Fault::rejected(
                "INVALID_EXTERNAL_ACCOUNT",
                "外部账号必须使用独立材料与有效硬期限",
            ));
        }
        if external_account.is_none() && raw.get("externalCookies").is_some() {
            return Err(Fault::rejected(
                "INVALID_EXTERNAL_ACCOUNT",
                "外部 Cookie 缺少租约绑定",
            ));
        }
        if raw.get("identitySeed").is_some() {
            return Err(Fault::rejected(
                "LOCAL_IDENTITY_REMOVED",
                "本地身份种子已移除",
            ));
        }
        if raw.get("authState").is_some() {
            return Err(Fault::rejected(
                "AUTH_RESTORE_RETIRED",
                "会话不再接受持久身份槽位",
            ));
        }
        let session = Arc::new(Session {
            lease_id,
            fence,
            control: std::sync::Mutex::new(crate::control::Control::default()),
            deadline: AtomicU64::new(deadline.min(hard_deadline)),
            hard_deadline,
            identity_seed: if external_account.is_some() {
                Some(json!({"cookies":raw["externalCookies"]}))
            } else {
                None
            },
            external_account,
            reduced_motion: raw
                .get("reducedMotion")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            network_evidence,
            live_view,
            cancel: CancellationToken::new(),
            close_reason: std::sync::Mutex::new(None),
            work,
            renew,
            closed,
            busy: Arc::new(Semaphore::new(1)),
            stream_busy: Arc::new(Semaphore::new(1)),
        });
        // 在同一锁范围内预留容量并发布取消句柄；耗时的浏览器启动在锁外进行。
        let creation = self.admission.creation.lock().await;
        let mut entries = self.entries.lock().await;
        if self.stopping.is_cancelled() {
            return Err(Fault::rejected("NODE_STOPPING", "node is draining"));
        }
        let status = self.admission.status(
            &self.config,
            &self
                .store
                .all_sessions()
                .await
                .map_err(|e| Fault::rejected("STORE_FAILED", e.to_string()))?,
        );
        if !status.accepting {
            return Err(Fault::rejected("RESOURCE_UNAVAILABLE", status.reason));
        }
        self.store.reserve(record.clone()).await.map_err(|e| {
            let code = match e.downcast_ref::<crate::store::AdmissionError>() {
                Some(crate::store::AdmissionError::SessionExists) => "SESSION_EXISTS",
                Some(crate::store::AdmissionError::BindingStopped) => "RESOURCE_UNAVAILABLE",
                _ => "STORE_FAILED",
            };
            Fault::rejected(code, e.to_string())
        })?;
        self.admission.accepted();
        entries.insert(id, session.clone());
        drop(entries);
        drop(creation);
        let (opened_tx, opened) = oneshot::channel();
        let config = self.config.clone();
        let store = self.store.clone();
        tokio::spawn(async move {
            supervise(
                config,
                store,
                record,
                session,
                SupervisorChannels {
                    work: rx,
                    renew: renew_rx,
                    closed: closed_tx,
                    opened: opened_tx,
                },
                command_deadline,
            )
            .await;
        });
        opened
            .await
            .map_err(|_| Fault::unknown("SESSION_START_FAILED", "session supervisor stopped"))?
    }
    /// 先关闭准入，再撤销现存会话并等待全部关闭结果。
    pub async fn shutdown(&self) {
        // 先关闭准入再获取会话快照，也覆盖仍在等待 SQLite 的打开请求。
        self.stopping.cancel();
        let sessions: Vec<_> = self.entries.lock().await.values().cloned().collect();
        for session in &sessions {
            session.request_close("NODE_SHUTDOWN");
        }
        for session in sessions {
            let _ = session.close().await;
        }
    }
    /// 仅移除已确认 CLOSED 的内存句柄；隔离会话继续占用记录容量。
    pub async fn reap(&self) {
        self.entries
            .lock()
            .await
            .retain(|_, s| !matches!(&*s.closed.borrow(), Some(Ok(()))));
    }
}
/// 主服务与受 systemd 监管的 session-host 之间的有界 JSONL 管道。
struct HostIo {
    /// 下发初始化、操作、续租和关闭消息。
    input: ChildStdin,
    /// 读取 host 的就绪与操作结果消息。
    output: FramedRead<BufReader<ChildStdout>, LinesCodec>,
    /// systemd-run 包装进程；其退出不等于浏览器已关闭。
    child: Child,
}
/// 单会话监管任务独占的通信端点。
struct SupervisorChannels {
    /// 由 Node 派发的浏览器操作。
    work: mpsc::Receiver<Work>,
    /// 租约截止时间变化。
    renew: watch::Receiver<u64>,
    /// 会话最终物理关闭的核实结果。
    closed: watch::Sender<Option<std::result::Result<(), String>>>,
    /// 一次性返回会话启动结果。
    opened: oneshot::Sender<Result<Value>>,
}
impl HostIo {
    /// 写入单条 JSONL 消息，避免 shell 与任意 CLI 参数透传。
    async fn send(&mut self, message: host::Input) -> anyhow::Result<()> {
        let mut data = serde_json::to_vec(&message)?;
        data.push(b'\n');
        self.input.write_all(&data).await?;
        self.input.flush().await?;
        Ok(())
    }
    /// 读取并解析一条有最大长度限制的 host 消息。
    async fn receive(&mut self) -> anyhow::Result<Value> {
        Ok(serde_json::from_str(
            &self.output.next().await.context("host EOF")??,
        )?)
    }
}
/// 启动 host，核实 systemd 身份并持久记录 cgroup 后才初始化引擎。
async fn start(
    config: &NodeConfig,
    store: &Store,
    record: &mut SessionRecord,
    startup_deadline: u64,
    max_ms: Option<u64>,
    session: &Session,
    renew: &mut watch::Receiver<u64>,
) -> anyhow::Result<(HostIo, Value)> {
    let directory = config.home.join("sessions").join(&record.launch_id);
    std::fs::create_dir_all(&directory)?;
    let mut child = process::launch(record, &directory, max_ms).await?;
    let input = child.stdin.take().unwrap();
    let output = FramedRead::new(
        BufReader::new(child.stdout.take().unwrap()),
        LinesCodec::new_with_max_length(process::OUTPUT_LIMIT),
    );
    let stderr = child.stderr.take().unwrap();
    tokio::spawn(async move {
        let _ = process::bounded_read(stderr, HOST_STDERR_LIMIT).await;
    });
    let mut host = HostIo {
        input,
        output,
        child,
    };
    let ready = host.receive().await?;
    anyhow::ensure!(ready["type"] == "host.ready", "invalid host greeting");
    process::identify(record).await?;
    store.save_session(record.clone()).await?;
    let seed_path = if let Some(seed) = &session.identity_seed {
        let path = directory.join("identity-seed.json");
        crate::auth::private_write(&path, &serde_json::to_vec(seed)?)?;
        Some(path)
    } else {
        None
    };
    host.send(host::Input::Init {
        config: EngineConfig {
            binary: config.agent_browser_bin.clone(),
            chrome: config.chrome_bin.clone(),
            reduced_motion: session.reduced_motion,
            external_account: session.external_account.clone(),
            identity_seed_file: seed_path,
            full_profile: false,
            node_template: false,
            template_state: None,
            base_profile_directory: None,
            session: record.launch_id.clone(),
            directory,
            allow_unverified_writes: config.allow_unverified_writes,
            diagnostic_snapshots: config.diagnostic_snapshots,
            auth_state: None,
            restore_auth: false,
            restore_auth_if_present: false,
            auth_snapshot_id: None,
            network_evidence: session.network_evidence,
            live_view: session.live_view,
        },
        deadline_ms: session.deadline.load(Ordering::SeqCst),
        startup_deadline_ms: startup_deadline,
    })
    .await?;
    // host 初始化同样受短租约监管，等待打开结果时必须持续转发已接受的续租。
    let opened = loop {
        tokio::select! {
            changed = renew.changed() => {
                changed.context("startup renewal channel closed")?;
                send_renewal(&mut host, session).await?;
            },
            result = host.receive() => break result?,
        }
    };
    anyhow::ensure!(opened["type"] == "host.opened", "invalid open response");
    let result: Result<Value> = serde_json::from_value(opened["result"].clone())?;
    let mut data = result?;
    data["environmentProof"]["sessionId"] = json!(record.session_id);
    Ok((host, data["environmentProof"].clone()))
}
/// 统一管理启动、命令执行、租约到期与关闭确认的会话生命周期。
async fn supervise(
    config: Arc<NodeConfig>,
    store: Store,
    mut record: SessionRecord,
    session: Arc<Session>,
    channels: SupervisorChannels,
    command_deadline: u64,
) {
    let SupervisorChannels {
        mut work,
        mut renew,
        closed,
        opened,
    } = channels;
    let startup_deadline = command_deadline.min(process::boot_ms() + HOST_STARTUP_LIMIT_MS);
    // 单独订阅，外层看门狗与内层 host 转发都必须收到每次续租，不能互相消费通知。
    let startup = startup::wait(
        start(
            &config,
            &store,
            &mut record,
            startup_deadline,
            (session.hard_deadline != u64::MAX)
                .then(|| session.hard_deadline.saturating_sub(process::boot_ms())),
            &session,
            &mut renew,
        ),
        session.renew.subscribe(),
        &session.cancel,
        startup_deadline,
    )
    .await;
    let mut host = match startup {
        Ok((host, proof)) => {
            record.state = "ACTIVE".into();
            if let Err(error) = store.save_session(record.clone()).await {
                session.request_close("SESSION_OPERATION_FAILED");
                let _ = opened.send(Err(Fault::unknown("STORE_FAILED", error.to_string())));
            } else {
                let _ = opened.send(Ok(json!({"sessionId":record.session_id,"state":"ACTIVE","environmentProof":proof})));
            }
            Some(host)
        }
        Err(error) => {
            // host 与主服务任一看门狗先到期，都保留同一个可诊断原因。
            let mut fault = error
                .downcast_ref::<Fault>()
                .cloned()
                .unwrap_or_else(|| Fault::unknown("SESSION_START_FAILED", error.to_string()));
            if fault.code == "DEADLINE_EXCEEDED" {
                fault.code = if session.deadline.load(Ordering::SeqCst) <= process::boot_ms() {
                    "SESSION_LEASE_EXPIRED"
                } else if startup_deadline <= process::boot_ms() {
                    "SESSION_START_TIMEOUT"
                } else {
                    "DEADLINE_EXCEEDED"
                }
                .into();
            }
            let reason = match fault.code.as_str() {
                "SESSION_LEASE_EXPIRED" => "SESSION_LEASE_EXPIRED",
                "SESSION_START_TIMEOUT" => "SESSION_START_TIMEOUT",
                _ => "SESSION_START_FAILED",
            };
            session.request_close(reason);
            let _ = opened.send(Err(fault));
            None
        }
    };
    let close_reason = if let Some(io) = host.as_mut() {
        let mut health = tokio::time::interval(HOST_HEALTH_INTERVAL);
        loop {
            let deadline = session.deadline.load(Ordering::SeqCst);
            tokio::select! {
                _ = session.cancel.cancelled() => break session.close_reason.lock().unwrap().unwrap_or("UNKNOWN"),
                _ = tokio::time::sleep(Duration::from_millis(deadline.saturating_sub(process::boot_ms()))) => break "SESSION_LEASE_EXPIRED",
                _ = health.tick() => {
                    if !matches!(io.child.try_wait(), Ok(None)) { break "HOST_EXITED"; }
                },
                changed = renew.changed() => {
                    if changed.is_err() { break "HOST_CHANNEL_CLOSED"; }
                    if send_renewal(io, &session).await.is_err() { break "HOST_CHANNEL_CLOSED"; }
                },
                message = work.recv() => {
                    let Some(message) = message else { break "HOST_CHANNEL_CLOSED" };
                    let read_only_observation = matches!(&message.command, BrowserCommand::BrowserObserve { .. });
                    let result = run_operation(io, &session, &mut renew, message.command, message.deadline_ms).await;
                    // 与 host 使用同一白名单；仅采集失败不能提前回收仍可用的会话。
                    let failure = result.as_ref().err()
                        .filter(|fault| fault.requires_session_close(read_only_observation))
                        .map(|fault| operation_close_reason(&fault.code, session.deadline.load(Ordering::SeqCst) <= message.deadline_ms && session.deadline.load(Ordering::SeqCst) <= process::boot_ms()));
                    let _ = message.result.send(result);
                    if let Some(reason) = failure { break reason; }
                }
            }
        }
    } else {
        session
            .close_reason
            .lock()
            .unwrap()
            .unwrap_or("SESSION_START_FAILED")
    };
    let close_reason = *session
        .close_reason
        .lock()
        .unwrap()
        .get_or_insert(close_reason);
    record
        .close_reason
        .get_or_insert_with(|| close_reason.to_owned());
    tracing::info!(session_id = %record.session_id, close_reason, "session closing");
    // 任何退出路径都先撤销执行权限，再尝试通过 systemd 关闭整组后代。
    session.cancel.cancel();
    record.state = "CLOSING".into();
    let _ = store.save_session(record.clone()).await;
    if let Some(io) = host.as_mut() {
        let _ = tokio::time::timeout(HOST_CLOSE_NOTIFY_TIMEOUT, io.send(host::Input::Close)).await;
    }
    // 管道故障或 CLI 退出不足以证明浏览器关闭，以 systemd 进程范围为准。
    if record.cgroup.is_none() {
        let _ = process::identify(&mut record).await;
        let _ = store.save_session(record.clone()).await;
    }
    let closure = process::close(&record).await;
    record.state = if closure.is_ok() {
        "CLOSED"
    } else {
        "QUARANTINED"
    }
    .into();
    let persisted = store.save_session(record.clone()).await;
    let final_result = closure.and(persisted).map_err(|error| error.to_string());
    if let Err(error) = &final_result {
        tracing::error!(session_id = %record.session_id, error, "session closure unverified");
    }
    if final_result.is_ok() && cleanup_private_session(&config, &record).is_err() {
        tracing::error!(session_id = %record.session_id, "私密会话清理失败");
    }
    if let Some(mut io) = host
        && tokio::time::timeout(HOST_EXIT_TIMEOUT, io.child.wait())
            .await
            .is_err()
    {
        let _ = io.child.kill().await;
        let _ = io.child.wait().await;
    }
    closed.send_replace(Some(final_result));
}

/// 将主服务已接受的租约期限同步给 host 的独立计时器。
async fn send_renewal(io: &mut HostIo, session: &Session) -> anyhow::Result<()> {
    io.send(host::Input::Renew {
        deadline_ms: session.deadline.load(Ordering::SeqCst),
    })
    .await
}

/// 一边等待 host 结果，一边响应关闭、续租和两个独立截止时间。
async fn run_operation(
    io: &mut HostIo,
    session: &Session,
    renew: &mut watch::Receiver<u64>,
    command: BrowserCommand,
    deadline_ms: u64,
) -> Result<Value> {
    let timeout_ms = deadline_ms.saturating_sub(process::boot_ms());
    if timeout_ms == 0 {
        return Err(Fault::rejected(
            "DEADLINE_EXCEEDED",
            "command expired before dispatch",
        ));
    }
    session.authorize(&session.lease_id, session.fence)?;
    io.send(host::Input::Run {
        command,
        timeout_ms,
    })
    .await
    .map_err(|_| Fault::unknown("HOST_IO", "could not dispatch to host"))?;
    loop {
        let deadline = deadline_ms.min(session.deadline.load(Ordering::SeqCst));
        tokio::select! {
            _ = session.cancel.cancelled() => return Err(Fault::unknown("CANCELLED", "session cancelled")),
            _ = tokio::time::sleep(Duration::from_millis(deadline.saturating_sub(process::boot_ms()))) => {
                return Err(Fault::unknown("DEADLINE_EXCEEDED", "command or lease deadline expired"));
            },
            changed = renew.changed() => {
                if changed.is_err() { return Err(Fault::unknown("HOST_IO", "renewal channel closed")); }
                send_renewal(io, session).await.map_err(|_| Fault::unknown("HOST_IO", "renewal delivery failed"))?;
            },
            response = io.receive() => return match response {
                Ok(value) if value["type"] == "host.result" => serde_json::from_value(value["result"].clone())
                    .unwrap_or_else(|_| Err(Fault::unknown("HOST_PROTOCOL", "invalid response"))),
                _ => Err(Fault::unknown("HOST_IO", "host exited without a result")),
            }
        }
    }
}

/// 操作进行中也保留租约、命令期限和监管通信的区别，不依赖错误文案。
fn operation_close_reason(code: &str, lease_expired_first: bool) -> &'static str {
    match code {
        "HOST_IO" | "HOST_PROTOCOL" => "HOST_CHANNEL_CLOSED",
        "DEADLINE_EXCEEDED" if lease_expired_first => "SESSION_LEASE_EXPIRED",
        "DEADLINE_EXCEEDED" => "SESSION_COMMAND_TIMEOUT",
        _ => "SESSION_OPERATION_FAILED",
    }
}

#[cfg(test)]
mod close_reason_tests {
    // 范围：只验证操作失败时的原因选择；不启动 host，也不替代 Linux 租约验收。
    #[test]
    fn running_operation_distinguishes_lease_command_and_channel_failure() {
        use super::operation_close_reason;
        assert_eq!(
            operation_close_reason("DEADLINE_EXCEEDED", true),
            "SESSION_LEASE_EXPIRED"
        );
        assert_eq!(
            operation_close_reason("DEADLINE_EXCEEDED", false),
            "SESSION_COMMAND_TIMEOUT"
        );
        assert_eq!(
            operation_close_reason("HOST_IO", false),
            "HOST_CHANNEL_CLOSED"
        );
        assert_eq!(
            operation_close_reason("DOM_ENGINE_FAILED", false),
            "SESSION_OPERATION_FAILED"
        );
    }
}

/// 仅在确认进程停止后清理私密材料，保留证据和去重账本。
pub fn cleanup_private_session(config: &NodeConfig, record: &SessionRecord) -> anyhow::Result<()> {
    anyhow::ensure!(
        record.launch_id.len() == 32 && record.launch_id.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid launch identity"
    );
    let directory = crate::artifacts::session_directory(config, &record.launch_id);
    if let Ok(info) = std::fs::symlink_metadata(&directory) {
        anyhow::ensure!(
            info.is_dir() && !info.file_type().is_symlink(),
            "invalid session directory"
        );
    }
    for path in [
        directory.join("profile"),
        directory.join("home"),
        crate::engine::socket_directory(&record.launch_id),
    ] {
        match std::fs::remove_dir_all(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    match std::fs::remove_file(directory.join("identity-seed.json")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod external_tests {
    use super::*;
    /// 范围：真实 Session 续租不能越过外部账号硬期限；不启动浏览器或验证 systemd。
    #[test]
    fn renewal_never_extends_external_deadline() {
        let now = process::boot_ms();
        let (work, _) = mpsc::channel(1);
        let (renew, _) = watch::channel(now + 1_000);
        let (_, closed) = watch::channel(None);
        let session = Session {
            lease_id: "fixture".into(),
            fence: 1,
            control: std::sync::Mutex::new(crate::control::Control::default()),
            deadline: AtomicU64::new(now + 1_000),
            hard_deadline: now + 10_000,
            identity_seed: None,
            external_account: Some(json!({"leaseId":"fixture"})),
            network_evidence: false,
            live_view: true,
            reduced_motion: true,
            cancel: CancellationToken::new(),
            close_reason: std::sync::Mutex::new(None),
            work,
            renew,
            closed,
            busy: Arc::new(Semaphore::new(1)),
            stream_busy: Arc::new(Semaphore::new(1)),
        };
        session.renew(now + 100_000).unwrap();
        assert_eq!(session.deadline.load(Ordering::SeqCst), now + 10_000);
        session.renew(now + 500_000).unwrap();
        assert_eq!(session.deadline.load(Ordering::SeqCst), now + 10_000);
        session.cancel.cancel();
        assert!(session.renew(now + 500_000).is_err());
    }
}
