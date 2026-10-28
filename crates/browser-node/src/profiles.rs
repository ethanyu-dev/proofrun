//! 节点默认模板保存为不可变版本；发布与复制共用文件锁，任务副本永不回写。
use anyhow::{Result, ensure};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tokio::fs;

/// 单份模板的复制上限，防止站点缓存无限扩大启动工作量。
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_FILES: usize = 100_000;
/// Chromium 运行协调文件不可复制到新会话。
const RUNTIME_FILES: &[&str] = &[
    "SingletonLock",
    "SingletonCookie",
    "SingletonSocket",
    "DevToolsActivePort",
];
/// 关闭前导出的会话 Cookie 补充文件，随整个模板一同发布。
pub const SESSION_STATE: &str = ".proofrun-session-state.json";

/// 仅公开版本和发布来源，不包含站点或登录材料。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileVersion {
    /// 不可变目录的内部 UUID。
    pub version: String,
    /// 节点确认发布的时间。
    pub updated_at: String,
    /// 用于在回执丢失时核对原维护会话。
    pub session_id: String,
}

/// 指针通过原子替换更新；心跳读取只会看到完整的新版本或旧版本。
pub fn current(root: &Path) -> Result<Option<ProfileVersion>> {
    let path = root.join("current.json");
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    crate::auth::check_private_file(&path, 4096)?;
    let value: ProfileVersion = serde_json::from_slice(&std::fs::read(path)?)?;
    ensure!(
        uuid::Uuid::parse_str(&value.version).is_ok(),
        "invalid profile version"
    );
    ensure!(value.session_id.len() <= 128, "invalid profile owner");
    Ok(Some(value))
}

/// 所有模板和副本目录只对节点用户开放，拒绝符号链接。
async fn private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path).await?;
    ensure!(
        fs::symlink_metadata(path).await?.is_dir(),
        "invalid profile directory"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await?;
    }
    Ok(())
}

/// 异步等待跨 host 文件锁，租约守卫可随时取消等待。
async fn lock(root: &Path, deadline: u64) -> Result<std::fs::File> {
    private_dir(root).await?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("lock"))?;
    loop {
        ensure!(
            crate::process::boot_ms() < deadline,
            "profile operation expired"
        );
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(file),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await
            }
            Err(e) => return Err(e.into()),
        }
    }
}

/// 递归复制普通文件；每次异步 I/O 之间检查期限，不跟随链接或复制进程锁。
fn copy_tree<'a>(
    source: &'a Path,
    destination: &'a Path,
    bytes: &'a mut u64,
    files: &'a mut usize,
    deadline: u64,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
    Box::pin(async move {
        ensure!(
            fs::symlink_metadata(source).await?.is_dir(),
            "invalid profile source"
        );
        private_dir(destination).await?;
        let mut entries = fs::read_dir(source).await?;
        while let Some(entry) = entries.next_entry().await? {
            ensure!(
                crate::process::boot_ms() < deadline,
                "profile operation expired"
            );
            if RUNTIME_FILES.iter().any(|name| entry.file_name() == *name) {
                continue;
            }
            *files += 1;
            ensure!(*files <= MAX_FILES, "profile file limit exceeded");
            let meta = fs::symlink_metadata(entry.path()).await?;
            let target = destination.join(entry.file_name());
            if meta.is_dir() {
                copy_tree(&entry.path(), &target, bytes, files, deadline).await?;
            } else {
                ensure!(meta.is_file(), "profile contains link or special file");
                *bytes += meta.len();
                ensure!(*bytes <= MAX_BYTES, "profile size limit exceeded");
                fs::copy(entry.path(), &target).await?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).await?;
                }
                fs::File::open(&target).await?.sync_all().await?;
            }
        }
        fs::File::open(destination).await?.sync_all().await?;
        Ok(())
    })
}

/// 固定当前版本后复制，首次未初始化创建空白目录；损坏模板不得静默降级。
pub async fn restore(
    root: &Path,
    destination: &Path,
    deadline: u64,
) -> Result<Option<ProfileVersion>> {
    let _lock = lock(root, deadline).await?;
    ensure!(!destination.try_exists()?, "profile already initialized");
    let version = current(root)?;
    if let Some(version) = &version {
        copy_tree(
            &root.join(&version.version),
            destination,
            &mut 0,
            &mut 0,
            deadline,
        )
        .await?;
    } else {
        private_dir(destination).await?;
    }
    Ok(version)
}

/// 发布前回收未完成暂存和更旧版本；持锁复制者已完成，现有任务仅依赖自己的副本。
async fn prune(root: &Path, keep: Option<&str>, deadline: u64) -> Result<()> {
    let mut entries = fs::read_dir(root).await?;
    while let Some(entry) = entries.next_entry().await? {
        ensure!(
            crate::process::boot_ms() < deadline,
            "profile cleanup expired"
        );
        let name = entry.file_name().to_string_lossy().into_owned();
        if Some(name.as_str()) == keep {
            continue;
        }
        let pending = name
            .strip_prefix("pending-")
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok());
        let version = uuid::Uuid::parse_str(&name).is_ok();
        let pointer = name
            .strip_prefix("pointer-")
            .and_then(|id| id.strip_suffix(".json"))
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok());
        if pending || version {
            ensure!(
                fs::symlink_metadata(entry.path()).await?.is_dir(),
                "invalid profile staging directory"
            );
            fs::remove_dir_all(entry.path()).await?;
        } else if pointer {
            fs::remove_file(entry.path()).await?;
        }
    }
    Ok(())
}

