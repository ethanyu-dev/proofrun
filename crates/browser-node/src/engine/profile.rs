//! 模板维护只在人工完成后发布；普通验证任务始终使用独立副本。
use super::{Engine, socket_directory};
use crate::{
    auth,
    error::{Fault, Result},
    process, profiles,
};
use serde_json::{Value, json};

/// 保存前必须等待浏览器及 daemon 释放文件，不能复制活动数据库。
const CLOSE_WAIT_MS: u64 = 10_000;
const DAEMON_FILES: &[&str] = &[
    "sock",
    "port",
    "pid",
    "version",
    "stream",
    "engine",
    "provider",
    "extensions",
];
/// 会话 Cookie 补充文件的大小有界，内容不进入公开回执。
const STATE_BYTES: u64 = 8 * 1024 * 1024;

impl Engine {
    /// 在第一次打开浏览器前复制完整模板；模板不存在时保持空白事实。
    pub(super) async fn restore_default_profile(&mut self, deadline: u64) -> Result<()> {
        if let Some(root) = &self.config.default_profile_root {
            self.template_version =
                profiles::restore(root, &self.config.directory.join("profile"), deadline)
                    .await
                    .map_err(|_| Fault::rejected("PROFILE_COPY_FAILED", "节点默认模板复制失败"))?;
        }
        Ok(())
    }

    /// 完整磁盘副本补回关闭时被 Chromium 丢弃的会话 Cookie，不把材料返回给控制面。
    pub(super) async fn restore_session_cookies(&self, deadline: u64) -> Result<()> {
        if self.template_version.is_none() {
            return Ok(());
        }
        let path = self
            .config
            .directory
            .join("profile")
            .join(profiles::SESSION_STATE);
        auth::check_private_file(&path, STATE_BYTES)
            .map_err(|_| Fault::rejected("PROFILE_STATE_INVALID", "模板会话状态缺失或损坏"))?;
        self.cli(
            vec![
                "state".into(),
                "load".into(),
                path.to_string_lossy().into_owned(),
            ],
            deadline.saturating_sub(process::boot_ms()),
        )
        .await?;
        Ok(())
    }

    /// 仅维护会话允许发布；关闭与发布完成后不重启该浏览器，等待控制面回收会话。
    pub(super) async fn publish_default_profile(&mut self, timeout_ms: u64) -> Result<Value> {
        if !self.config.profile_maintenance || self.config.external_account.is_some() {
            return Err(Fault::rejected(
                "PROFILE_PUBLISH_FORBIDDEN",
                "只有节点维护会话可以发布默认模板",
            ));
        }
        let root = self
            .config
            .default_profile_root
            .as_ref()
            .ok_or_else(|| Fault::rejected("PROFILE_PUBLISH_FORBIDDEN", "模板存储未绑定"))?;
        let deadline = process::boot_ms() + timeout_ms;
        let profile = self.config.directory.join("profile");
        let state = profile.join(profiles::SESSION_STATE);
        self.cli(
            vec![
                "state".into(),
                "save".into(),
                state.to_string_lossy().into_owned(),
            ],
            deadline.saturating_sub(process::boot_ms()),
        )
        .await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o600))
                .map_err(|_| Fault::rejected("PROFILE_SAVE_FAILED", "无法设置模板材料权限"))?;
        }
        auth::check_private_file(&state, STATE_BYTES)
            .map_err(|_| Fault::rejected("PROFILE_SAVE_FAILED", "模板材料导出失败"))?;
        self.cli(
            vec!["close".into()],
            deadline.saturating_sub(process::boot_ms()),
        )
        .await?;
        let close_deadline = deadline.min(process::boot_ms() + CLOSE_WAIT_MS);
        loop {
            let absent = |path| matches!(std::fs::symlink_metadata(path), Err(e) if e.kind() == std::io::ErrorKind::NotFound);
            if absent(profile.join("SingletonLock"))
                && DAEMON_FILES.iter().all(|ext| {
                    absent(
                        socket_directory(&self.config.session)
                            .join(format!("{}.{ext}", self.config.session)),
                    )
                })
            {
                break;
            }
            if process::boot_ms() >= close_deadline {
                return Err(Fault::unknown(
                    "PROFILE_CLOSE_UNVERIFIED",
                    "浏览器关闭未确认，模板未发布",
                ));
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let version = profiles::publish(
            root,
            &profile,
            self.template_version.as_ref().map(|v| v.version.as_str()),
            &self.config.profile_owner,
            deadline,
        )
        .await
        .map_err(|_| Fault::unknown("PROFILE_SAVE_FAILED", "模板发布结果未确认，请查询节点状态"))?;
        Ok(json!({"profile":version,"saved":true}))
    }
}
