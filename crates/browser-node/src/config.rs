use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 未指定配置文件时使用的本机数据目录。
const DEFAULT_HOME: &str = ".proofrun";
/// 默认连接本机控制面；非回环地址仍由网关入口强制使用 TLS。
const DEFAULT_GATEWAY_URL: &str = "wss://localhost/v1/nodes/connect";
/// 默认租约上限为 60 秒，避免断连后会话长期失去控制。
const DEFAULT_MAX_LEASE_MS: u64 = 60_000;
/// 默认单会话硬期限为一小时，续租不得越过该期限。
const DEFAULT_MAX_SESSION_MS: u64 = 3_600_000;
/// 本地截图待上传目录的默认总额度为 256 MiB。
const DEFAULT_ARTIFACT_LIMIT_BYTES: u64 = 256 * 1024 * 1024;

/// 节点本机配置。这里的限制约束资源与启动行为，不代表控制面的任务策略。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct NodeConfig {
    /// SQLite、会话 profile 和截图等私有数据的根目录。
    pub home: PathBuf,
    /// 单控制面兼容入口；显式 bindings 使用注册表内各自的网关地址。
    pub gateway_url: String,
    /// 旧单控制面机器凭据文件；导入 bindings 后凭据保存在私有注册表。
    pub credential_file: PathBuf,
    /// 控制面选择节点时使用的资源池标识。
    pub pool: String,
    /// 客户端可访问的 HTTPS origin；TLS 由本机反向代理终止。
    pub public_url: Option<String>,
    /// 直连监听仅允许回环地址，避免绕过反向代理暴露明文控制入口。
    pub listen: String,
    /// 宿主保留内存与每个会话的最低预算，单位字节。
    pub memory_reserve_bytes: u64,
    /// 单个会话尚未产生实际占用时预留的内存预算。
    pub session_reserve_bytes: u64,
    /// CPU 利用率停止/恢复阈值及压力阈值，单位百分比。
    pub cpu_stop_percent: f64,
    /// 停止接收后恢复所需的低利用率阈值。
    pub cpu_resume_percent: f64,
    /// cgroup CPU 等待压力的十秒均值上限。
    pub cpu_pressure_percent: f64,
    /// 固定版本 agent-browser 的原生可执行文件。
    pub agent_browser_bin: PathBuf,
    /// 可选的 Chrome 可执行文件；未指定时由引擎选择。
    pub chrome_bin: Option<PathBuf>,
    /// 一次执行租约允许的最长时长，单位毫秒。
    pub max_lease_ms: u64,
    /// 单会话从创建到结束的硬上限，单位毫秒。
    pub max_session_ms: u64,
    /// 本地待上传证据可占用的最大字节数。
    pub artifact_limit_bytes: u64,
    /// 可选的控制面截图上传入口，必须与网关同源。
    pub artifact_upload_url: Option<String>,
    /// 仅供开发测试启用写动作；不能据此宣称引擎的丢响应行为已验证。
    pub allow_unverified_writes: bool,
    /// 按需保留 agent-browser 语义诊断快照；常规观察只使用原生 DOM。
    pub diagnostic_snapshots: bool,
}
impl Default for NodeConfig {
    fn default() -> Self {
        Self {
            home: PathBuf::from(DEFAULT_HOME),
            gateway_url: DEFAULT_GATEWAY_URL.into(),
            credential_file: PathBuf::from("credential.json"),
            pool: "default".into(),
            public_url: None,
            listen: "127.0.0.1:9310".into(),
            memory_reserve_bytes: 1024 * 1024 * 1024,
            session_reserve_bytes: 512 * 1024 * 1024,
            cpu_stop_percent: 80.0,
            cpu_resume_percent: 60.0,
            cpu_pressure_percent: 20.0,
            agent_browser_bin: PathBuf::from("agent-browser"),
            chrome_bin: None,
            max_lease_ms: DEFAULT_MAX_LEASE_MS,
            max_session_ms: DEFAULT_MAX_SESSION_MS,
            artifact_limit_bytes: DEFAULT_ARTIFACT_LIMIT_BYTES,
            artifact_upload_url: None,
            allow_unverified_writes: false,
            diagnostic_snapshots: false,
        }
    }
}
impl NodeConfig {
    /// 读取 TOML 并应用少量环境变量覆盖；随后校验资源上限并规范化路径。
    pub fn load(path: Option<&Path>) -> Result<Self> {
        let mut config: Self = match path {
            Some(path) => {
                toml::from_str(&std::fs::read_to_string(path).context("read node config")?)?
            }
            None => Self::default(),
        };
        if let Ok(home) = std::env::var("PROOFRUN_NODE_HOME") {
            config.home = home.into();
        }
        if let Ok(binary) = std::env::var("PROOFRUN_AGENT_BROWSER_BIN") {
            config.agent_browser_bin = binary.into();
        }
        if let Ok(chrome) = std::env::var("PROOFRUN_CHROME_BIN") {
            config.chrome_bin = Some(chrome.into());
        }
        ensure!(
            std::env::var_os("PROOFRUN_IDENTITY_LIBRARY_FILE").is_none(),
            "本地身份库已移除，请移除 PROOFRUN_IDENTITY_LIBRARY_FILE 并使用 DevPass"
        );
        if let Ok(url) = std::env::var("PROOFRUN_NODE_PUBLIC_URL") {
            config.public_url = Some(url);
        }
        if let Ok(listen) = std::env::var("PROOFRUN_NODE_LISTEN") {
            config.listen = listen;
        }
        let address: std::net::SocketAddr =
            config.listen.parse().context("listen 必须是回环 IP:端口")?;
        ensure!(
            address.ip().is_loopback(),
            "listen 必须绑定回环地址，由本机反向代理提供 TLS"
        );
        if let Some(value) = &config.public_url {
            let url = reqwest::Url::parse(value)?;
            let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
            ensure!(
                (url.scheme() == "https" || (local && url.scheme() == "http"))
                    && url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.path() == "/"
                    && url.query().is_none()
                    && url.fragment().is_none(),
                "public_url 必须是客户端可访问的 HTTPS origin，不能带路径、参数或凭据"
            );
            config.public_url = Some(url.origin().ascii_serialization());
        }
        ensure!(
            config.cpu_resume_percent > 0.0
                && config.cpu_resume_percent < config.cpu_stop_percent
                && config.cpu_stop_percent <= 100.0
                && config.cpu_pressure_percent > 0.0
                && config.cpu_pressure_percent <= 100.0,
            "CPU 阈值必须满足 0 < resume < stop <= 100"
        );
        ensure!(
            config.memory_reserve_bytes >= 64 * 1024 * 1024
                && config.session_reserve_bytes >= 64 * 1024 * 1024,
            "内存余量不能低于 64 MiB"
        );
        ensure!(
            (1_000..=120_000).contains(&config.max_lease_ms),
            "max_lease_ms must be between 1000 and 120000"
        );
        ensure!(
            (1_000..=86_400_000).contains(&config.max_session_ms),
            "invalid max_session_ms"
        );
        ensure!(
            config.artifact_limit_bytes >= 1024 * 1024,
            "artifact quota must be at least 1 MiB"
        );
        ensure!(!config.pool.is_empty(), "pool cannot be empty");
        config.home = std::path::absolute(&config.home)?;
        if config.credential_file.is_relative() {
            config.credential_file = config.home.join(&config.credential_file);
        }
        Ok(config)
    }
    /// 建立私有目录，并将引擎和 Chrome 路径解析为实际可执行文件路径。
    pub fn prepare(&mut self) -> Result<()> {
        std::fs::create_dir_all(&self.home)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.home, std::fs::Permissions::from_mode(0o700))?;
        }
        self.agent_browser_bin = resolve_executable(&self.agent_browser_bin)?;
        if let Some(chrome) = &self.chrome_bin {
            self.chrome_bin = Some(resolve_executable(chrome)?);
        }
        Ok(())
    }
    /// 在连接控制面前读取机器凭据；凭据不进入会话 host 配置。
    pub fn credential(&self) -> Result<String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Credential {
            token: String,
        }
        let data: Credential = serde_json::from_slice(
            &std::fs::read(&self.credential_file).context("read credential_file")?,
        )?;
        ensure!(!data.token.trim().is_empty(), "empty credential");
        Ok(data.token)
    }
}
/// 显式路径直接规范化，裸命令名则逐项查找 PATH 中的文件。
pub fn resolve_executable(path: &Path) -> Result<PathBuf> {
    if path.is_absolute() || path.components().count() > 1 {
        return Ok(std::fs::canonicalize(path)?);
    }
    for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let candidate = directory.join(path);
        if candidate.is_file() {
            return Ok(std::fs::canonicalize(candidate)?);
        }
    }
    anyhow::bail!("executable not found: {}", path.display())
}