/// 完整副本落盘后校验基准版本，再原子切换指针；相同发布会话重试只返回原版本。
pub async fn publish(
    root: &Path,
    source: &Path,
    expected: Option<&str>,
    session_id: &str,
    deadline: u64,
) -> Result<ProfileVersion> {
    let _lock = lock(root, deadline).await?;
    let previous = current(root)?;
    if let Some(value) = &previous
        && value.session_id == session_id
    {
        return Ok(value.clone());
    }
    ensure!(
        previous.as_ref().map(|v| v.version.as_str()) == expected,
        "profile version changed"
    );
    ensure!(
        matches!(std::fs::symlink_metadata(source.join("SingletonLock")), Err(e) if e.kind() == std::io::ErrorKind::NotFound),
        "browser still owns profile"
    );
    prune(
        root,
        previous.as_ref().map(|v| v.version.as_str()),
        deadline,
    )
    .await?;
    let version = uuid::Uuid::new_v4().to_string();
    let staging = root.join(format!("pending-{version}"));
    copy_tree(source, &staging, &mut 0, &mut 0, deadline).await?;
    ensure!(
        crate::process::boot_ms() < deadline,
        "profile publication expired"
    );
    fs::rename(&staging, root.join(&version)).await?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as i64;
    let value = ProfileVersion {
        version,
        updated_at: chrono::DateTime::from_timestamp_millis(timestamp)
            .unwrap()
            .to_rfc3339(),
        session_id: session_id.into(),
    };
    // 指针写入及替换没有异步取消间隙；只在最后一次期限检查后进行短小原子提交。
    let pointer = root.join(format!("pointer-{}.json", value.version));
    ensure!(
        crate::process::boot_ms() < deadline,
        "profile publication expired"
    );
    crate::auth::private_write(&pointer, &serde_json::to_vec(&value)?)?;
    std::fs::rename(pointer, root.join("current.json"))?;
    std::fs::File::open(root)?.sync_all()?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    // 范围：真实文件复制验证新旧版本和任务写入隔离；不启动浏览器或证明网站登录。
    #[tokio::test]
    async fn versions_are_isolated_and_publication_is_idempotent() {
        let root = tempfile::tempdir().unwrap();
        let store = root.path().join("store");
        let source = root.path().join("maintenance");
        let deadline = crate::process::boot_ms() + 10_000;
        assert!(restore(&store, &source, deadline).await.unwrap().is_none());
        fs::write(source.join("Cookies"), "first").await.unwrap();
        let first = publish(&store, &source, None, "one", deadline)
            .await
            .unwrap();
        let a = root.path().join("a");
        restore(&store, &a, deadline).await.unwrap();
        fs::write(a.join("Cookies"), "task-only").await.unwrap();
        fs::write(source.join("Cookies"), "second").await.unwrap();
        let second = publish(&store, &source, Some(&first.version), "two", deadline)
            .await
            .unwrap();
        assert_eq!(
            publish(&store, &source, Some(&first.version), "two", deadline)
                .await
                .unwrap()
                .version,
            second.version
        );
        assert!(
            publish(&store, &source, Some(&first.version), "stale", deadline)
                .await
                .is_err()
        );
        let b = root.path().join("b");
        restore(&store, &b, deadline).await.unwrap();
        assert_eq!(
            fs::read_to_string(b.join("Cookies")).await.unwrap(),
            "second"
        );
        assert_eq!(
            fs::read_to_string(a.join("Cookies")).await.unwrap(),
            "task-only"
        );
    }
    // 范围：失败复制保留旧指针，活跃锁及符号链接不能发布；不证明真实 Chrome 退出。
    #[tokio::test]
    async fn failed_or_live_profile_never_replaces_current() {
        let root = tempfile::tempdir().unwrap();
        let store = root.path().join("store");
        let source = root.path().join("maintenance");
        let deadline = crate::process::boot_ms() + 10_000;
        restore(&store, &source, deadline).await.unwrap();
        fs::write(source.join("SingletonLock"), "busy")
            .await
            .unwrap();
        assert!(
            publish(&store, &source, None, "one", deadline)
                .await
                .is_err()
        );
        assert!(current(&store).unwrap().is_none());
        fs::remove_file(source.join("SingletonLock")).await.unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/passwd", source.join("linked")).unwrap();
            assert!(
                publish(&store, &source, None, "one", deadline)
                    .await
                    .is_err()
            );
            assert!(current(&store).unwrap().is_none());
        }
    }
}
