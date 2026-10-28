//! 固定版本的 agent-browser CLI 适配器。引擎 ref 仅在当前观察中有效；
//! CLI 结果不确定时结束该会话，避免后续动作与潜在副作用并发。
mod cookies;
mod dom;
mod drag;
mod external_account;
#[cfg(test)]
mod motion_tests;
mod profile;
mod scroll;
mod visual;

// 故障引擎适配仅存在于显式测试构建，发布二进制不含 AX 回退路径。
#[cfg(feature = "protocol-fixtures")]
#[path = "../../../../tests/browser-node/engine_fixture.rs"]
mod fixture;
mod scopes;
use crate::{
    error::{Fault, Result},
    process,
    protocol::{ActBrowserAction, BrowserCommand},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};
use tokio::{process::Command, time::Duration};

/// 已验证适配器命令格式的 agent-browser 版本；启动时拒绝不匹配版本。
pub const PINNED_AGENT_BROWSER_VERSION: &str = "0.38.1";
/// CLI 配置内单次引擎调用的默认超时，单位毫秒；外层命令期限仍优先。
const DEFAULT_ENGINE_TIMEOUT_MS: u64 = 8_000;
/// 条件等待分段返回，错误的预期文案不能占满整条命令并触发控制面撤权。
const CONDITION_WAIT_MS: u64 = 5_000;
/// 为 host、节点和控制面交付明确回执预留时间；不延长调用方冻结的命令期限。
const CONDITION_REPLY_RESERVE_MS: u64 = 1_000;
/// 与流服务的初始视口一致；显式设置才能让 Chromium 实际尺寸和流元数据同步。
const LIVE_VIEW_WIDTH: u32 = 1280;
const LIVE_VIEW_HEIGHT: u32 = 720;
/// 原始语义快照作为诊断证据保留的字符上限，不额外占用模型动作候选。
const REFERENCE_SNAPSHOT_CHARS: usize = 20_000;
/// 固定版本引擎完成导航请求但等待 load 事件超时的原始消息。
const ENGINE_TIMEOUT: &str =
    "Operation timed out. The page may still be loading or the element may not exist.";
/// 导航超时后只读核实文档，不能重发导航或接受调用方提供的脚本。
const NAVIGATION_PROBE: &str = "({url:location.href,readyState:document.readyState})";
/// 固定读取主视口，截图和点击使用相同 CSS 坐标，不接收模型提供的脚本。
const VISUAL_VIEWPORT: &str =
    "({url:location.href,width:innerWidth,height:innerHeight,x:scrollX,y:scrollY})";

/// 固定只读媒体查询，不接收任务或模型提供的可执行代码。
const MOTION_QUERY: &str = "matchMedia('(prefers-reduced-motion: reduce)').matches";

/// 旧调用方未传偏好时，新建浏览器同样采用减少动画。
fn default_reduced_motion() -> bool {
    true
}

