//! 登录准备只使用封闭配方；秘密只在节点内存和私有 CDP 通道中流动。
use super::{Engine, cookies, dom::Dom};
use crate::{
    auth,
    error::{Fault, Result},
    process,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path};

/// 私有配置的总上限，拒绝把大型响应或任意文档作为凭据库加载。
const LIBRARY_BYTES: u64 = 1024 * 1024;
/// 页面就绪最多等待五秒；需要挑战或人工审批时保留 HITL。
const PROBE_MS: u64 = 5000;

/// 配方只允许明确的站点和固定字段；禁止任意脚本。
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Profile {
    /// 唯一允许写入登录凭据的源，包含协议和端口。
    origin: String,
    /// Cookie 与密码登录采用不同封闭结构。
    login: Login,
}
/// 私密值不能派生 Debug，也不能作为错误上下文输出。
#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields, rename_all = "camelCase")]
enum Login {
    Cookies {
        /// 最多三十二个 host-only Cookie，不携带任意域名或存储脚本。
        cookies: Vec<Cookie>,
    },
    Password {
        /// 账号密码只能填写到同源登录页。
        url: String,
        /// 用户名输入框的固定 CSS 选择器。
        #[serde(rename = "usernameSelector")]
        username_selector: String,
        /// 必须命中原生 password input。
        #[serde(rename = "passwordSelector")]
        password_selector: String,
        /// 提交后可见的成功标记，出现前不导航离开表单。
        #[serde(rename = "successSelector")]
        success_selector: String,
        /// 已批准的提交控件，不允许模型寻找替代目标。
        #[serde(rename = "submitSelector")]
        submit_selector: String,
        /// 私密账号字符串，仅作为 CDP 参数传入页面。
        username: String,
        /// 私密密码，不能记录到 Debug、命令回执或证据。
        password: String,
    },
}
/// Cookie 限定为 host-only 根路径，不允许配置扩大域名范围。
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Cookie {
    /// HTTP Cookie 名称。
    name: String,
    /// 私密 Cookie 值，只发送到其配置的源。
    value: String,
    /// 是否禁止页面脚本读取，沿用管理员提供的 Cookie 属性。
    http_only: bool,
}
/// 节点本机配置按引用查找；原始内容不返回控制面。
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Library {
    /// 本地配方优先于外部提供方。
    #[serde(default)]
    profiles: HashMap<String, Profile>,
    /// 外部凭据只由节点获取；不会经过 API 或 Agent。
    provider: Option<Provider>,
}
/// 管理员配置的固定接口，不接受模型或任务传入 URL。
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Provider {
    /// 固定的 HTTPS 接口，回环 HTTP 仅供本机集成。
    url: String,
    /// 节点私有 Bearer 文件，按请求读取以支持令牌轮换。
    token_file: std::path::PathBuf,
}

/// 所有配置故障只返回固定错误，不泄露 JSON 原文或解析片段。
fn unavailable() -> Fault {
    Fault::rejected("IDENTITY_LIBRARY_UNAVAILABLE", "测试身份配方不可用")
}
/// 从本地库或固定 HTTPS 接口读取同一种配方；不跟随重定向，不缓存原始凭据。
async fn obtain_profile(path: &Path, key: &str, origin: &str) -> Result<Profile> {
    auth::check_private_file(path, LIBRARY_BYTES).map_err(|_| unavailable())?;
    let mut library: Library =
        serde_json::from_slice(&std::fs::read(path).map_err(|_| unavailable())?)
            .map_err(|_| unavailable())?;
    let profile = if let Some(profile) = library.profiles.remove(key) {
        profile
    } else {
        let provider = library.provider.ok_or_else(unavailable)?;
        let url = reqwest::Url::parse(&provider.url).map_err(|_| unavailable())?;
        if !(url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"))))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(unavailable());
        }
        auth::check_private_file(&provider.token_file, 8192).map_err(|_| unavailable())?;
        let token = std::fs::read_to_string(&provider.token_file).map_err(|_| unavailable())?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|_| unavailable())?;
        let mut response = client
            .post(url)
            .bearer_auth(token.trim())
            .json(&json!({"profileRef":key,"origin":origin}))
            .send()
            .await
            .map_err(|_| unavailable())?;
        if !response.status().is_success() {
            return Err(unavailable());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
            if bytes.len() + chunk.len() > LIBRARY_BYTES as usize {
                return Err(unavailable());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| unavailable())?
    };
    validate_profile(&profile, origin)?;
    Ok(profile)
}
/// 即使配置受信任，仍拒绝跨源登录及无界字段；错误不携带秘密。
fn validate_profile(profile: &Profile, origin: &str) -> Result<()> {
    if profile.origin != origin {
        return Err(unavailable());
    }
    match &profile.login {
        Login::Cookies { cookies: values } => {
            if values.is_empty() || values.len() > 32 {
                return Err(unavailable());
            }
            for c in values {
                cookies::parameters(
                    &json!({"url":origin,"name":c.name,"value":c.value,"httpOnly":c.http_only}),
                )
                .map_err(|_| unavailable())?;
            }
        }
        Login::Password {
            url,
            username_selector,
            password_selector,
            submit_selector,
            success_selector,
            username,
            password,
        } => {
            let url = reqwest::Url::parse(url).map_err(|_| unavailable())?;
            if url.origin().ascii_serialization() != origin
                || !url.username().is_empty()
                || url.password().is_some()
                || [
                    username_selector,
                    password_selector,
                    submit_selector,
                    success_selector,
                ]
                .iter()
                .any(|v| v.is_empty() || v.len() > 500)
                || [username, password]
                    .iter()
                    .any(|v| v.is_empty() || v.len() > 4096)
            {
                return Err(unavailable());
            }
        }
    }
    Ok(())
}

