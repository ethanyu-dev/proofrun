//! 清理通过 CDP 精确删除；值只在节点内存里短暂存在，不进入日志或结果。
use super::*;

impl Dom {
    /// 枚举当前隔离浏览器上下文，按精确域名、名字和路径删除，再回读确认。
    pub async fn clear_cookies(&mut self, target: &str, params: &Value) -> Result<()> {
        let session = self.attach(target).await?;
        let host = params["host"].as_str().ok_or_else(fault)?;
        let names = params["names"].as_array().ok_or_else(fault)?;
        let matches = |cookie: &Value| {
            cookie["domain"]
                .as_str()
                .is_some_and(|domain| domain.trim_start_matches('.') == host)
                && names.contains(&cookie["name"])
        };
        let before = self
            .call(Some(&session), "Storage.getCookies", json!({}))
            .await?;
        let cookies = before["cookies"].as_array().ok_or_else(fault)?;
        for cookie in cookies.iter().filter(|cookie| matches(cookie)) {
            let mut delete =
                json!({"name":cookie["name"],"domain":cookie["domain"],"path":cookie["path"]});
            if let Some(key) = cookie.get("partitionKey") {
                delete["partitionKey"] = key.clone();
            }
            self.call(Some(&session), "Network.deleteCookies", delete)
                .await?;
        }
        let after = self
            .call(Some(&session), "Storage.getCookies", json!({}))
            .await?;
        if after["cookies"]
            .as_array()
            .ok_or_else(fault)?
            .iter()
            .any(matches)
        {
            return Err(Fault::unknown(
                "COOKIE_CLEANUP_UNVERIFIED",
                "cookie cleanup could not be verified",
            ));
        }
        Ok(())
    }
}