/// 单个 session-host 的引擎启动参数，不携带节点机器凭据。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EngineConfig {
    /// 默认模板存储仅由节点构造，公共协议不能指定磁盘路径。
    #[serde(default)]
    pub default_profile_root: Option<PathBuf>,
    /// 仅维护会话具有发布权，普通任务只能读取模板。
    #[serde(default)]
    pub profile_maintenance: bool,
    /// 发布回执绑定控制面的原会话身份。
    #[serde(default)]
    pub profile_owner: String,
    /// 固定版本 CLI 的绝对路径。
    pub binary: PathBuf,
    /// 可选的 Chrome 绝对路径。
    pub chrome: Option<PathBuf>,
    /// 默认减少动画；显式关闭也覆盖宿主偏好，避免动画验收受机器配置影响。
    #[serde(default = "default_reduced_motion")]
    pub reduced_motion: bool,
    /// 秘密种子只存会话私有文件，注入后删除。
    #[serde(default)]
    pub identity_seed_file: Option<PathBuf>,
    /// 外部账号仅允许在本次隔离会话使用，禁止持久身份保存。
    #[serde(default)]
    pub external_account: Option<Value>,
    /// 仅解码旧 host 配置以明确拒绝持久状态恢复，不参与新会话。
    #[serde(default)]
    pub full_profile: bool,
    /// 仅解码旧 host 配置以明确拒绝持久状态恢复，不参与新会话。
    #[serde(default)]
    pub node_template: bool,
    /// 仅解码旧 host 配置以明确拒绝持久状态恢复，不参与新会话。
    #[serde(default)]
    pub template_state: Option<PathBuf>,
    /// 仅解码旧 host 配置以明确拒绝持久状态恢复，不参与新会话。
    #[serde(default)]
    pub base_profile_directory: Option<PathBuf>,
    /// 随本次会话生成的引擎 session 名，隔离 daemon 和 socket。
    pub session: String,
    /// profile、配置及临时截图的私有目录。
    pub directory: PathBuf,
    /// 开发测试写动作开关，不代表生产写入语义已验证。
    pub allow_unverified_writes: bool,
    /// 附加语义诊断不生成动作身份，默认不采集。
    #[serde(default)]
    pub diagnostic_snapshots: bool,
    /// 仅解码旧 host 配置以明确拒绝持久状态恢复，不参与新会话。
    #[serde(default)]
    pub auth_state: Option<PathBuf>,
    /// 仅解码旧 host 配置以明确拒绝持久状态恢复，不参与新会话。
    #[serde(default)]
    pub restore_auth: bool,
    /// 仅解码旧 host 配置以明确拒绝持久状态恢复，不参与新会话。
    #[serde(default)]
    pub restore_auth_if_present: bool,
    /// 仅解码旧 host 配置以明确拒绝持久状态恢复，不参与新会话。
    #[serde(default)]
    pub auth_snapshot_id: Option<String>,
    /// 只有要求网络证据的任务才打开请求跟踪。
    #[serde(default)]
    pub network_evidence: bool,
    /// 仅允许人工介入的任务开启本机画面服务，端口不对外发布。
    #[serde(default)]
    pub live_view: bool,
}
/// 一场浏览器会话的 CLI 适配器和最近一次观察的临时目标映射。
pub struct Engine {
    /// 本会话复制的版本，缺省表示节点尚未初始化模板。
    template_version: Option<crate::profiles::ProfileVersion>,
    /// 每个 setup 分组独占一个标签页，数据仍属于同一 profile。
    scopes: HashMap<String, scopes::TabState>,
    /// 网络连接按真实 target 隔离，独立于每次观察重建的 DOM 连接。
    networks: HashMap<String, dom::Dom>,
    /// 当前引擎 CLI 所在分组；切换和操作共享同一串行队列。
    active_scope: Option<String>,
    /// CLI、Chrome 和会话目录配置。
    config: EngineConfig,
    /// 当前有效观察身份；执行动作后清空。
    observation: Option<String>,
    /// 聚焦失败可改变页面，必须完成新观察才能再次写入；绝不自动重放按键。
    focus_recovery_pending: bool,
    /// 平台 target 到引擎短期 ref 的映射，不能作为公共协议暴露。
    targets: HashMap<String, String>,
    /// 原生 DOM 观察与实际节点引用，仅属于当前观察。
    dom: Option<dom::Dom>,
    /// Trace 使用独立连接，观察刷新不能中断采集。
    trace: Option<dom::Dom>,
    /// 最近截图的视口身份和采集时间，视觉输入必须匹配。
    visual: Option<visual::VisualObservation>,
    /// 只有当前观察列出的标签页才能切换或关闭。
    tabs: Vec<String>,
    /// 可选 iframe 观察范围；导航后恢复整个页面。
    frame: Option<String>,
}
impl Engine {
    /// 建立隔离目录并写入固定的 agent-browser 配置。
    pub fn new(config: EngineConfig) -> anyhow::Result<Self> {
        if (config.default_profile_root.is_some() && config.external_account.is_some())
            || (config.profile_maintenance
                && (config.default_profile_root.is_none() || config.profile_owner.is_empty()))
            || config.auth_state.is_some()
            || config.restore_auth
            || config.restore_auth_if_present
            || config.auth_snapshot_id.is_some()
            || config.full_profile
            || config.node_template
            || config.base_profile_directory.is_some()
            || config.template_state.is_some()
        {
            anyhow::bail!("浏览器会话不再恢复或发布本地身份基准");
        }
        std::fs::create_dir_all(config.directory.join("home"))?;
        std::fs::create_dir_all(config.directory.join("artifacts"))?;
        let socket = socket_directory(&config.session);
        std::fs::create_dir_all(&socket)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                socket.parent().unwrap(),
                std::fs::Permissions::from_mode(0o700),
            )?;
        }
        let mut options = json!({"headless":true,"noWebmcp":true,"idleTimeout":"0","defaultTimeout":DEFAULT_ENGINE_TIMEOUT_MS});
        if let Some(chrome) = &config.chrome {
            options["executablePath"] = json!(chrome);
        }
        // 使用进程级偏好覆盖首次导航、profile 分组、新标签页和弹出页。
        // 不通过页面脚本屏蔽资源，也不强制禁用 WebGL。
        options["args"] = json!(if config.reduced_motion {
            "--force-prefers-reduced-motion"
        } else {
            "--force-prefers-no-reduced-motion"
        });
        options["profile"] = json!(config.directory.join("profile"));
        std::fs::write(
            config.directory.join("agent-browser.json"),
            serde_json::to_vec(&options)?,
        )?;
        Ok(Self {
            template_version: None,
            scopes: HashMap::new(),
            networks: HashMap::new(),
            active_scope: None,
            config,
            observation: None,
            focus_recovery_pending: false,
            targets: HashMap::new(),
            dom: None,
            trace: None,
            visual: None,
            tabs: Vec::new(),
            frame: None,
        })
    }
    /// 用固定 argv 调用原生 CLI；缺失、超时或无效响应均按效果未知处理。
    async fn cli(&self, args: Vec<String>, timeout_ms: u64) -> Result<Value> {
        let mut cmd = Command::new(&self.config.binary);
        cmd.env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", self.config.directory.join("home"))
            .env(
                "AGENT_BROWSER_SOCKET_DIR",
                socket_directory(&self.config.session),
            )
            .current_dir(&self.config.directory)
            .arg("--config")
            .arg(self.config.directory.join("agent-browser.json"))
            .args(["--session", &self.config.session, "--json"])
            .args(&args);
        let (success, out, _) = process::capture(cmd, Duration::from_millis(timeout_ms.max(1)))
            .await
            .map_err(|error| Fault::unknown("ENGINE_IO", error.to_string()))?;
        let value: Value = serde_json::from_slice(&out).map_err(|_| {
            Fault::unknown("ENGINE_PROTOCOL", "invalid or oversized engine response")
        })?;
        if !success || value.get("success") != Some(&Value::Bool(true)) {
            return Err(engine_failure(&args, &value));
        }
        Ok(value.get("data").cloned().unwrap_or(Value::Null))
    }
    /// 创建本会话独立浏览器，并打开内部空白页作为初始状态。
    pub async fn open(&mut self, timeout_ms: u64) -> Result<Value> {
        let deadline = process::boot_ms() + timeout_ms;
        self.restore_default_profile(deadline).await?;
        self.cli(
            vec!["open".into(), "about:blank".into()],
            deadline.saturating_sub(process::boot_ms()),
        )
        .await?;
        self.restore_session_cookies(deadline).await?;
        // 先回读浏览器实际偏好，失败即终止初始化，不把配置意图当作生效证据。
        let motion = self
            .cli(
                vec!["eval".into(), MOTION_QUERY.into()],
                deadline.saturating_sub(process::boot_ms()),
            )
            .await?;
        if motion["result"].as_bool() != Some(self.config.reduced_motion) {
            return Err(Fault::rejected(
                "MOTION_PREFERENCE_MISMATCH",
                "浏览器动画偏好未按配置生效",
            ));
        }
        if self.config.external_account.is_some() {
            self.prepare_external_account(deadline).await?;
        }
        if self.config.network_evidence {
            self.cli(
                vec!["network".into(), "requests".into()],
                deadline.saturating_sub(process::boot_ms()),
            )
            .await?;
        }
        if self.config.live_view {
            // 原生流服务默认报告 1280×720，但新 Chromium 窗口不一定采用该尺寸。
            // 使用引擎的 viewport 命令同时更新浏览器和流服务，避免画面与点击坐标错位。
            self.cli(
                vec![
                    "set".into(),
                    "viewport".into(),
                    LIVE_VIEW_WIDTH.to_string(),
                    LIVE_VIEW_HEIGHT.to_string(),
                ],
                deadline.saturating_sub(process::boot_ms()),
            )
            .await?;
            let status = self
                .cli(
                    vec!["stream".into(), "status".into()],
                    deadline.saturating_sub(process::boot_ms()),
                )
                .await?;
            if status["enabled"] != true {
                self.cli(
                    vec!["stream".into(), "enable".into()],
                    deadline.saturating_sub(process::boot_ms()),
                )
                .await?;
            }
        }
        let mut proof = json!({"authRestored":false,"initialState":"empty","reducedMotion":self.config.reduced_motion});
        if self.config.default_profile_root.is_some() {
            proof["profileSource"] = json!("node-default");
        }
        if let Some(version) = &self.template_version {
            proof["initialState"] = json!("node-default");
            proof["authRestored"] = json!(true);
            proof["profile"] = json!(version);
        }
        if let Some(account) = &self.config.external_account {
            proof["initialState"] = json!("external");
            proof["externalAccount"] = account.clone();
        }
        Ok(json!({"opened":true,"environmentProof":proof}))
    }
    /// 尽力请求引擎关闭；最终资源回收仍以 systemd/cgroup 核实为准。
    pub async fn close(&self) {
        let _ = self.cli(vec!["close".into()], 2000).await;
    }
    /// 将封闭的公共操作映射到固定 CLI 命令，并规范化观察和结果。
    pub async fn execute(&mut self, operation: BrowserCommand, timeout_ms: u64) -> Result<Value> {
        let observe = matches!(operation, BrowserCommand::BrowserObserve { .. });
        if self.focus_recovery_pending && !observe {
            return Err(Fault::rejected(
                "STALE_OBSERVATION",
                "focus changed; fresh observation required",
            ));
        }
        let result = self.execute_inner(operation, timeout_ms).await;
        if observe && result.is_ok() {
            self.focus_recovery_pending = false;
        } else if result
            .as_ref()
            .is_err_and(|error| error.code == "KEYBOARD_FOCUS_UNCONFIRMED")
        {
            self.focus_recovery_pending = true;
        }
        result
    }
    /// 实际命令与观察实现；恢复门禁在外层统一处理。
    async fn execute_inner(&mut self, operation: BrowserCommand, timeout_ms: u64) -> Result<Value> {
        validate(&operation, self.config.allow_unverified_writes)?;
        let deadline = process::boot_ms() + timeout_ms;
        let remaining = || deadline.saturating_sub(process::boot_ms()).max(1);
        let raw = serde_json::to_value(&operation).unwrap();
        if let Some(scope) = raw["tabScope"].as_str() {
            if raw["type"] == "browser.act"
                && raw["action"]
                    .as_str()
                    .is_some_and(|a| a.starts_with("tab."))
            {
                return Err(Fault::rejected(
                    "TAB_SCOPE_FORBIDDEN",
                    "group cannot switch or close another tab",
                ));
            }
            self.activate_scope(scope, remaining()).await?;
        }
        let mut network_target = None;
        if self.config.network_evidence {
            let endpoint = self
                .cli(vec!["get".into(), "cdp-url".into()], remaining())
                .await?;
            if let Some(endpoint) = endpoint["cdpUrl"].as_str() {
                let tabs = self
                    .cli(vec!["tab".into(), "list".into()], remaining())
                    .await?;
                // 已关闭 tab 的连接不再保留；认证状态在同一 profile 内共享。
                self.networks.retain(|id, _| {
                    tabs["tabs"]
                        .as_array()
                        .is_some_and(|items| items.iter().any(|tab| tab["targetId"] == *id))
                });
                let target = tabs["tabs"]
                    .as_array()
                    .and_then(|tabs| tabs.iter().find(|t| t["active"] == true))
                    .and_then(|t| t["targetId"].as_str())
                    .ok_or_else(|| {
                        Fault::rejected("NETWORK_SCOPE_UNAVAILABLE", "active tab unavailable")
                    })?
                    .to_string();
                if !self.networks.contains_key(&target) {
                    let mut capture = dom::Dom::connect(endpoint).await?;
                    capture.network_start(&target).await?;
                    self.networks.insert(target.clone(), capture);
                }
                network_target = Some(target);
            }
        }
        if matches!(
            operation,
            BrowserCommand::BrowserIdentityPrepare { .. }
                | BrowserCommand::BrowserCookiesSet { .. }
                | BrowserCommand::BrowserCookiesClear { .. }
        ) || (matches!(operation, BrowserCommand::BrowserInput { .. })
            && raw["action"] != "scroll")
        {
            // 登录相关输入使所有 tab 的旧身份网络证据失效。后台 tab 可能暂停或卡住，
            // 不能逐个等待它们的 Page.getFrameTree；直接丢弃旁路订阅，切回时重新采集。
            // 活动 tab 保留订阅并排空旧事件，确保本次输入产生的新请求仍可成为后续证据。
            self.networks
                .retain(|target, _| network_target.as_ref() == Some(target));
            for capture in self.networks.values_mut() {
                capture.network_invalidate().await?;
            }
        }
        match operation {
            BrowserCommand::BrowserIdentityPrepare { .. } => Err(Fault::rejected(
                "LOCAL_IDENTITY_REMOVED",
                "本地登录配方已移除，请使用 DevPass 或当前会话人工登录",
            )),
            BrowserCommand::BrowserInput { .. } => {
                self.observation = None;
                self.targets.clear();
                self.dom = None;
                self.visual = None;
                let action = raw["action"].as_str().unwrap();
                if action == "click" || action == "scroll" {
                    self.cli(
                        vec![
                            "mouse".into(),
                            "move".into(),
                            // CLI 坐标只接受整数；缩放后的画面坐标可能是小数。
                            raw["x"].as_f64().unwrap().round().to_string(),
                            raw["y"].as_f64().unwrap().round().to_string(),
                        ],
                        remaining(),
                    )
                    .await?;
                }
                match action {
                    "drag" => {
                        let endpoint = self
                            .cli(vec!["get".into(), "cdp-url".into()], remaining())
                            .await?;
                        let tabs = self
                            .cli(vec!["tab".into(), "list".into()], remaining())
                            .await?;
                        let target = tabs["tabs"]
                            .as_array()
                            .and_then(|tabs| tabs.iter().find(|tab| tab["active"] == true))
                            .and_then(|tab| tab["targetId"].as_str())
                            .ok_or_else(|| Fault::rejected("DRAG_TARGET", "当前标签页不可用"))?;
                        let endpoint = endpoint["cdpUrl"].as_str().ok_or_else(|| {
                            Fault::rejected("DRAG_ENDPOINT", "当前浏览器不支持拖动")
                        })?;
                        let mut dom = dom::Dom::connect(endpoint).await?;
                        dom.drag(
                            target,
                            raw["points"].as_array().unwrap(),
                            Duration::from_millis(remaining()),
                        )
                        .await?;
                    }
                    "click" => {
                        self.cli(
                            vec!["mouse".into(), "down".into(), "left".into()],
                            remaining(),
                        )
                        .await?;
                        self.cli(
                            vec!["mouse".into(), "up".into(), "left".into()],
                            remaining(),
                        )
                        .await?;
                    }
                    "text" => {
                        let text = raw["value"].as_str().unwrap();
                        // 前导短横线按键输入，避免文本被 CLI 解释为全局选项。
                        let rest = text.trim_start_matches('-');
                        for _ in 0..text.len() - rest.len() {
                            self.cli(vec!["press".into(), "-".into()], remaining())
                                .await?;
                        }
                        if !rest.is_empty() {
                            self.cli(
                                vec!["keyboard".into(), "inserttext".into(), rest.into()],
                                remaining(),
                            )
                            .await?;
                        }
                    }
                    "press" => {
                        // 原生引擎以字符生成文本，物理键名 Minus 只触发事件而不插入短横线。
                        let key = raw["value"].as_str().unwrap();
                        self.cli(
                            vec![
                                "press".into(),
                                if key == "Minus" { "-" } else { key }.into(),
                            ],
                            remaining(),
                        )
                        .await?;
                    }
                    "scroll" => {
                        self.cli(
                            vec![
                                "mouse".into(),
                                "wheel".into(),
                                raw["deltaY"].to_string(),
                                raw["deltaX"].to_string(),
                            ],
                            remaining(),
                        )
                        .await?;
                    }
                    _ => unreachable!(),
                }
                Ok(json!({"applied":true}))
            }
            BrowserCommand::BrowserObserve { screenshot, .. } => {
                // DOM、URL、标题和可选截图由多次调用组成，结果明确标记非原子。
                // 验收依赖状态文本等非交互内容，不能只采集按钮与输入框。
                self.dom = None;
                self.visual = None;
                self.observation = None;
                self.targets.clear();
                let url = self
                    .cli(vec!["get".into(), "url".into()], remaining())
                    .await?;
                let title = self
                    .cli(vec!["get".into(), "title".into()], remaining())
                    .await?;
                let id = uuid::Uuid::new_v4().to_string();
                let endpoint = self
                    .cli(vec!["get".into(), "cdp-url".into()], remaining())
                    .await?;
                let mut result = if let Some(endpoint) = endpoint["cdpUrl"].as_str() {
                    let listed = self
                        .cli(vec!["tab".into(), "list".into()], remaining())
                        .await?;
                    let tabs = listed["tabs"].clone();
                    let active = tabs
                        .as_array()
                        .and_then(|tabs| tabs.iter().find(|tab| tab["active"] == true))
                        .and_then(|tab| tab["targetId"].as_str())
                        .ok_or_else(|| {
                            Fault::unknown("DOM_ENGINE_FAILED", "active tab unavailable")
                        })?;
                    let mut dom = dom::Dom::connect(endpoint).await?;
                    let mut native = dom.snapshot(active, self.frame.as_deref()).await?;
                    native["tabs"] = tabs;
                    self.dom = Some(dom);
                    native
                } else {
                    #[cfg(feature = "protocol-fixtures")]
                    {
                        self.fixture_observation(remaining()).await?
                    }
                    #[cfg(not(feature = "protocol-fixtures"))]
                    {
                        return Err(Fault::rejected(
                            "DOM_ENGINE_REQUIRED",
                            "native CDP observation is required",
                        ));
                    }
                };
                result["observationId"] = json!(id);
                result["url"] = url["url"].clone();
                result["title"] = title["title"].clone();
                result["atomic"] = json!(false);
                // 附加诊断失败不能否定已采集的 DOM；也不建立第二套目标映射。
                if self.config.diagnostic_snapshots
                    && remaining() > 1_000
                    && let Ok(snapshot) = self
                        .cli(vec!["snapshot".into()], remaining().min(1_000))
                        .await
                {
                    let text = snapshot["snapshot"].as_str().unwrap_or_default();
                    result["referenceSnapshot"] = json!({"source":"agent-browser",
                            "text":text.chars().take(REFERENCE_SNAPSHOT_CHARS).collect::<String>(),
                            "truncated":text.chars().count()>REFERENCE_SNAPSHOT_CHARS,
                            "refCount":snapshot["refs"].as_object().map_or(0, |refs|refs.len())});
                }
                let mut tabs = result["tabs"].clone();
                if let Some(scope) = &self.active_scope {
                    let owned = &self.scopes[scope].tab_id;
                    tabs = json!(
                        tabs.as_array()
                            .into_iter()
                            .flatten()
                            .filter(|tab| tab["tabId"].as_str() == Some(owned))
                            .cloned()
                            .collect::<Vec<_>>()
                    );
                }
                self.tabs = tabs
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|t| t["tabId"].as_str().map(str::to_owned))
                    .collect();
                self.observation = Some(id.clone());
                result["tabs"] = tabs;
                if let Some(scope) = &self.active_scope {
                    result["tabScope"] = json!(scope);
                }
                if self.config.network_evidence {
                    result["network"] = if let Some(target) = network_target.as_ref() {
                        let mut network = self
                            .networks
                            .get_mut(target)
                            .unwrap()
                            .network_snapshot()
                            .await?;
                        network["tabScope"] = json!(self.active_scope);
                        network
                    } else {
                        #[cfg(feature = "protocol-fixtures")]
                        {
                            self.fixture_network(remaining()).await?
                        }
                        #[cfg(not(feature = "protocol-fixtures"))]
                        {
                            return Err(Fault::rejected(
                                "NETWORK_SCOPE_UNAVAILABLE",
                                "active tab unavailable",
                            ));
                        }
                    };
                }
                if let Some(target) = network_target.as_ref() {
                    let capture = self.networks.get_mut(target).unwrap();
                    let mut runtime = capture.runtime_inspect(target).await.unwrap_or_else(
                        |_| json!({"status":"unavailable","reason":"RUNTIME_READ_FAILED"}),
                    );
                    runtime["console"] = capture.console_snapshot();
                    runtime["tabScope"] = json!(self.active_scope);
                    runtime["version"] = json!(1);
                    result["runtime"] = runtime;
                }
                // 纯文本观察同样声明滚动幅度能力；旧协议夹具继续不声明。
                if self.dom.is_some() && !screenshot.unwrap_or(false) {
                    let viewport = self
                        .cli(vec!["eval".into(), VISUAL_VIEWPORT.into()], remaining())
                        .await?;
                    result["viewport"] = viewport["result"].clone();
                    result["viewport"]["scrollDistance"] = json!(true);
                }
                if screenshot.unwrap_or(false) {
                    let path = self
                        .config
                        .directory
                        .join("artifacts")
                        .join(format!("{}.png", uuid::Uuid::new_v4()));
                    self.cli(
                        vec!["screenshot".into(), path.to_string_lossy().into()],
                        remaining(),
                    )
                    .await?;
                    let viewport = self
                        .cli(vec!["eval".into(), VISUAL_VIEWPORT.into()], remaining())
                        .await?;
                    self.visual = Some(visual::VisualObservation {
                        viewport: viewport["result"].clone(),
                        at: process::boot_ms(),
                        digest: visual::screenshot_digest(&path)?,
                    });
                    result["viewport"] = viewport["result"].clone();
                    result["viewport"]["visualRecheck"] = json!("sha256");
                    result["viewport"]["scrollDistance"] = json!(true);
                    result["localScreenshot"] = json!(path);
                }
                // 仅原生 DOM 目标支持确认聚焦后的定向按键；旧节点没有该能力标记。
                result["viewport"]["targetedPress"] = json!(self.dom.is_some());
                Ok(result)
            }
            BrowserCommand::BrowserAct {
                action,
                target,
                value,
                observation_id,
                ..
            } => {
                let name = raw["action"].as_str().unwrap();
                if ["online", "pwa.cleanup", "network.probe"].contains(&name) {
                    let tab = network_target.as_ref().ok_or_else(|| {
                        Fault::rejected("CAPABILITY_UNSUPPORTED", "runtime capture not enabled")
                    })?;
                    self.observation = None;
                    self.visual = None;
                    self.targets.clear();
                    let capture = self.networks.get_mut(tab).unwrap();
                    return if name == "network.probe" {
                        capture.network_probe(target.as_deref().unwrap_or("")).await
                    } else {
                        capture.runtime_action(tab, name).await
                    };
                }
                let element = [
                    "click", "fill", "type", "hover", "check", "uncheck", "select", "scroll",
                    "press",
                ]
                .contains(&name)
                    && target.is_some();
                if (element || name == "visual.click" || name == "frame")
                    && (self.observation.is_none() || observation_id != self.observation)
                {
                    return Err(Fault::rejected(
                        "STALE_OBSERVATION",
                        "take a fresh observation before acting",
                    ));
                }
                if ["tab.switch", "tab.close"].contains(&name)
                    && !self.tabs.contains(&target.clone().unwrap_or_default())
                {
                    return Err(Fault::rejected(
                        "INVALID_TARGET",
                        "tab must belong to current observation",
                    ));
                }
                if name == "frame" {
                    self.frame = if target.as_deref() == Some("main") {
                        None
                    } else {
                        Some(
                            self.dom
                                .as_mut()
                                .ok_or_else(|| {
                                    Fault::rejected(
                                        "INVALID_TARGET",
                                        "native DOM observation required",
                                    )
                                })?
                                .frame(target.as_deref().unwrap_or_default())
                                .await?,
                        )
                    };
                    self.observation = None;
                    self.visual = None;
                    self.targets.clear();
                    return Ok(json!({"performed":true}));
                }
                if [
                    "navigate",
                    "back",
                    "forward",
                    "reload",
                    "tab.new",
                    "tab.switch",
                    "tab.close",
                ]
                .contains(&name)
                {
                    self.frame = None;
                }
                if element
                    && self
                        .dom
                        .as_ref()
                        .is_some_and(|dom| dom.owns(target.as_deref().unwrap()))
                {
                    let mut dom = self.dom.take().unwrap();
                    self.observation = None;
                    self.visual = None;
                    self.targets.clear();
                    if name == "press" {
                        // CLI 的 press 是全局按键，必须先核对指定原生节点已取得焦点。
                        // 聚焦与按键共用本次命令截止时间，任何失败都不降级为全局重试。
                        let args = action_args(action, None, value.clone())?;
                        dom.act(target.as_deref().unwrap(), "focus", None).await?;
                        self.cli(args, remaining()).await?;
                        return Ok(
                            json!({"performed":true,"keyboard":{"scope":"target","target":target,"focusVerified":true}}),
                        );
                    }
                    if name == "scroll" {
                        return dom
                            .scroll(target.as_deref().unwrap(), value.as_deref().unwrap_or(""))
                            .await;
                    }
                    dom.act(target.as_deref().unwrap(), name, value.as_deref())
                        .await?;
                    return Ok(json!({"performed":true}));
                }
                if name == "visual.click" {
                    let previous = self.visual.as_ref().ok_or_else(|| {
                        Fault::rejected(
                            "STALE_OBSERVATION",
                            "visual click requires a current screenshot",
                        )
                    })?;
                    let viewport = self
                        .cli(vec!["eval".into(), VISUAL_VIEWPORT.into()], remaining())
                        .await?;
                    let x = raw["x"].as_f64().unwrap();
                    let y = raw["y"].as_f64().unwrap();
                    previous.validate(&viewport["result"], process::boot_ms(), x, y)?;
                    // URL 和滚动位置不变也可能出现弹层。输入前重新取图，只比较完整原始 PNG。
                    let probe = self
                        .config
                        .directory
                        .join(format!("visual-probe-{}.png", uuid::Uuid::new_v4()));
                    let captured = self
                        .cli(
                            vec!["screenshot".into(), probe.to_string_lossy().into()],
                            remaining(),
                        )
                        .await;
                    let digest = captured.and_then(|_| visual::screenshot_digest(&probe));
                    let _ = std::fs::remove_file(&probe);
                    if digest? != previous.digest {
                        return Err(Fault::rejected(
                            "STALE_OBSERVATION",
                            "screenshot changed; observe before visual input",
                        ));
                    }
                    let current = self
                        .cli(vec!["eval".into(), VISUAL_VIEWPORT.into()], remaining())
                        .await?;
                    previous.validate(&current["result"], process::boot_ms(), x, y)?;
                    self.observation = None;
                    self.visual = None;
                    self.dom = None;
                    self.targets.clear();
                    self.cli(
                        vec![
                            "mouse".into(),
                            "move".into(),
                            x.floor().to_string(),
                            y.floor().to_string(),
                        ],
                        remaining(),
                    )
                    .await?;
                    self.cli(
                        vec!["mouse".into(), "down".into(), "left".into()],
                        remaining(),
                    )
                    .await?;
                    self.cli(
                        vec!["mouse".into(), "up".into(), "left".into()],
                        remaining(),
                    )
                    .await?;
                    return Ok(json!({"performed":true}));
                }
                if name == "press" && target.is_some() {
                    return Err(Fault::rejected(
                        "INVALID_TARGET",
                        "targeted press requires a current native DOM target",
                    ));
                }
                if name == "scroll" && target.is_some() {
                    return Err(Fault::rejected(
                        "INVALID_SCROLL_TARGET",
                        "targeted scrolling requires native DOM observation",
                    ));
                }
                let target = if element {
                    Some(
                        self.targets
                            .get(target.as_deref().unwrap_or_default())
                            .ok_or_else(|| {
                                Fault::rejected(
                                    "INVALID_TARGET",
                                    "target is absent from current observation",
                                )
                            })?
                            .clone(),
                    )
                } else {
                    target
                };
                let navigation_url = if name == "navigate" {
                    target.clone()
                } else {
                    None
                };
                let args = action_args(action, target, value)?;
                self.observation = None;
                self.visual = None;
                self.dom = None;
                self.targets.clear();
                if let Err(fault) = self.cli(args, remaining()).await {
                    if let Some(url) = navigation_url
                        && fault.code == "ENGINE_FAILED"
                        && fault.message == ENGINE_TIMEOUT
                        && remaining() > 1000
                        && let Ok(probe) = self
                            .cli(
                                vec!["eval".into(), NAVIGATION_PROBE.into()],
                                remaining().min(3000),
                            )
                            .await
                        && navigation_ready(&url, &probe)
                    {
                        return Ok(
                            json!({"performed":true,"loadEventTimedOut":true,"documentReady":true}),
                        );
                    }
                    return Err(fault);
                }
                if name == "press" {
                    return Ok(
                        json!({"performed":true,"keyboard":{"scope":"current-focus","focusVerified":false}}),
                    );
                }
                Ok(json!({"performed":true}))
            }
            BrowserCommand::BrowserTrace { action, .. } => {
                let action = serde_json::to_value(action).unwrap();
                if action == "start" {
                    if self.trace.is_some() {
                        return Err(Fault::rejected("TRACE_ACTIVE", "trace already started"));
                    }
                    let endpoint = self
                        .cli(vec!["get".into(), "cdp-url".into()], remaining())
                        .await?;
                    let mut trace =
                        dom::Dom::connect(endpoint["cdpUrl"].as_str().ok_or_else(|| {
                            Fault::rejected("TRACE_UNAVAILABLE", "private CDP endpoint missing")
                        })?)
                        .await?;
                    trace.trace_start().await?;
                    self.trace = Some(trace);
                    Ok(json!({"started":true}))
                } else {
                    let path = self
                        .config
                        .directory
                        .join("artifacts")
                        .join(format!("{}.trace.json", uuid::Uuid::new_v4()));
                    let mut trace = self.trace.take().ok_or_else(|| {
                        Fault::rejected("TRACE_INACTIVE", "trace was not started")
                    })?;
                    trace.trace_stop(&path).await?;
                    Ok(json!({"localTrace":path}))
                }
            }
            BrowserCommand::BrowserCookiesSet { .. }
            | BrowserCommand::BrowserCookiesClear { .. } => {
                let clear = matches!(operation, BrowserCommand::BrowserCookiesClear { .. });
                let params = if clear {
                    cookies::clear_parameters(&raw)?
                } else {
                    cookies::parameters(&raw)?
                };
                let endpoint = self
                    .cli(vec!["get".into(), "cdp-url".into()], remaining())
                    .await?;
                let listed = self
                    .cli(vec!["tab".into(), "list".into()], remaining())
                    .await?;
                let target = listed["tabs"]
                    .as_array()
                    .and_then(|tabs| tabs.iter().find(|t| t["active"] == true))
                    .and_then(|t| t["targetId"].as_str())
                    .ok_or_else(|| {
                        Fault::rejected("COOKIE_TARGET_MISSING", "active browser tab missing")
                    })?;
                let endpoint = endpoint["cdpUrl"].as_str().ok_or_else(|| {
                    Fault::rejected("COOKIE_UNAVAILABLE", "private browser connection missing")
                })?;
                // 写入后旧观察失效；即使传输失败也不能继续使用旧元素身份。
                self.observation = None;
                self.targets.clear();
                self.dom = None;
                self.visual = None;
                let mut dom = dom::Dom::connect(endpoint).await?;
                if clear {
                    dom.clear_cookies(target, &params).await?;
                    Ok(json!({"cleared":true,"names":params["names"]}))
                } else {
                    dom.set_cookie(target, params).await?;
                    Ok(json!({"written":true}))
                }
            }
            BrowserCommand::SessionProfilePublish => self.publish_default_profile(timeout_ms).await,
            BrowserCommand::BrowserAuthSave { .. } => {
                Err(Fault::rejected("AUTH_SAVE_RETIRED", "案例不再保存身份基准"))
            }
            BrowserCommand::BrowserWait { selector, text, .. } => {
                let wait_deadline = process::boot_ms()
                    + remaining()
                        .saturating_sub(CONDITION_REPLY_RESERVE_MS)
                        .min(CONDITION_WAIT_MS);
                if self.dom.is_none() {
                    let endpoint = self
                        .cli(vec!["get".into(), "cdp-url".into()], remaining())
                        .await?;
                    if let Some(endpoint) = endpoint["cdpUrl"].as_str() {
                        let tabs = self
                            .cli(vec!["tab".into(), "list".into()], remaining())
                            .await?;
                        let active = tabs["tabs"]
                            .as_array()
                            .and_then(|tabs| tabs.iter().find(|t| t["active"] == true))
                            .and_then(|t| t["targetId"].as_str())
                            .ok_or_else(|| {
                                Fault::unknown("DOM_ENGINE_FAILED", "active tab unavailable")
                            })?;
                        let mut dom = dom::Dom::connect(endpoint).await?;
                        dom.snapshot(active, self.frame.as_deref()).await?;
                        self.dom = Some(dom);
                    }
                }

                if let Some(dom) = self.dom.as_mut() {
                    loop {
                        if process::boot_ms() >= wait_deadline {
                            return Err(Fault::rejected(
                                "CONDITION_NOT_MET",
                                "condition not confirmed within bounded wait; observe again",
                            ));
                        }
                        if dom
                            .condition(&selector, &text, self.frame.as_deref())
                            .await?
                        {
                            return Ok(json!({"conditionMet":true}));
                        }
                        tokio::time::sleep(Duration::from_millis(
                            wait_deadline.saturating_sub(process::boot_ms()).min(100),
                        ))
                        .await;
                    }
                }

                #[cfg(feature = "protocol-fixtures")]
                {
                    self.fixture_wait(&selector, &text, remaining()).await
                }
                #[cfg(not(feature = "protocol-fixtures"))]
                {
                    Err(Fault::rejected(
                        "DOM_ENGINE_REQUIRED",
                        "native CDP wait is required",
                    ))
                }
            }
            _ => Err(Fault::rejected("UNSUPPORTED", "not a browser operation")),
        }
    }
}
/// 0.38.1 在派发鼠标事件前检查遮挡；只匹配该固定错误，其他失败不降级。
fn engine_failure(args: &[String], response: &Value) -> Fault {
    let message = response["error"]
        .as_str()
        .unwrap_or("engine command failed");
    if args.first().is_some_and(|a| a == "click")
        && args.get(1).is_some_and(|target| message.starts_with(&format!("Element '{target}' is covered by <")))
        && message.ends_with(
            "> at its click point, so the input would land on that element instead. Dismiss or interact with the covering element first (it is often a dialog, banner, or sticky header).",
        )
    {
        return Fault::rejected("TARGET_OBSCURED", "点击目标被其他元素遮挡，未派发点击；请刷新观察并处理遮挡或调整滚动位置");
    }
    Fault::unknown(
        "ENGINE_FAILED",
        message.chars().take(1024).collect::<String>(),
    )
}
/// 必须是原导航地址且文档已解析；重定向、错误页或仅 loading 均不能确认成功。
fn navigation_ready(expected: &str, probe: &Value) -> bool {
    let actual = probe["result"]["url"]
        .as_str()
        .and_then(|s| reqwest::Url::parse(s).ok());
    actual.is_some()
        && actual == reqwest::Url::parse(expected).ok()
        && matches!(
            probe["result"]["readyState"].as_str(),
            Some("interactive" | "complete")
        )
}
/// 在派发前拒绝未验证写动作和明显无效的操作参数。
pub fn validate(command: &BrowserCommand, writes: bool) -> Result<()> {
    match command {
        BrowserCommand::BrowserIdentityPrepare { .. } => {
            return Err(Fault::rejected(
                "LOCAL_IDENTITY_REMOVED",
                "本地登录配方已移除",
            ));
        }
        BrowserCommand::BrowserCookiesSet { .. } | BrowserCommand::BrowserCookiesClear { .. } => {
            if !writes {
                return Err(Fault::rejected(
                    "ENGINE_WRITES_UNVERIFIED",
                    "cookie writes require write opt-in",
                ));
            }
            let raw = serde_json::to_value(command).unwrap();
            if matches!(command, BrowserCommand::BrowserCookiesClear { .. }) {
                cookies::clear_parameters(&raw)?;
            } else {
                cookies::parameters(&raw)?;
            }
        }
        BrowserCommand::BrowserInput { .. } => {
            if !writes {
                return Err(Fault::rejected(
                    "ENGINE_WRITES_UNVERIFIED",
                    "manual input requires development write opt-in",
                ));
            }
            let value = serde_json::to_value(command).unwrap();
            let action = value["action"].as_str().unwrap_or("");
            let valid = match action {
                "drag" => drag::valid(&value),
                "click" | "scroll" => {
                    ["x", "y"].iter().all(|key| {
                        value[key]
                            .as_f64()
                            .is_some_and(|n| (0.0..=16384.0).contains(&n))
                    }) && (action != "scroll"
                        || ["deltaX", "deltaY"].iter().all(|key| {
                            value[key]
                                .as_i64()
                                .is_some_and(|n| (-2000..=2000).contains(&n))
                        }))
                }
                "text" => value["value"].as_str().is_some_and(|s| {
                    !s.is_empty() && s.chars().count() <= 4096 && !s.contains('\0')
                }),
                "press" => value["value"].as_str().is_some_and(|s| {
                    [
                        "Enter",
                        "Tab",
                        "Shift+Tab",
                        "Backspace",
                        "Delete",
                        "Escape",
                        "ArrowUp",
                        "ArrowDown",
                        "ArrowLeft",
                        "ArrowRight",
                        "Home",
                        "End",
                        "Control+a",
                        "Meta+a",
                        "Space",
                        "Minus",
                    ]
                    .contains(&s)
                }),
                _ => false,
            };
            if !valid {
                return Err(Fault::rejected("INVALID_ARGUMENT", "invalid manual input"));
            }
        }
        BrowserCommand::BrowserAct {
            action,
            target,
            value,
            ..
        } => {
            if !writes {
                return Err(Fault::rejected(
                    "ENGINE_WRITES_UNVERIFIED",
                    "write actions require explicit development opt-in until lost-response validation passes",
                ));
            }
            if serde_json::to_value(action).unwrap() == "visual.click"
                && !["x", "y"].iter().all(|key| {
                    serde_json::to_value(command).unwrap()[key]
                        .as_f64()
                        .is_some_and(|n| (0.0..=16384.0).contains(&n))
                })
            {
                return Err(Fault::rejected(
                    "INVALID_ARGUMENT",
                    "visual coordinates required",
                ));
            }
            let name = serde_json::to_value(action).unwrap();
            if ["online", "pwa.cleanup", "network.probe"].contains(&name.as_str().unwrap_or("")) {
                if value.is_some()
                    || (name != "network.probe" && target.is_some())
                    || (name == "network.probe"
                        && target.as_ref().is_none_or(|url| url.len() > 8192))
                {
                    return Err(Fault::rejected(
                        "INVALID_ARGUMENT",
                        "runtime action parameters invalid",
                    ));
                }
                return Ok(());
            }
            // 原生节点输入经 CDP 传输，不经过 argv；允许空串和前导短横线。
            let native_input = target.as_deref().is_some_and(|id| id.starts_with("dom-"))
                && ["fill", "type", "select"]
                    .iter()
                    .any(|name| serde_json::to_value(action).unwrap() == *name);
            if native_input {
                if value
                    .as_ref()
                    .is_none_or(|v| v.len() > 8192 || v.contains('\0'))
                {
                    return Err(Fault::rejected("INVALID_ARGUMENT", "invalid input value"));
                }
            } else {
                action_args(*action, target.clone(), value.clone())?;
            }
        }
        BrowserCommand::BrowserWait { selector, text, .. }
            if selector.is_empty() || selector.len() > 1024 || text.len() > 8192 =>
        {
            return Err(Fault::rejected(
                "INVALID_ARGUMENT",
                "invalid wait condition",
            ));
        }
        _ => {}
    }
    Ok(())
}
/// 校验 CLI 位置参数，阻止以短横线开头的值被解释为额外选项。
fn argument(value: Option<String>, name: &str) -> Result<String> {
    let value =
        value.ok_or_else(|| Fault::rejected("INVALID_ARGUMENT", format!("{name} required")))?;
    if value.is_empty() || value.len() > 8192 || value.starts_with('-') || value.contains('\0') {
        return Err(Fault::rejected(
            "INVALID_ARGUMENT",
            format!("invalid {name}"),
        ));
    }
    Ok(value)
}
/// 将有限动作转成固定 argv；导航只接受不含凭据的 HTTP(S) URL。
pub fn action_args(
    action: ActBrowserAction,
    target: Option<String>,
    value: Option<String>,
) -> Result<Vec<String>> {
    let action = serde_json::to_value(action).unwrap();
    Ok(match action.as_str().unwrap() {
        "navigate" => {
            let url = argument(target, "target")?;
            let parsed = reqwest::Url::parse(&url)
                .map_err(|_| Fault::rejected("INVALID_ARGUMENT", "invalid URL"))?;
            if !matches!(parsed.scheme(), "http" | "https")
                || !parsed.username().is_empty()
                || parsed.password().is_some()
            {
                return Err(Fault::rejected(
                    "INVALID_ARGUMENT",
                    "HTTP(S) URL without credentials required",
                ));
            }
            vec!["open".into(), url]
        }
        "click" | "hover" | "check" | "uncheck" => {
            vec![action.as_str().unwrap().into(), argument(target, "target")?]
        }
        "type" if target.is_none() => vec![
            "keyboard".into(),
            "inserttext".into(),
            argument(value, "value")?,
        ],
        "fill" | "type" | "select" => vec![
            action.as_str().unwrap().into(),
            argument(target, "target")?,
            if value.as_deref() == Some("") {
                String::new()
            } else {
                argument(value, "value")?
            },
        ],
        "press" => vec!["press".into(), argument(value, "value")?],
        "scroll" => {
            let value = argument(value, "value")?;
            let (direction, distance) = scroll::parse(&value)?;
            vec!["scroll".into(), direction.into(), distance.to_string()]
        }
        "back" | "forward" | "reload" => vec![action.as_str().unwrap().into()],
        "frame" => vec!["frame".into(), argument(target, "frame")?],
        "tab.new" => {
            let url = argument(target, "URL")?;
            let parsed = reqwest::Url::parse(&url)
                .map_err(|_| Fault::rejected("INVALID_ARGUMENT", "invalid URL"))?;
            if !matches!(parsed.scheme(), "http" | "https")
                || !parsed.username().is_empty()
                || parsed.password().is_some()
            {
                return Err(Fault::rejected("INVALID_ARGUMENT", "HTTP(S) URL required"));
            }
            vec!["tab".into(), "new".into(), url]
        }
        "tab.switch" => vec!["tab".into(), argument(target, "tab")?],
        "tab.close" => vec!["tab".into(), "close".into(), argument(target, "tab")?],
        "resize" => {
            let size = argument(value, "viewport")?;
            let (width, height) = size
                .split_once('x')
                .ok_or_else(|| Fault::rejected("INVALID_ARGUMENT", "use WIDTHxHEIGHT"))?;
            if ![width, height]
                .iter()
                .all(|v| v.parse::<u32>().is_ok_and(|n| (100..=4096).contains(&n)))
            {
                return Err(Fault::rejected(
                    "INVALID_ARGUMENT",
                    "viewport out of bounds",
                ));
            }
            vec!["set".into(), "viewport".into(), width.into(), height.into()]
        }
        "visual.click" => Vec::new(),
        _ => return Err(Fault::rejected("INVALID_ARGUMENT", "unknown action")),
    })
}
/// 返回以运行用户和随机会话名隔离的本地 daemon socket 目录。
pub fn socket_directory(session: &str) -> PathBuf {
    #[cfg(unix)]
    let uid = unsafe { libc::geteuid() };
    #[cfg(not(unix))]
    let uid = 0;
    Path::new("/tmp")
        .join(format!("proofrun-{uid}"))
        .join(session)
}

