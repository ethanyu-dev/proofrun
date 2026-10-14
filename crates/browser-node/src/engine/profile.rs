//! 人工交还是唯一发布完整 profile 的入口；重启后清空旧观察并重建分组标签页。
use super::{Engine, cookies, dom::Dom};
use crate::{
    auth,
    error::{Fault, Result},
    process, profile_snapshots,
};
use serde_json::{Value, json};

/// 关闭后的进程协调文件应在短时间内消失，否则不复制仍可能写入的数据库。
const CLOSE_WAIT_MS: u64 = 5000;
/// 多次人工交接的 trace 分段总量有界，合并不能吞掉前段业务证据。
const TRACE_BYTES: u64 = 64 * 1024 * 1024;

impl Engine {
    /// 初始种子只用于新身份；已恢复的人工基准永不被旧 Cookie 覆盖。
    pub(super) async fn prepare_profile(&mut self, raw: &Value, deadline: u64) -> Result<Value> {
        let url = raw["url"]
            .as_str()
            .ok_or_else(|| Fault::rejected("INVALID_IDENTITY", "测试地址无效"))?;
        self.cli(
            vec!["open".into(), url.into()],
            deadline.saturating_sub(process::boot_ms()),
        )
        .await?;
        if self.profile_restored {
            return Ok(
                json!({"status":"LOADED","source":"profile","reasonCode":"IDENTITY_PROFILE_LOADED","saved":false}),
            );
        }
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
        let (mut dom, target) = self.identity_dom(deadline).await?;
        // 复制环境模板后先清除目标源身份状态，不能混用旧账号存储和新账号 Cookie。
        dom.identity_clear(&target, &origin).await?;
        let values = seed["cookies"]
            .as_array()
            .ok_or_else(|| Fault::rejected("IDENTITY_SEED_UNAVAILABLE", "身份 Cookie 不可用"))?;
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
        self.observation = None;
        self.targets.clear();
        self.dom = None;
        self.visual = None;
        Ok(
            json!({"status":if values.is_empty() {"NEEDS_HUMAN"} else {"LOADED"},"source":if values.is_empty() {"none"} else {"cookies"},"reasonCode":if values.is_empty() {"LOGIN_RECIPE_MISSING"} else {"IDENTITY_COOKIES_LOADED"},"saved":false}),
        )
    }

