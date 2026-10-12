//! 运行版本来自编译产物，不读取可被切换的安装目录或运行时环境变量。
use serde::Serialize;

/// 正式构建注入完整 release 标签；未注入时明确标记为开发构建。
pub const VERSION: &str = match option_env!("PROOFRUN_BUILD_VERSION") {
    Some(version) => version,
    None => concat!(env!("CARGO_PKG_VERSION"), "-dev"),
};
/// 发布工作流注入不可变源码提交，普通本地构建不猜测提交身份。
pub const SOURCE_COMMIT: Option<&str> = option_env!("PROOFRUN_BUILD_COMMIT");

/// 当前进程的编译身份；心跳、诊断和发布包核验共用同一份数据。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeVersion {
    /// 完整节点 release 标签，或明确的开发构建版本。
    pub version: &'static str,
    /// 发布源码的完整 SHA；未注入时为 null。
    pub source_commit: Option<&'static str>,
    /// 启动时必须通过探测的固定 agent-browser 版本。
    pub engine_version: &'static str,
}

/// 返回当前二进制编译时绑定的版本，不能由配置或心跳调用者覆盖。
pub fn current() -> RuntimeVersion {
    RuntimeVersion {
        version: VERSION,
        source_commit: SOURCE_COMMIT,
        engine_version: crate::engine::PINNED_AGENT_BROWSER_VERSION,
    }
}
