use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 未指定配置文件时使用的本机数据目录。
const DEFAULT_HOME: &str = ".proofrun";
/// 默认连接本机控制面；非回环地址仍由网关入口强制使用 TLS。
const DEFAULT_GATEWAY_URL: &str = "wss://localhost/v1/nodes/connect";
/// 单个节点默认允许同时运行的浏览器会话数。
const DEFAULT_CAPACITY: usize = 2;
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
    /// 节点主动连接控制面的 WebSocket 地址。
    pub gateway_url: String,
    /// 控制面签发的机器凭据文件；相对路径以 home 为基准。
    pub credential_file: PathBuf,
    /// 控制面选择节点时使用的资源池标识。
    pub pool: String,
    /// 同时占用的会话上限；关闭中和隔离会话也计入。
    pub capacity: usize,
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
}
impl Default for NodeConfig {
    fn default() -> Self {
        Self {
            home: PathBuf::from(DEFAULT_HOME),
            gateway_url: DEFAULT_GATEWAY_URL.into(),
            credential_file: PathBuf::from("credential.json"),
            pool: "default".into(),
            capacity: DEFAULT_CAPACITY,
            agent_browser_bin: PathBuf::from("agent-browser"),
            chrome_bin: None,
            max_lease_ms: DEFAULT_MAX_LEASE_MS,
            max_session_ms: DEFAULT_MAX_SESSION_MS,
            artifact_limit_bytes: DEFAULT_ARTIFACT_LIMIT_BYTES,
            artifact_upload_url: None,
            allow_unverified_writes: false,
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
            (1..=32).contains(&config.capacity),
            "capacity must be between 1 and 32"
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
