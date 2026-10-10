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
    /// 只读 DOM 采集失败允许重新观察；写入、超时和其他未知故障仍须关闭会话。
    /// read_only_observation 必须由原始类型化命令确定，不能由错误正文推断。
    pub fn requires_session_close(&self, read_only_observation: bool) -> bool {
        self.effect != "NOT_STARTED" && !(read_only_observation && self.code == "DOM_ENGINE_FAILED")
    }

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

#[cfg(test)]
mod tests {
    use super::Fault;

    // 范围：仅校验错误分类白名单；实际进程存活与观察恢复由 Linux 集成测试覆盖。
    #[test]
    fn only_dom_observation_failure_preserves_session() {
        let dom = Fault::unknown("DOM_ENGINE_FAILED", "read failed");
        assert!(!dom.requires_session_close(true));
        assert!(dom.requires_session_close(false));
        for code in ["DEADLINE_EXCEEDED", "ENGINE_IO", "STORE_FAILED", "UNKNOWN"] {
            assert!(Fault::unknown(code, "failure").requires_session_close(true));
        }
        assert!(!Fault::rejected("STALE_OBSERVATION", "rejected").requires_session_close(false));
    }
}
