use crate::error::{Fault, Result};

/// 未协商幅度的旧命令保留原值；新命令以 direction:pixels 表示有界 CSS 像素。
const LEGACY_DISTANCE: i32 = 400;
/// 单次滚动上限限制跳过内容的范围，调用者不能传任意整数。
const MAX_DISTANCE: i32 = 1200;

/// 同一解析器供主页面、嵌套容器及派发前校验使用，不接受脚本或额外分隔符。
pub fn parse(value: &str) -> Result<(&str, i32)> {
    let (direction, distance) = match value.split_once(':') {
        Some((direction, amount)) => {
            if amount.is_empty() || !amount.bytes().all(|b| b.is_ascii_digit()) {
                return Err(Fault::rejected(
                    "INVALID_ARGUMENT",
                    "invalid scroll distance",
                ));
            }
            let distance = amount
                .parse::<i32>()
                .map_err(|_| Fault::rejected("INVALID_ARGUMENT", "invalid scroll distance"))?;
            (direction, distance)
        }
        None => (value, LEGACY_DISTANCE),
    };
    if !["up", "down", "left", "right"].contains(&direction)
        || !(1..=MAX_DISTANCE).contains(&distance)
    {
        return Err(Fault::rejected(
            "INVALID_ARGUMENT",
            "invalid scroll direction or distance",
        ));
    }
    Ok((direction, distance))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 覆盖新旧滚动参数及有界解析，不代表真实浏览器移动距离验收。
    #[test]
    fn bounded_distance_and_legacy() {
        assert_eq!(parse("down").unwrap(), ("down", 400));
        assert_eq!(parse("up:720").unwrap(), ("up", 720));
        for value in [
            "down:0",
            "down:1201",
            "down:-1",
            "up:3:4",
            "up:+2",
            "left:1.5",
            "down:x",
            "other",
        ] {
            assert!(parse(value).is_err(), "{value}");
        }
    }
}
