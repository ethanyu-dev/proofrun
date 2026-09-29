//! 固定版本的 agent-browser CLI 适配器。引擎 ref 仅在当前观察中有效；
//! CLI 结果不确定时结束该会话，避免后续动作与潜在副作用并发。
mod dom;

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

/// 单个 session-host 的引擎启动参数，不携带节点机器凭据。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EngineConfig {
    /// 固定版本 CLI 的绝对路径。
    pub binary: PathBuf,
    /// 可选的 Chrome 绝对路径。
    pub chrome: Option<PathBuf>,
    /// 随本次会话生成的引擎 session 名，隔离 daemon 和 socket。
    pub session: String,
    /// profile、配置及临时截图的私有目录。
    pub directory: PathBuf,
    /// 开发测试写动作开关，不代表生产写入语义已验证。
    pub allow_unverified_writes: bool,
    /// 绑定任务的节点私有状态文件，外部命令不能指定任意文件路径。
    #[serde(default)]
    pub auth_state: Option<PathBuf>,
    /// 首次登录允许无状态启动；复用任务要求状态必须存在。
    #[serde(default)]
    pub restore_auth: bool,
    /// 自动复用可在首次没有快照时启动空白会话。
    #[serde(default)]
    pub restore_auth_if_present: bool,
    /// 同一对照轮次固定同一份初始快照，避免启动先后影响比较。
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
    /// CLI、Chrome 和会话目录配置。
    config: EngineConfig,
    /// 当前会话允许更新的共享快照版本；并发会话更新后不得覆盖。
    auth_version: Option<String>,
    /// 当前有效观察身份；执行动作后清空。
    observation: Option<String>,
    /// 平台 target 到引擎短期 ref 的映射，不能作为公共协议暴露。
    targets: HashMap<String, String>,
    /// 原生 DOM 观察与实际节点引用，仅属于当前观察。
    dom: Option<dom::Dom>,
    /// Trace 使用独立连接，观察刷新不能中断采集。
    trace: Option<dom::Dom>,
    /// 最近截图的视口身份和采集时间，视觉输入必须匹配。
    visual: Option<(Value, u64)>,
    /// 只有当前观察列出的标签页才能切换或关闭。
    tabs: Vec<String>,
    /// 可选 iframe 观察范围；导航后恢复整个页面。
    frame: Option<String>,
}
impl Engine {
    /// 建立隔离目录并写入固定的 agent-browser 配置。
    pub fn new(config: EngineConfig) -> anyhow::Result<Self> {
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
        options["profile"] = json!(config.directory.join("profile"));
        std::fs::write(
            config.directory.join("agent-browser.json"),
            serde_json::to_vec(&options)?,
        )?;
        Ok(Self {
            config,
            auth_version: None,
            observation: None,
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
        self.cli(vec!["open".into(), "about:blank".into()], timeout_ms)
            .await?;
        if let Some(path) = &self.config.auth_state {
            let snapshot = crate::auth::snapshot(path, self.config.auth_snapshot_id.as_deref())
                .map_err(|_| {
                    Fault::rejected(
                        "AUTH_STATE_UNAVAILABLE",
                        "private authentication snapshot is unavailable",
                    )
                })?;
            self.auth_version = snapshot.version;
            if self.config.restore_auth {
                if let Some(state) = snapshot.state {
                    let local = self.config.directory.join("home").join("auth-start.json");
                    crate::auth::private_write(&local, &serde_json::to_vec(&state).unwrap())
                        .map_err(|_| {
                            Fault::rejected(
                                "AUTH_STATE_UNAVAILABLE",
                                "cannot prepare private authentication snapshot",
                            )
                        })?;
                    self.cli(
                        vec![
                            "state".into(),
                            "load".into(),
                            local.to_string_lossy().into(),
                        ],
                        deadline.saturating_sub(process::boot_ms()),
                    )
                    .await?;
                } else if !self.config.restore_auth_if_present {
                    return Err(Fault::rejected(
                        "AUTH_STATE_MISSING",
                        "private authentication state is unavailable",
                    ));
                }
            }
        } else if self.config.restore_auth {
            return Err(Fault::rejected(
                "AUTH_STATE_MISSING",
                "authentication state is not configured",
            ));
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
        Ok(json!({"opened":true}))
    }
    /// 尽力请求引擎关闭；最终资源回收仍以 systemd/cgroup 核实为准。
    pub async fn close(&self) {
        let _ = self.cli(vec!["close".into()], 2000).await;
    }
    /// 将封闭的公共操作映射到固定 CLI 命令，并规范化观察和结果。
    pub async fn execute(&mut self, operation: BrowserCommand, timeout_ms: u64) -> Result<Value> {
        validate(&operation, self.config.allow_unverified_writes)?;
        let deadline = process::boot_ms() + timeout_ms;
        let remaining = || deadline.saturating_sub(process::boot_ms()).max(1);
        let raw = serde_json::to_value(&operation).unwrap();
        match operation {
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
            BrowserCommand::BrowserObserve { screenshot } => {
                // DOM、URL、标题和可选截图由多次调用组成，结果明确标记非原子。
                // 验收依赖状态文本等非交互内容，不能只采集按钮与输入框。
                self.dom = None;
                self.visual = None;
                self.observation = None;
                let snapshot = self.cli(vec!["snapshot".into()], remaining()).await?;
                let url = self
                    .cli(vec!["get".into(), "url".into()], remaining())
                    .await?;
                let title = self
                    .cli(vec!["get".into(), "title".into()], remaining())
                    .await?;
                let id = uuid::Uuid::new_v4().to_string();
                self.targets.clear();
                let mut text = snapshot["snapshot"].as_str().unwrap_or_default().to_owned();
                let mut targets = Vec::new();
                if let Some(refs) = snapshot["refs"].as_object() {
                    for (index, (reference, descriptor)) in refs.iter().enumerate() {
                        let target = format!("element-{}", index + 1);
                        self.targets.insert(target.clone(), format!("@{reference}"));
                        text = text
                            .replace(&format!("[ref={reference}]"), &format!("[target={target}]"));
                        targets.push(json!({"target":target,"role":descriptor["role"],"name":descriptor["name"]}));
                    }
                }
                // 固定版本引擎提供私有 CDP 地址；旧协议夹具没有该字段，继续使用其声明的 AX 夹具。
                let endpoint = self
                    .cli(vec!["get".into(), "cdp-url".into()], remaining())
                    .await?;
                let mut dom_truncated = false;
                let mut coverage = json!({"controls":{"scope":"legacy","visibility":"unknown"}});
                // 原始语义快照仅作为有界诊断证据，不把其 ref 混入 native-dom 的动作身份。
                let reference_text = snapshot["snapshot"].as_str().unwrap_or_default();
                let reference_snapshot = json!({"source":"agent-browser","text":reference_text.chars().take(REFERENCE_SNAPSHOT_CHARS).collect::<String>(),
                    "truncated":reference_text.chars().count()>REFERENCE_SNAPSHOT_CHARS,"refCount":snapshot["refs"].as_object().map_or(0, |refs|refs.len())});
                let mut tabs = json!([]);
                if let Some(endpoint) = endpoint["cdpUrl"].as_str() {
                    let listed = self
                        .cli(vec!["tab".into(), "list".into()], remaining())
                        .await?;
                    tabs = listed["tabs"].clone();
                    let active = tabs
                        .as_array()
                        .and_then(|tabs| tabs.iter().find(|tab| tab["active"] == true))
                        .and_then(|tab| tab["targetId"].as_str())
                        .ok_or_else(|| {
                            Fault::unknown("DOM_ENGINE_FAILED", "active tab unavailable")
                        })?;
                    let mut dom = dom::Dom::connect(endpoint).await?;
                    let native = dom.snapshot(active, self.frame.as_deref()).await?;
                    text = native["text"].as_str().unwrap_or_default().to_owned();
                    targets = native["targets"].as_array().cloned().unwrap_or_default();
                    dom_truncated = native["truncated"] == true;
                    coverage = native["coverage"].clone();
                    coverage["referenceSnapshot"] = json!({"source":"agent-browser","refCount":reference_snapshot["refCount"],"scope":"semantic snapshot; not filtered to viewport; diagnostic only"});
                    self.dom = Some(dom);
                    self.targets.clear();
                }
                self.tabs = tabs
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|t| t["tabId"].as_str().map(str::to_owned))
                    .collect();
                self.observation = Some(id.clone());
                let mut result = json!({"observationId":id,"url":url.get("url"),"title":title.get("title"),"text":text,"targets":targets,"atomic":false,"truncated":dom_truncated,"coverage":coverage,"tabs":tabs});
                result["referenceSnapshot"] = reference_snapshot;
                if self.config.network_evidence {
                    let network = self
                        .cli(vec!["network".into(), "requests".into()], remaining())
                        .await?;
                    result["network"] = crate::network::sanitize(&network)?;
                    self.cli(
                        vec!["network".into(), "requests".into(), "--clear".into()],
                        remaining(),
                    )
                    .await?;
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
                    let viewport = self.cli(vec!["eval".into(), "({url:location.href,width:innerWidth,height:innerHeight,x:scrollX,y:scrollY})".into()], remaining()).await?;
                    self.visual = Some((viewport["result"].clone(), process::boot_ms()));
                    result["viewport"] = viewport["result"].clone();
                    result["localScreenshot"] = json!(path);
                }
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
                let element = [
                    "click", "fill", "type", "hover", "check", "uncheck", "select", "scroll",
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
                    let (previous, at) = self.visual.as_ref().ok_or_else(|| {
                        Fault::rejected(
                            "STALE_OBSERVATION",
                            "visual click requires a current screenshot",
                        )
                    })?;
                    let viewport=self.cli(vec!["eval".into(),"({url:location.href,width:innerWidth,height:innerHeight,x:scrollX,y:scrollY})".into()],remaining()).await?;
                    let x = raw["x"].as_f64().unwrap();
                    let y = raw["y"].as_f64().unwrap();
                    if process::boot_ms().saturating_sub(*at) > 120_000
                        || previous != &viewport["result"]
                        || x >= previous["width"].as_f64().unwrap_or(0.0)
                        || y >= previous["height"].as_f64().unwrap_or(0.0)
                    {
                        return Err(Fault::rejected(
                            "STALE_OBSERVATION",
                            "viewport changed; observe before visual input",
                        ));
                    }
                    self.observation = None;
                    self.visual = None;
                    self.dom = None;
                    self.targets.clear();
                    self.cli(
                        vec![
                            "mouse".into(),
                            "move".into(),
                            x.round().to_string(),
                            y.round().to_string(),
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
                Ok(json!({"performed":true}))
            }
            BrowserCommand::BrowserTrace { action } => {
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
            BrowserCommand::BrowserAuthSave => {
                let destination = self.config.auth_state.clone().ok_or_else(|| {
                    Fault::rejected("AUTH_STATE_MISSING", "task has no authentication slot")
                })?;
                crate::auth::prepare_parent(&destination).map_err(|_| {
                    Fault::rejected(
                        "AUTH_STATE_UNAVAILABLE",
                        "private authentication directory unavailable",
                    )
                })?;
                let temporary = destination.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
                let saved = self
                    .cli(
                        vec![
                            "state".into(),
                            "save".into(),
                            temporary.to_string_lossy().into(),
                        ],
                        remaining(),
                    )
                    .await;
                if saved.is_err() {
                    let _ = std::fs::remove_file(&temporary);
                }
                saved?;
                let committed = crate::auth::commit_if_current(
                    &temporary,
                    &destination,
                    &mut self.auth_version,
                )
                .map_err(|_| {
                    Fault::unknown(
                        "AUTH_STATE_SAVE_FAILED",
                        "authentication save result is uncertain",
                    )
                })?;
                Ok(
                    json!({"saved":committed,"reason":if committed { "SAVED" } else { "NEWER_STATE_PRESERVED" }}),
                )
            }
            BrowserCommand::BrowserWait { selector, text } => {
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
                        if dom
                            .condition(&selector, &text, self.frame.as_deref())
                            .await?
                        {
                            return Ok(json!({"conditionMet":true}));
                        }
                        if process::boot_ms() >= deadline {
                            return Err(Fault::rejected(
                                "CONDITION_NOT_MET",
                                "condition not met within command budget",
                            ));
                        }
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                }

                let selector = serde_json::to_string(&selector).unwrap();
                let text = serde_json::to_string(&text).unwrap();
                // 只把用户输入序列化成 JS 字符串字面量；不接收可执行脚本。
                let expression = format!(
                    "(() => {{ const walk = root => {{ for (const el of root.querySelectorAll('*')) {{ if (el.matches({selector}) && (el.textContent || '').includes({text})) return true; if (el.shadowRoot && walk(el.shadowRoot)) return true; try {{ if (el.contentDocument && walk(el.contentDocument)) return true; }} catch {{}} }} return false; }}; return walk(document); }})()"
                );
                self.cli(
                    vec![
                        "wait".into(),
                        "--fn".into(),
                        expression,
                        "--timeout".into(),
                        remaining().to_string(),
                    ],
                    remaining(),
                )
                .await?;
                Ok(json!({"conditionMet":true}))
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
        BrowserCommand::BrowserWait { selector, text }
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
            let direction = argument(value, "value")?;
            if !["up", "down", "left", "right"].contains(&direction.as_str()) {
                return Err(Fault::rejected(
                    "INVALID_ARGUMENT",
                    "invalid scroll direction",
                ));
            }
            vec!["scroll".into(), direction, "400".into()]
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
