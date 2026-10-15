//! 完整磁盘 profile 使用不可变版本；只复制已关闭的浏览器，任务副本从不自动回写。
use anyhow::{Result, ensure};
use fs2::FileExt;
use std::{
    fs,
    path::{Path, PathBuf},
};

/// 单份基准的大小与文件数有界，避免异常站点把快照复制变成无界工作。
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_FILES: usize = 100_000;
/// 进程协调文件不属于可复用状态，禁止把旧锁、调试端口复制进新会话。
const RUNTIME_FILES: &[&str] = &[
    "SingletonLock",
    "SingletonSocket",
    "SingletonCookie",
    "DevToolsActivePort",
];

/// 快照中的路径只由内部 UUID 或摘要生成，不允许外部构造目录穿越。
fn safe_id(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
        "invalid profile version"
    );
    Ok(())
}
/// 基准与任务目录均为节点私有目录；拒绝符号链接根目录。
fn private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    ensure!(
        fs::symlink_metadata(path)?.is_dir(),
        "invalid profile directory"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
/// Chrome 正常退出会移除 SingletonLock；未确认关闭时不能复制数据库文件。
pub fn quiescent(path: &Path) -> bool {
    matches!(fs::symlink_metadata(path.join("SingletonLock")), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
}
/// 复制全部持久文件，不选择性丢弃 IndexedDB、扩展或站点配置；拒绝链接和特殊设备。
pub fn copy_closed(source: &Path, destination: &Path) -> Result<()> {
    ensure!(quiescent(source), "profile is still running");
    ensure!(
        fs::symlink_metadata(source)?.is_dir(),
        "invalid profile source"
    );
    let mut bytes = 0;
    let mut files = 0;
    copy_tree(source, destination, &mut bytes, &mut files, true)
}
/// 递归复制在同一总额度内累计大小和条目，不跟随目录中的链接。
fn copy_tree(
    source: &Path,
    destination: &Path,
    bytes: &mut u64,
    files: &mut usize,
    root: bool,
) -> Result<()> {
    private_dir(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if root && RUNTIME_FILES.iter().any(|name| entry.file_name() == *name) {
            continue;
        }
        *files += 1;
        ensure!(*files <= MAX_FILES, "profile file limit exceeded");
        let meta = fs::symlink_metadata(entry.path())?;
        let target = destination.join(entry.file_name());
        if meta.is_dir() {
            copy_tree(&entry.path(), &target, bytes, files, false)?;
        } else {
            ensure!(
                meta.is_file(),
                "profile contains unsupported link or special file"
            );
            *bytes += meta.len();
            ensure!(*bytes <= MAX_BYTES, "profile size limit exceeded");
            fs::copy(entry.path(), &target)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&target, fs::Permissions::from_mode(0o600))?;
            }
            fs::File::open(&target)?.sync_all()?;
        }
    }
    fs::File::open(destination)?.sync_all()?;
    Ok(())
}
/// 完整目录基准与旧 JSON 登录快照使用不同后缀，避免互相覆盖。
fn root(state: &Path) -> PathBuf {
    state.with_extension("profile")
}
/// 文件锁跨会话进程保护版本指针及轮次固定记录。
fn lock(root: &Path) -> Result<fs::File> {
    private_dir(root)?;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("lock"))?;
    file.lock_exclusive()?;
    Ok(file)
}
/// 只读取私有且有界的版本指针，内容不允许成为任意路径。
fn current(root: &Path) -> Result<Option<String>> {
    let path = root.join("current.json");
    if !path.exists() {
        return Ok(None);
    }
    crate::auth::check_private_file(&path, 1024)?;
    let version: Option<String> = serde_json::from_slice(&fs::read(path)?)?;
    if let Some(ref value) = version {
        safe_id(value)?;
    }
    Ok(version)
}
/// 同轮次固定同一初始版本，包括“没有基准”；另一组不能读取本轮 HITL 刚发布的状态。
pub fn restore(
    state: &Path,
    round: Option<&str>,
    destination: &Path,
    base: Option<&Path>,
) -> Result<Option<String>> {
    let root = root(state);
    let _lock = lock(&root)?;
    let version = if let Some(round) = round {
        safe_id(round)?;
        let pin = root.join(format!("round-{round}.json"));
        if pin.exists() {
            crate::auth::check_private_file(&pin, 1024)?;
            serde_json::from_slice::<Option<String>>(&fs::read(pin)?)?
        } else {
            let version = current(&root)?;
            crate::auth::private_write(&pin, &serde_json::to_vec(&version)?)?;
            version
        }
    } else {
        current(&root)?
    };
    ensure!(!destination.exists(), "task profile already exists");
    if let Some(ref version) = version {
        safe_id(version)?;
        copy_closed(&root.join(version), destination)?;
    } else if let Some(base) = base {
        copy_closed(base, destination)?;
    } else {
        private_dir(destination)?;
    }
    Ok(version)
}
/// 发布先写完整不可变目录，再原子替换指针；旧任务版本不允许覆盖新人工基准。
pub fn publish(state: &Path, source: &Path, expected: &mut Option<String>) -> Result<bool> {
    let root = root(state);
    let _lock = lock(&root)?;
    if current(&root)? != *expected {
        return Ok(false);
    }
    let version = uuid::Uuid::new_v4().to_string();
    let staging = root.join(format!("pending-{version}"));
    if let Err(error) = copy_closed(source, &staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    fs::rename(&staging, root.join(&version))?;
    let pointer = root.join(format!("pointer-{version}.json"));
    crate::auth::private_write(&pointer, &serde_json::to_vec(&Some(&version))?)?;
    fs::rename(pointer, root.join("current.json"))?;
    fs::File::open(&root)?.sync_all()?;
    *expected = Some(version);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    /// 范围：完整目录复制、同轮版本固定、任务修改隔离和并发人工 CAS；不代表真实浏览器登录验收。
    #[test]
    fn profiles_are_immutable_and_pinned() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("identity.json");
        let first = dir.path().join("task-one");
        let mut version = restore(&state, Some("pair"), &first, None).unwrap();
        fs::create_dir(first.join("Default")).unwrap();
        fs::write(first.join("Default/IndexedDB"), "human-state").unwrap();
        assert!(publish(&state, &first, &mut version).unwrap());
        let second = dir.path().join("task-two");
        assert!(
            restore(&state, Some("pair"), &second, None)
                .unwrap()
                .is_none()
        );
        assert!(!second.join("Default/IndexedDB").exists());
        assert!(!publish(&state, &second, &mut None).unwrap());
        let third = dir.path().join("task-three");
        assert_eq!(
            restore(&state, Some("next"), &third, None).unwrap(),
            version
        );
        fs::write(third.join("Default/IndexedDB"), "business-change").unwrap();
        let fourth = dir.path().join("task-four");
        restore(&state, None, &fourth, None).unwrap();
        assert_eq!(
            fs::read_to_string(fourth.join("Default/IndexedDB")).unwrap(),
            "human-state"
        );
    }
    /// 范围：活动浏览器标记和链接拒绝，不覆盖操作系统崩溃或跨机器迁移。
    #[test]
    fn reject_live_profile_and_links() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("SingletonLock"), "running").unwrap();
        assert!(copy_closed(&source, &dir.path().join("copy")).is_err());
        fs::remove_file(source.join("SingletonLock")).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/tmp", source.join("escape")).unwrap();
            assert!(copy_closed(&source, &dir.path().join("copy")).is_err());
        }
    }
}
