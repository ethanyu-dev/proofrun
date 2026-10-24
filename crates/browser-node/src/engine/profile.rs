//! 身份来源的 Cookie 种子只用于当前临时浏览器，不保存任何基准。
use super::{Engine, cookies};
use crate::{
    auth,
    error::{Fault, Result},
    process,
};
use serde_json::{Value, json};

impl Engine {
    /// 注入前核对来源，注入后清理私有种子；业务资格由 setup 独立核验。
    pub(super) async fn prepare_profile(&mut self, raw: &Value, deadline: u64) -> Result<Value> {
        let url = raw["url"]
            .as_str()
            .ok_or_else(|| Fault::rejected("INVALID_IDENTITY", "测试地址无效"))?;
        self.cli(
            vec!["open".into(), url.into()],
            deadline.saturating_sub(process::boot_ms()),
        )
        .await?;
        let Some(path) = &self.config.identity_seed_file else {
            return Ok(
                json!({"status":"NEEDS_HUMAN","source":"none","reasonCode":"LOGIN_RECIPE_MISSING","saved":false}),
            );
        };
        auth::check_private_file(path, 1_048_576)
            .map_err(|_| Fault::rejected("IDENTITY_SEED_UNAVAILABLE", "身份 Cookie 不可用"))?;
        let seed: Value = serde_json::from_slice(
            &std::fs::read(path)
                .map_err(|_| Fault::rejected("IDENTITY_SEED_UNAVAILABLE", "身份 Cookie 不可用"))?,
        )
        .map_err(|_| Fault::rejected("IDENTITY_SEED_UNAVAILABLE", "身份 Cookie 不可用"))?;
        let origin = reqwest::Url::parse(url)
            .map_err(|_| Fault::rejected("INVALID_IDENTITY", "测试地址无效"))?
            .origin()
            .ascii_serialization();
        let seed_origin = seed["url"]
            .as_str()
            .and_then(|v| reqwest::Url::parse(v).ok())
            .map(|v| v.origin().ascii_serialization());
        if seed_origin.as_deref() != Some(&origin) {
            return Err(Fault::rejected(
                "IDENTITY_ORIGIN_MISMATCH",
                "身份不适用于当前站点",
            ));
        }
        let values = seed["cookies"]
            .as_array()
            .ok_or_else(|| Fault::rejected("IDENTITY_SEED_UNAVAILABLE", "身份 Cookie 不可用"))?;
        let (mut dom, target) = self.identity_dom(deadline).await?;
        // 种子只注入本次临时会话，不回写身份来源。
        dom.identity_clear(&target, &origin).await?;
        for value in values {
            let mut params = value.clone();
            params["url"] = json!(origin);
            dom.set_cookie(&target, cookies::parameters(&params)?)
                .await?;
        }
        self.cli(
            vec!["open".into(), url.into()],
            deadline.saturating_sub(process::boot_ms()),
        )
        .await?;
        let _ = std::fs::remove_file(path);
        self.observation = None;
        self.targets.clear();
        self.dom = None;
        self.visual = None;
        Ok(
            json!({"status":if values.is_empty() {"NEEDS_HUMAN"} else {"LOADED"},"source":if values.is_empty() {"none"} else {"cookies"},"reasonCode":if values.is_empty() {"LOGIN_RECIPE_MISSING"} else {"IDENTITY_COOKIES_LOADED"},"saved":false}),
        )
    }
}
