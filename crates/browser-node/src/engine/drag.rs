//! 人工拖动以完整轨迹执行，避免跨命令持有鼠标按键；不生成或推断验证码轨迹。
use serde_json::Value;

/// 与输入协议及前端采样上限一致，控制消息不能无限增长。
const MAX_POINTS: usize = 256;
/// 给十五秒人工命令预算留出连接、执行和清理余量。
const MAX_DURATION_MS: u64 = 8000;
/// 与其他人工坐标输入保持同一视口边界。
const MAX_COORDINATE: f64 = 16384.0;

/// 在任何输入发生前验证起点、时间顺序和有限坐标，防止畸形轨迹执行到一半才失败。
pub(super) fn valid(raw: &Value) -> bool {
    let Some(points) = raw["points"].as_array() else {
        return false;
    };
    if !(2..=MAX_POINTS).contains(&points.len()) || points[0]["atMs"] != 0 {
        return false;
    }
    let mut previous = 0;
    points.iter().all(|point| {
        let Some(at) = point["atMs"].as_u64() else {
            return false;
        };
        let ordered = at >= previous && at <= MAX_DURATION_MS;
        previous = at;
        ordered
            && ["x", "y"].iter().all(|key| {
                point[key]
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && (0.0..=MAX_COORDINATE).contains(&n))
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{engine::validate, protocol::BrowserCommand};
    use serde_json::json;

    // 范围：拖动参数与写权限在派发前校验；不模拟浏览器或声称验证码已通过。
    #[test]
    fn drag_requires_bounded_ordered_points_and_write_permission() {
        let raw = json!({"type":"browser.input","action":"drag","points":[{"x":1.5,"y":2,"atMs":0},{"x":40,"y":2,"atMs":200}]});
        let command: BrowserCommand = serde_json::from_value(raw.clone()).unwrap();
        assert!(validate(&command, true).is_ok());
        assert!(validate(&command, false).is_err());
        for points in [
            Value::Null,
            json!([]),
            json!([{"x":1,"y":2,"atMs":0}]),
            json!([{"x":1,"y":2,"atMs":1},{"x":2,"y":2,"atMs":20}]),
            json!([{"x":1,"y":2,"atMs":0},{"x":2,"y":2,"atMs":8001}]),
            json!([{"x":1,"y":2,"atMs":0},{"x":2,"y":2,"atMs":10},{"x":3,"y":2,"atMs":5}]),
            json!([{"x":1,"y":2,"atMs":0},{"x":-1,"y":2,"atMs":20}]),
            json!([{"x":1,"y":2,"atMs":0},{"x":2,"atMs":20}]),
            json!(vec![json!({"x":1,"y":2,"atMs":0}); MAX_POINTS + 1]),
        ] {
            let mut invalid = raw.clone();
            invalid["points"] = points;
            assert!(!valid(&invalid), "{invalid}");
        }
    }
}