#[cfg(test)]
mod recovery_tests {
    use super::*;

    /// 旧配方命令无论写权限均被拒绝；只验证派发门禁，不进行真实浏览器登录。
    #[test]
    fn local_identity_preparation_is_retired() {
        let command: BrowserCommand = serde_json::from_value(json!({"type":"browser.identity.prepare","url":"https://example.test","checks":[],"saveSnapshot":false})).unwrap();
        for writes in [false, true] {
            assert_eq!(
                validate(&command, writes).unwrap_err().code,
                "LOCAL_IDENTITY_REMOVED"
            );
        }
    }

    /// 验证固定引擎的派发前遮挡分类；不模拟真实浏览器点击或覆盖其他错误文案。
    #[test]
    fn only_exact_click_interception_is_not_started() {
        let error = json!({"error":"Element '@e7' is covered by <div#banner> at its click point, so the input would land on that element instead. Dismiss or interact with the covering element first (it is often a dialog, banner, or sticky header)."});
        let click = vec!["click".into(), "@e7".into()];
        let fault = engine_failure(&click, &error);
        assert_eq!(fault.code, "TARGET_OBSCURED");
        assert_eq!(fault.effect, "NOT_STARTED");
        for args in [
            vec!["fill".into(), "@e7".into()],
            vec!["click".into(), "@e8".into()],
        ] {
            assert_eq!(engine_failure(&args, &error).effect, "MAY_HAVE_HAPPENED");
        }
        assert_eq!(
            engine_failure(&click, &json!({"error":ENGINE_TIMEOUT})).effect,
            "MAY_HAVE_HAPPENED"
        );
    }

    /// 验证导航超时的只读核实条件；不证明网站动态内容已全部加载，也不放行重定向。
    #[test]
    fn navigation_requires_original_url_and_parsed_document() {
        let ready = |url: &str, state: &str| json!({"result":{"url":url,"readyState":state}});
        assert!(navigation_ready(
            "https://example.com/",
            &ready("https://example.com/", "interactive")
        ));
        assert!(navigation_ready(
            "https://example.com/",
            &ready("https://example.com/", "complete")
        ));
        assert!(!navigation_ready(
            "https://example.com/",
            &ready("https://example.com/", "loading")
        ));
        assert!(!navigation_ready(
            "https://example.com/",
            &ready("https://example.com/login", "complete")
        ));
        assert!(!navigation_ready("https://example.com/", &json!({})));
    }
}
