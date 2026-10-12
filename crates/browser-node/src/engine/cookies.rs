//! 人工 Cookie 写入只生成固定 CDP 参数，值不进入 CLI 参数、脚本或结果摘要。
use crate::error::{Fault, Result};
use serde_json::{Value, json};

/// 清理请求最多删除二十个明确名字，不允许无界站点清空。
const MAX_CLEANUP_NAMES: usize = 20;
/// 与共享协议一致的 Cookie 名字长度上限。
const MAX_NAME_BYTES: usize = 256;

/// 规范化为 host-only 根路径会话 Cookie；不允许调用方指定 domain、文件或脚本。
pub(super) fn parameters(raw: &Value) -> Result<Value> {
    let reject = || Fault::rejected("INVALID_COOKIE", "invalid cookie parameters");
    let url = raw["url"]
        .as_str()
        .and_then(|s| reqwest::Url::parse(s).ok())
        .ok_or_else(reject)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(reject());
    }
    let name = raw["name"].as_str().ok_or_else(reject)?;
    let value = raw["value"].as_str().ok_or_else(reject)?;
    if name.is_empty()
        || name.len() > MAX_NAME_BYTES
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
        || value.len() > 4096
        || !value
            .bytes()
            .all(|b| matches!(b, 0x21 | 0x23..=0x2b | 0x2d..=0x3a | 0x3c..=0x5b | 0x5d..=0x7e))
    {
        return Err(reject());
    }
    let http_only = raw["httpOnly"].as_bool().ok_or_else(reject)?;
    if (name.starts_with("__Secure-") || name.starts_with("__Host-")) && url.scheme() != "https" {
        return Err(reject());
    }
    Ok(
        json!({"url":format!("{}/", url.origin().ascii_serialization()),"name":name,"value":value,"path":"/","secure":url.scheme()=="https","httpOnly":http_only,"sameSite":"Lax"}),
    )
}

/// 清理限制为一个 HTTP 站点的有限名字集合；不接受通配符、值或任意 CDP 参数。
pub(super) fn clear_parameters(raw: &Value) -> Result<Value> {
    let reject = || Fault::rejected("INVALID_COOKIE", "invalid cookie cleanup parameters");
    let url = raw["url"]
        .as_str()
        .and_then(|s| reqwest::Url::parse(s).ok())
        .ok_or_else(reject)?;
    let names = raw["names"].as_array().ok_or_else(reject)?;
    let valid_name = |v: &Value| {
        v.as_str().is_some_and(|n| {
            !n.is_empty()
                && n.len() <= MAX_NAME_BYTES
                && n != "*"
                && n.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
        })
    };
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || names.is_empty()
        || names.len() > MAX_CLEANUP_NAMES
        || !names.iter().all(valid_name)
    {
        return Err(reject());
    }
    Ok(json!({"host":url.host_str(),"names":names}))
}

#[cfg(test)]
mod tests {
    use super::*;
    // 范围：Cookie 参数约束及作用域；不代表真实站点接受该登录凭据。
    #[test]
    fn cookie_scope_and_validation() {
        let raw = json!({"url":"https://example.com/login?x=1","name":"token","value":"a=b","httpOnly":true});
        let params = parameters(&raw).unwrap();
        assert_eq!(params["url"], "https://example.com/");
        assert_eq!(params["path"], "/");
        assert_eq!(params["secure"], true);
        assert!(params.get("domain").is_none());
        for (key, bad) in [
            ("url", "file:///tmp/x"),
            ("url", "https://user@example.com/"),
            ("name", "a;b"),
            ("value", "x\r\ny"),
            ("value", "x;y"),
        ] {
            let mut invalid = raw.clone();
            invalid[key] = json!(bad);
            assert!(parameters(&invalid).is_err());
        }
    }
}
