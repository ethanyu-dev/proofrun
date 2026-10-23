//! 外部材料在空白会话中通过私有 CDP 注入；原始值不进入 CLI、脚本或证据回执。
use super::Engine;
use crate::{
    auth,
    error::{Fault, Result},
};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    time::{SystemTime, UNIX_EPOCH},
};

/// 与 DevPass 原始材料契约一致的数量和体积限制。
const MAX_COOKIES: usize = 64;
const MAX_MATERIAL_BYTES: u64 = 65_536;

/// 保留完整 Cookie 语义；不设置 domain，避免 host-only 被转换成域 Cookie。
fn parameters(origin: &str, cookie: &Value, now: f64) -> Result<Value> {
    let invalid = || Fault::rejected("INVALID_EXTERNAL_COOKIE", "外部 Cookie 属性或来源无效");
    let url = reqwest::Url::parse(origin).map_err(|_| invalid())?;
    let name = cookie["name"].as_str().ok_or_else(invalid)?;
    let value = cookie["value"].as_str().ok_or_else(invalid)?;
    let path = cookie["path"].as_str().ok_or_else(invalid)?;
    let secure = cookie["secure"].as_bool().ok_or_else(invalid)?;
    let http_only = cookie["http_only"].as_bool().ok_or_else(invalid)?;
    let same_site = cookie["same_site"].as_str().ok_or_else(invalid)?;
    if !matches!(url.scheme(), "https" | "http")
        || url.origin().ascii_serialization() != origin
        || cookie["domain"].as_str() != url.host_str()
        || cookie["host_only"] != true
        || name.is_empty()
        || name.len() > 256
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
        || value.len() > 16384
        || value
            .bytes()
            .any(|b| b <= 0x20 || b == 0x7f || b == b';' || b == b',')
        || !path.starts_with('/')
        || path.len() > 2048
        || path.bytes().any(|b| b < 0x20 || b == 0x7f || b == b';')
        || !matches!(same_site, "Strict" | "Lax" | "None")
        || (secure && url.scheme() != "https")
        || ((same_site == "None" || name.starts_with("__Secure-") || name.starts_with("__Host-"))
            && !secure)
        || (name.starts_with("__Host-") && path != "/")
    {
        return Err(invalid());
    }
    let mut params = json!({"url":format!("{origin}/"),"name":name,"value":value,"path":path,"secure":secure,"httpOnly":http_only,"sameSite":same_site});
    if !cookie["expires_at"].is_null() {
        let expires = chrono::DateTime::parse_from_rfc3339(
            cookie["expires_at"].as_str().ok_or_else(invalid)?,
        )
        .map_err(|_| invalid())?
        .timestamp_millis() as f64
            / 1000.0;
        if expires <= now {
            return Err(Fault::rejected(
                "EXTERNAL_COOKIE_EXPIRED",
                "外部 Cookie 已过期",
            ));
        }
        params["expires"] = json!(expires);
    }
    Ok(params)
}

impl Engine {
    /// 只在会话初始空白页注入一次，实际登录条件仍由执行 Agent 观察核实。
    pub(super) async fn prepare_external_account(&mut self, deadline: u64) -> Result<()> {
        let account = self.config.external_account.as_ref().unwrap();
        let origin = account["origin"]
            .as_str()
            .ok_or_else(|| Fault::rejected("INVALID_EXTERNAL_ACCOUNT", "外部来源无效"))?;
        let path = self
            .config
            .identity_seed_file
            .as_ref()
            .ok_or_else(|| Fault::rejected("EXTERNAL_MATERIAL_MISSING", "外部材料缺失"))?
            .clone();
        let invalid = || Fault::rejected("EXTERNAL_MATERIAL_INVALID", "外部材料文件无效");
        auth::check_private_file(&path, MAX_MATERIAL_BYTES + 64).map_err(|_| invalid())?;
        let material: Value = serde_json::from_slice(&std::fs::read(&path).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
        let cookies = material["cookies"]
            .as_array()
            .filter(|c| !c.is_empty() && c.len() <= MAX_COOKIES)
            .ok_or_else(invalid)?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| invalid())?
            .as_secs_f64();
        let params = cookies
            .iter()
            .map(|c| parameters(origin, c, now))
            .collect::<Result<Vec<_>>>()?;
        let mut keys = HashSet::new();
        for p in &params {
            if !keys.insert((p["name"].as_str(), p["path"].as_str())) {
                return Err(invalid());
            }
        }
        let (mut dom, target) = self.identity_dom(deadline).await?;
        for p in params {
            dom.set_cookie(&target, p).await?;
        }
        // 材料已进入当前浏览器后即移除私密文件，后续恢复不能重新使用旧种子。
        std::fs::remove_file(path).map_err(|_| invalid())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// 覆盖完整 Cookie 属性和 host-only 映射；不证明真实平台接受此材料。
    #[test]
    fn preserves_cookie_attributes() {
        let c = json!({"name":"token","value":"fixture","domain":"example.test","host_only":true,"path":"/admin","secure":true,"http_only":true,"same_site":"Strict","expires_at":"2030-01-01T00:00:00Z"});
        let p = parameters("https://example.test", &c, 0.0).unwrap();
        assert_eq!(p["path"], "/admin");
        assert_eq!(p["sameSite"], "Strict");
        assert_eq!(p["httpOnly"], true);
        assert_eq!(p["expires"], 1893456000.0);
        assert!(p.get("domain").is_none());
        for (key, value) in [
            ("domain", json!("evil.test")),
            ("host_only", json!(false)),
            ("secure", json!(false)),
            ("expires_at", json!("1970-01-01T00:00:01Z")),
        ] {
            let mut invalid = c.clone();
            invalid[key] = value;
            if key == "secure" {
                invalid["same_site"] = json!("None");
            }
            assert!(parameters("https://example.test", &invalid, 2.0).is_err());
        }
    }
    /// 覆盖会话 Cookie 不伪造到期时间以及前缀约束；不覆盖 CDP 实际注入。
    #[test]
    fn session_cookie_and_host_prefix() {
        let mut c = json!({"name":"__Host-token","value":"fixture","domain":"example.test","host_only":true,"path":"/","secure":true,"http_only":false,"same_site":"None","expires_at":null});
        assert!(
            parameters("https://example.test", &c, 0.0)
                .unwrap()
                .get("expires")
                .is_none()
        );
        c["path"] = json!("/admin");
        assert!(parameters("https://example.test", &c, 0.0).is_err());
    }
}
