//! 网络证据仅保留请求元数据，不导出认证头、Cookie、请求体或响应体。
use crate::error::{Fault, Result};
use serde_json::{Value, json};

/// 每次观察只交付最近的有界请求列表，截断必须在证据中明确记录。
const MAX_REQUESTS: usize = 100;
/// URL 路径可能含业务标识，只限制长度；查询参数和片段始终删除。
const MAX_URL_CHARS: usize = 2048;

/// 规范化固定引擎的请求列表；字段缺失时不编造状态码或业务成功。
pub fn sanitize(value: &Value) -> Result<Value> {
    let requests = value["requests"]
        .as_array()
        .ok_or_else(|| Fault::unknown("NETWORK_PROTOCOL", "network request list missing"))?;
    let items: Vec<Value> = requests.iter().rev().take(MAX_REQUESTS).rev().map(|entry| {
        let url = entry["url"].as_str().and_then(|value| reqwest::Url::parse(value).ok()).filter(|url| matches!(url.scheme(), "http" | "https")).map(|mut url| {
            let _ = url.set_username(""); let _ = url.set_password(None); url.set_query(None); url.set_fragment(None);
            url.as_str().chars().take(MAX_URL_CHARS).collect::<String>()
        });
        json!({"url":url,"method":entry["method"].as_str().unwrap_or("").chars().take(16).collect::<String>(),"status":entry["status"].as_i64(),"resourceType":entry["resourceType"].as_str().unwrap_or("").chars().take(64).collect::<String>(),"timestamp":entry["timestamp"].as_u64()})
    }).collect();
    Ok(
        json!({"requests":items,"truncated":requests.len()>MAX_REQUESTS,"scope":"since_previous_observation","redacted":true,"complete":false}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    /// 范围：网络记录脱敏和截断；不模拟浏览器捕获完整性或服务端提交次数。
    #[test]
    fn excludes_credentials_and_bounds_requests() {
        let entry = json!({"url":"https://user:password@example.com/order?token=secret#secret","method":"POST","headers":{"Authorization":"secret"},"postData":"secret","status":201});
        let result = sanitize(&json!({"requests":vec![entry;101]})).unwrap();
        assert_eq!(result["requests"].as_array().unwrap().len(), 100);
        assert_eq!(result["truncated"], true);
        assert_eq!(result["requests"][0]["url"], "https://example.com/order");
        assert!(!result.to_string().contains("secret"));
        assert!(!result.to_string().contains("password"));
    }
}