    /// 关闭浏览器后发布不可变副本，再恢复任务自身的 profile；不加载刚发布的另一份目录。
    pub(super) async fn save_profile(&mut self, timeout_ms: u64) -> Result<Value> {
        let deadline = process::boot_ms() + timeout_ms;
        let state = self
            .config
            .auth_state
            .clone()
            .ok_or_else(|| Fault::rejected("AUTH_STATE_MISSING", "身份基准未绑定"))?;
        let listed = self
            .cli(
                vec!["tab".into(), "list".into()],
                deadline.saturating_sub(process::boot_ms()),
            )
            .await?;
        let tabs = listed["tabs"]
            .as_array()
            .ok_or_else(|| Fault::rejected("PROFILE_TABS_UNAVAILABLE", "无法记录人工处理页面"))?;
        let active_url = tabs
            .iter()
            .find(|tab| tab["active"] == true)
            .and_then(|tab| tab["url"].as_str())
            .unwrap_or("about:blank")
            .to_owned();
        let scopes: Vec<(String, String)> = self
            .scopes
            .iter()
            .map(|(name, state)| {
                (
                    name.clone(),
                    tabs.iter()
                        .find(|tab| tab["tabId"].as_str() == Some(&state.tab_id))
                        .and_then(|tab| tab["url"].as_str())
                        .unwrap_or("about:blank")
                        .to_owned(),
                )
            })
            .collect();
        let active_scope = self.active_scope.clone();
        let traced = self.trace.is_some();
        if let Some(mut trace) = self.trace.take() {
            let path = self
                .config
                .directory
                .join("artifacts")
                .join(format!("{}.trace.json", uuid::Uuid::new_v4()));
            trace.trace_stop(&path).await?;
            self.trace_segments.push(path);
        }
        // Chromium 正常退出可能清理会话 Cookie；将其随同完整目录保存为同版本补充状态。
        let state_file = self
            .config
            .directory
            .join("profile")
            .join(".proofrun-session-state.json");
        self.cli(
            vec![
                "state".into(),
                "save".into(),
                state_file.to_string_lossy().into_owned(),
            ],
            deadline.saturating_sub(process::boot_ms()),
        )
        .await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&state_file, std::fs::Permissions::from_mode(0o600))
                .map_err(|_| Fault::rejected("PROFILE_SAVE_FAILED", "会话状态权限设置失败"))?;
        }
        auth::check_state(&state_file)
            .map_err(|_| Fault::rejected("PROFILE_SAVE_FAILED", "会话状态导出失败"))?;
        self.cli(
            vec!["close".into()],
            deadline.saturating_sub(process::boot_ms()),
        )
        .await?;
        let profile = self.config.directory.join("profile");
        let until = deadline.min(process::boot_ms() + CLOSE_WAIT_MS);
        while !profile_snapshots::quiescent(&profile) {
            if process::boot_ms() >= until {
                return Err(Fault::unknown(
                    "PROFILE_CLOSE_UNVERIFIED",
                    "浏览器尚未确认关闭，未发布基准",
                ));
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let saved = profile_snapshots::publish(&state, &profile, &mut self.auth_version)
            .map_err(|_| Fault::unknown("PROFILE_SAVE_FAILED", "完整浏览器基准保存结果未确认"))?;
        self.scopes.clear();
        self.networks.clear();
        self.active_scope = None;
        self.observation = None;
        self.targets.clear();
        self.dom = None;
        self.visual = None;
        self.tabs.clear();
        self.frame = None;
        self.open(deadline.saturating_sub(process::boot_ms()))
            .await?;
        for (name, url) in scopes {
            self.activate_scope(&name, deadline.saturating_sub(process::boot_ms()))
                .await?;
            self.cli(
                vec!["open".into(), url],
                deadline.saturating_sub(process::boot_ms()),
            )
            .await?;
        }
        if let Some(scope) = active_scope {
            self.activate_scope(&scope, deadline.saturating_sub(process::boot_ms()))
                .await?;
        } else {
            self.cli(
                vec!["open".into(), active_url],
                deadline.saturating_sub(process::boot_ms()),
            )
            .await?;
        }
        if traced {
            let endpoint = self
                .cli(
                    vec!["get".into(), "cdp-url".into()],
                    deadline.saturating_sub(process::boot_ms()),
                )
                .await?;
            let mut trace = Dom::connect(
                endpoint["cdpUrl"]
                    .as_str()
                    .ok_or_else(|| Fault::unknown("TRACE_UNAVAILABLE", "浏览器取证连接不可用"))?,
            )
            .await?;
            trace.trace_start().await?;
            self.trace = Some(trace);
        }
        Ok(
            json!({"saved":saved,"reason":if saved {"SAVED"} else {"NEWER_STATE_PRESERVED"},"profileRestarted":true}),
        )
    }

    /// 人工重启前后的 trace 保留分段边界；只合并事件，不宣称浏览器运行连续。
    pub(super) fn merge_trace_segments(&mut self, final_path: &std::path::Path) -> Result<()> {
        if self.trace_segments.is_empty() {
            return Ok(());
        }
        let mut events = Vec::new();
        let mut bytes = 0;
        let paths = self
            .trace_segments
            .iter()
            .map(|p| p.as_path())
            .chain(std::iter::once(final_path));
        for (index, path) in paths.enumerate() {
            let data = std::fs::read(path)
                .map_err(|_| Fault::rejected("TRACE_UNAVAILABLE", "取证分段不可读"))?;
            bytes += data.len() as u64;
            if bytes > TRACE_BYTES {
                return Err(Fault::rejected("TRACE_TOO_LARGE", "取证分段超过上限"));
            }
            let value: Value = serde_json::from_slice(&data)
                .map_err(|_| Fault::rejected("TRACE_UNAVAILABLE", "取证分段格式无效"))?;
            let segment = value
                .get("traceEvents")
                .and_then(Value::as_array)
                .or_else(|| value.as_array())
                .ok_or_else(|| Fault::rejected("TRACE_UNAVAILABLE", "取证分段缺少事件"))?;
            // 各浏览器重启后 PID 可能复用，增加分段元数据保留可识别边界。
            events.push(json!({"name":"proofrun.profile.segment","ph":"M","pid":0,"tid":0,"args":{"segment":index}}));
            events.extend(segment.iter().cloned());
        }
        std::fs::write(
            final_path,
            serde_json::to_vec(&json!({"traceEvents":events})).unwrap(),
        )
        .map_err(|_| Fault::unknown("TRACE_SAVE_FAILED", "取证分段写入失败"))?;
        self.trace_segments.clear();
        Ok(())
    }
}
