//! 单进程多控制面运行时：共享资源与直连入口，独立维护各绑定的网关与投递。
use crate::{
    admission::Admission, artifacts, bindings, config::NodeConfig, gateway, node::Node,
    store::Store,
};
use anyhow::Result;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};
use tokio::{sync::RwLock, task::JoinSet};
use tokio_util::sync::CancellationToken;

/// 本地授权状态轮询上限；命令与媒体还会在自身授权边界读取持久撤销状态。
const REFRESH_INTERVAL: Duration = Duration::from_millis(500);
#[derive(Default)]
/// 所有绑定共用的资源边界；不包含任何控制面凭据或会话控制权。
pub struct Resources {
    /// CPU、内存采样和创建预留锁。
    pub admission: Arc<Admission>,
    /// 所有绑定共享 spool 的额度检查与落盘锁。
    pub artifacts: Arc<tokio::sync::Mutex<()>>,
}
/// 单个入口根据握手中的节点身份选择固定绑定，不跨绑定扫描授权凭据。
pub type Nodes = Arc<RwLock<BTreeMap<String, Arc<Node>>>>;

/// 注册表的唯一进程内管理者；已有网关与本地注册表刷新独立运行。
struct Runtime {
    /// 机器级配置不随远端消息改变。
    config: NodeConfig,
    /// 所有绑定共享一个数据库工作线程。
    store: Store,
    /// 统一资源预留与证据额度。
    resources: Arc<Resources>,
    /// 供客户端直连路由使用的活跃上下文。
    nodes: Nodes,
    /// 每个绑定独立取消，不能用一个 API 的断线取消整个节点。
    handles: BTreeMap<String, CancellationToken>,
    /// 记录已恢复过的绑定，包括已撤销身份，避免重复恢复。
    loaded: BTreeSet<String>,
    /// 持有全部网关任务，退出时等待会话清理。
    workers: JoinSet<Result<()>>,
    /// 进程关闭信号，由系统信号或监听失败触发。
    stop: CancellationToken,
}
impl Runtime {
    /// 只有完整恢复后才公布上下文和建立连接。
    async fn connect(&mut self, node: Arc<Node>) {
        if self.stop.is_cancelled() {
            return;
        }
        self.nodes
            .write()
            .await
            .insert(node.id.clone(), node.clone());
        let cancel = self.stop.child_token();
        self.handles.insert(node.id.clone(), cancel.clone());
        self.workers
            .spawn(async move { gateway::serve(node, cancel).await });
    }
    /// 先撤权，再恢复所有新增范围；首次启动不允许某绑定抢在其他旧会话恢复前接单。
    async fn refresh(&mut self) -> Result<()> {
        let bindings = bindings::list(&self.store).await?;
        for (binding, state) in &bindings {
            if state == "REVOKED" {
                if let Some(cancel) = self.handles.remove(&binding.id) {
                    cancel.cancel();
                }
                self.nodes.write().await.remove(&binding.id);
            }
        }
        let mut prepared = Vec::new();
        for (binding, _) in bindings {
            if self.loaded.insert(binding.id.clone()) {
                // 已撤销范围也必须恢复遗留进程，但不建立控制面连接或上传证据。
                let node = Node::start_context(
                    binding.config(&self.config),
                    self.store.scoped(&binding.scope),
                    binding.id.clone(),
                    None,
                    Some(binding),
                    self.resources.clone(),
                )
                .await?;
                prepared.push(node);
            }
        }
        for node in prepared {
            // 恢复期间可能有本地撤销操作，不能使用恢复前的注册表快照。
            if node.store.binding_state().await? != "REVOKED" {
                self.connect(node).await;
            }
        }
        Ok(())
    }
    /// 单绑定断线由各自网关重试，注册表只负责授权状态与进程生命周期。
    async fn run(&mut self) -> Result<()> {
        let initial = bindings::list(&self.store).await?;
        // 注册表一旦启用，撤销全部绑定也不会回退读取旧凭据文件。
        if initial.is_empty() && self.config.credential_file.exists() {
            let id = artifacts::installation_id(&self.config.home)?;
            let node = Node::start_context(
                self.config.clone(),
                self.store.clone(),
                id,
                None,
                None,
                self.resources.clone(),
            )
            .await?;
            self.connect(node).await;
        }
        let mut tick = tokio::time::interval(REFRESH_INTERVAL);
        loop {
            tokio::select! {
                _ = self.stop.cancelled() => return Ok(()),
                done = self.workers.join_next(), if !self.workers.is_empty() => {
                    if let Some(result) = done { result??; }
                },
                _ = tick.tick() => self.refresh().await?,
            }
        }
    }
}
/// 只负责进程生命周期；任务排队始终留在各控制面。
pub async fn serve(mut config: NodeConfig, stop: CancellationToken) -> Result<()> {
    anyhow::ensure!(cfg!(target_os = "linux"), "serve requires Linux/systemd");
    config.prepare()?;
    let _lock = artifacts::lock_home(&config.home)?;
    let store = Store::open(&config.home.join("node.db"))?;
    let nodes: Nodes = Arc::new(RwLock::new(BTreeMap::new()));
    let mut direct = None;
    // 先占有直连监听，再开放任何会话；绑定新增不会重新绑定端口。
    if config.public_url.is_some() {
        let listener = tokio::net::TcpListener::bind(&config.listen).await?;
        let nodes = nodes.clone();
        let cancel = stop.clone();
        direct = Some(tokio::spawn(async move {
            let result = crate::direct::serve_nodes(nodes, listener, cancel.clone()).await;
            if result.is_err() {
                cancel.cancel();
            }
            result
        }));
    }
    let mut runtime = Runtime {
        config,
        store,
        resources: Arc::new(Resources::default()),
        nodes,
        handles: BTreeMap::new(),
        loaded: BTreeSet::new(),
        workers: JoinSet::new(),
        stop: stop.clone(),
    };
    let mut result = runtime.run().await;
    stop.cancel();
    // 即便新增绑定恢复失败，已有会话和直连也必须完成收尾。
    while let Some(done) = runtime.workers.join_next().await {
        let completed = done.map_err(anyhow::Error::from).and_then(|r| r);
        if result.is_ok() {
            result = completed;
        }
    }
    if let Some(direct) = direct {
        direct.await??;
    }
    result
}
