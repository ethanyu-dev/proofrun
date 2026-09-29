use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[error("{code}: {message}")]
/// 向控制面返回的稳定错误分类与副作用判断。
pub struct Fault {
    /// 机器可处理的错误码，重试策略不能依赖 message 文本。
    pub code: String,
    /// 用于诊断的人类可读说明。
    pub message: String,
    /// NOT_STARTED 或 MAY_HAVE_HAPPENED，指导是否允许安全重试。
    pub effect: String,
}
impl Fault {
    /// 明确在派发前拒绝，保证该命令没有开始执行。
    pub fn rejected(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            effect: "NOT_STARTED".into(),
        }
    }
    /// 派发后发生故障或无法确认结果，调用方必须先核实外部状态。
    pub fn unknown(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            effect: "MAY_HAVE_HAPPENED".into(),
        }
    }
}
pub type Result<T> = std::result::Result<T, Fault>;