impl Engine {
    /// 获取当前页的私有连接；任何导航后都重新取 active target，避免旧 target 写入。
    async fn identity_dom(&self, deadline: u64) -> Result<(Dom, String)> {
        let endpoint = self
            .cli(
                vec!["get".into(), "cdp-url".into()],
                deadline.saturating_sub(process::boot_ms()),
            )
            .await?;
        let listed = self
            .cli(
                vec!["tab".into(), "list".into()],
                deadline.saturating_sub(process::boot_ms()),
            )
            .await?;
        let target = listed["tabs"]
            .as_array()
            .and_then(|tabs| tabs.iter().find(|v| v["active"] == true))
            .and_then(|v| v["targetId"].as_str())
            .ok_or_else(unavailable)?
            .to_owned();
        Ok((
            Dom::connect(endpoint["cdpUrl"].as_str().ok_or_else(unavailable)?).await?,
            target,
        ))
    }
    /// 只把布尔核验结果返回编排层；不会生成包含登录字段的截图或 DOM 证据。
    async fn probe_identity(&self, origin: &str, checks: &Value, deadline: u64) -> Result<bool> {
        let until = deadline.min(process::boot_ms() + PROBE_MS);
        loop {
            let (mut dom, target) = self.identity_dom(deadline).await?;
            if dom.identity_probe(&target, origin, checks).await? {
                return Ok(true);
            }
            if process::boot_ms() >= until {
                return Ok(false);
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
    }
    /// 首先核验恢复状态，失败后最多执行一次登录；结果不明不能自动重放提交。
    pub(super) async fn prepare_identity(&mut self, raw: &Value, deadline: u64) -> Result<Value> {
        if self.trace.is_some() {
            return Err(Fault::rejected(
                "IDENTITY_TRACE_ACTIVE",
                "登录准备必须在业务取证前执行",
            ));
        }
        let url =
            reqwest::Url::parse(raw["url"].as_str().unwrap_or("")).map_err(|_| unavailable())?;
        if !matches!(url.scheme(), "https" | "http")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(unavailable());
        }
        let origin = url.origin().ascii_serialization();
        self.observation = None;
        self.targets.clear();
        self.dom = None;
        self.visual = None;
        self.cli(
            vec!["open".into(), url.to_string()],
            deadline.saturating_sub(process::boot_ms()),
        )
        .await?;
        if self
            .probe_identity(&origin, &raw["checks"], deadline)
            .await?
        {
            return Ok(
                json!({"status":if raw["saveSnapshot"]==true {"READY"} else {"NEEDS_HUMAN"},"source":"snapshot","reasonCode":if raw["saveSnapshot"]==true {"IDENTITY_VERIFIED"} else {"IDENTITY_MANUAL_CHECK_REQUIRED"},"saved":false}),
            );
        }
        if let Some(path) = &self.config.auth_state {
            auth::invalidate_if_current(path, &mut self.auth_version).map_err(|_| unavailable())?;
        }
        let Some(key) = raw["profileRef"].as_str() else {
            return Ok(
                json!({"status":"NEEDS_HUMAN","source":"none","reasonCode":"LOGIN_RECIPE_MISSING"}),
            );
        };
        let Some(path) = &self.config.identity_library_file else {
            return Ok(
                json!({"status":"NEEDS_HUMAN","source":"none","reasonCode":"LOGIN_RECIPE_MISSING"}),
            );
        };
        let profile = match obtain_profile(path, key, &origin).await {
            Ok(v) => v,
            Err(_) => {
                return Ok(
                    json!({"status":"NEEDS_HUMAN","source":"none","reasonCode":"LOGIN_RECIPE_UNAVAILABLE"}),
                );
            }
        };
        // 清除当前身份源的浏览器存储后才注入，避免旧 localStorage 与新 Cookie 混用。
        let (mut dom, target) = self.identity_dom(deadline).await?;
        dom.identity_clear(&target, &origin).await?;
        let source = match &profile.login {
            Login::Cookies { cookies: values } => {
                for c in values {
                    dom.set_cookie(&target,cookies::parameters(&json!({"url":origin,"name":c.name,"value":c.value,"httpOnly":c.http_only}))?).await?;
                }
                "cookies"
            }
            Login::Password {
                url,
                username_selector,
                password_selector,
                submit_selector,
                success_selector,
                username,
                password,
            } => {
                self.cli(
                    vec!["open".into(), url.clone()],
                    deadline.saturating_sub(process::boot_ms()),
                )
                .await?;
                let recipe = json!({"usernameSelector":username_selector,"passwordSelector":password_selector,"submitSelector":submit_selector,"username":username,"password":password});
                let (mut dom, target) = self.identity_dom(deadline).await?;
                if !dom.identity_login(&target, &origin, &recipe, false).await? {
                    let _ = dom.identity_login(&target, &origin, &recipe, true).await?;
                    return Ok(
                        json!({"status":"NEEDS_HUMAN","source":"password","reasonCode":"LOGIN_FORM_MISMATCH"}),
                    );
                }
                // 配置的成功标记出现前不导航，避免取消异步提交；人工挑战保留原页面。
                let until = deadline.min(process::boot_ms() + PROBE_MS);
                let completed = loop {
                    let (mut dom, target) = self.identity_dom(deadline).await?;
                    if dom
                        .identity_ready(&target, &origin, success_selector)
                        .await?
                    {
                        break true;
                    }
                    if process::boot_ms() >= until {
                        break false;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                };
                let (mut dom, target) = self.identity_dom(deadline).await?;
                let _ = dom.identity_login(&target, &origin, &recipe, true).await?;
                if !completed {
                    return Ok(
                        json!({"status":"NEEDS_HUMAN","source":"password","reasonCode":"LOGIN_CHALLENGE_OR_REJECTED"}),
                    );
                }
                "password"
            }
        };
        self.cli(
            vec!["open".into(), url.to_string()],
            deadline.saturating_sub(process::boot_ms()),
        )
        .await?;
        let ready = self
            .probe_identity(&origin, &raw["checks"], deadline)
            .await?;
        let saved = if ready && raw["saveSnapshot"] == true && self.config.auth_state.is_some() {
            self.save_auth(deadline.saturating_sub(process::boot_ms()))
                .await?["saved"]
                == true
        } else {
            false
        };
        Ok(
            json!({"status":if ready && raw["saveSnapshot"]==true {"READY"} else {"NEEDS_HUMAN"},"source":source,"reasonCode":if !ready {"IDENTITY_CHECK_UNMET"} else if raw["saveSnapshot"]==true {"IDENTITY_VERIFIED"} else {"IDENTITY_MANUAL_CHECK_REQUIRED"},"saved":saved}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// 范围：私有文件权限、固定域名、配方边界及错误脱敏；不证明生产站点可登录。
    #[tokio::test]
    async fn private_recipe_scope() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("identities.json");
        auth::private_write(&path,br#"{"profiles":{"user":{"origin":"https://example.com","login":{"type":"cookies","cookies":[{"name":"session","value":"fixture-secret","httpOnly":true}]}}}}"#).unwrap();
        assert!(
            obtain_profile(&path, "user", "https://example.com")
                .await
                .is_ok()
        );
        assert!(
            obtain_profile(&path, "user", "https://example.com.evil")
                .await
                .is_err()
        );
        assert!(
            !obtain_profile(&path, "missing", "https://example.com")
                .await
                .err()
                .unwrap()
                .message
                .contains("fixture-secret")
        );
        let wrong:Profile=serde_json::from_value(json!({"origin":"https://example.com","login":{"type":"password","url":"https://evil.test/login","usernameSelector":"#u","passwordSelector":"#p","submitSelector":"button","successSelector":"#ready","username":"u","password":"p"}})).unwrap();
        assert!(validate_profile(&wrong, "https://example.com").is_err());
    }
}
