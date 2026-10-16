//! 视觉输入的证据绑定；截图字节完全一致才允许继续，动态画面可能需要重新观察。
use crate::error::{Fault, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;

/// 与 Agent 证据读取边界一致，避免复核时读取无界文件。
const MAX_SCREENSHOT_BYTES: u64 = 8 * 1024 * 1024;
/// 保留已有视觉观察有效期；完整画面复核仍必须在输入前执行。
const MAX_AGE_MS: u64 = 120_000;

/// 每个 tab 独立保存的截图来源，不能跨观察复用。
pub(super) struct VisualObservation {
    /// 截图对应的 URL、CSS 视口及滚动位置。
    pub viewport: Value,
    /// 单调时钟采集时间。
    pub at: u64,
    /// 原始 PNG 摘要，变化时不得沿用模型坐标。
    pub digest: Vec<u8>,
}

/// 私有临时路径由节点创建，摘要仅用于比对，不替代截图证据交付。
pub(super) fn screenshot_digest(path: &Path) -> Result<Vec<u8>> {
    let read = || -> std::io::Result<Vec<u8>> {
        use std::io::Read;
        let mut data = Vec::new();
        std::fs::File::open(path)?
            .take(MAX_SCREENSHOT_BYTES + 1)
            .read_to_end(&mut data)?;
        Ok(data)
    };
    let data = read()
        .map_err(|_| Fault::rejected("SCREENSHOT_UNAVAILABLE", "cannot read visual observation"))?;
    if data.len() as u64 > MAX_SCREENSHOT_BYTES || !data.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(Fault::rejected(
            "SCREENSHOT_UNAVAILABLE",
            "invalid visual observation",
        ));
    }
    Ok(Sha256::digest(data).to_vec())
}

impl VisualObservation {
    /// 坐标必须属于当前视口；完整画面摘要由调用方在实际输入前另行复核。
    pub fn validate(&self, viewport: &Value, now: u64, x: f64, y: f64) -> Result<()> {
        if now.saturating_sub(self.at) > MAX_AGE_MS
            || &self.viewport != viewport
            || !x.is_finite()
            || !y.is_finite()
            || x < 0.0
            || y < 0.0
            || x >= self.viewport["width"].as_f64().unwrap_or(0.0)
            || y >= self.viewport["height"].as_f64().unwrap_or(0.0)
        {
            return Err(Fault::rejected(
                "STALE_OBSERVATION",
                "viewport changed; observe before visual input",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // 范围：合成视口的期限、位置、边界检查；不证明浏览器画面或模型定位正确。
    #[test]
    fn viewport_and_age_are_bound_to_observation() {
        let v = json!({"url":"https://fixture.test","width":1280,"height":720,"x":0,"y":0});
        let observed = VisualObservation {
            viewport: v.clone(),
            at: 100,
            digest: vec![],
        };
        assert!(observed.validate(&v, 101, 35.0, 20.0).is_ok());
        assert!(observed.validate(&v, 120101, 35.0, 20.0).is_err());
        assert!(observed.validate(&v, 101, 1280.0, 20.0).is_err());
        assert!(observed.validate(&v, 101, f64::NAN, 20.0).is_err());
        let mut changed = v.clone();
        changed["x"] = json!(1);
        assert!(observed.validate(&changed, 101, 35.0, 20.0).is_err());
    }
}
