//! 登录状态留在节点私有目录；每个执行使用独立 profile，只有人工确认才更新共享状态。
use anyhow::{Result, ensure};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// 登录快照只包含存储状态，超过此值拒绝载入，避免无界文件读取。
const MAX_STATE_BYTES: u64 = 8 * 1024 * 1024;
/// 轮次快照保留时间超过任务最长 24 小时，清理不能影响仍活动的任务。
const SNAPSHOT_RETENTION_SECONDS: u64 = 48 * 60 * 60;

/// 状态名是封闭标识，不允许路径穿越或跨目录访问。
pub fn state_path(home: &Path, id: &str) -> Result<PathBuf> {
    ensure!(
        !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'),
        "invalid state identity"
    );
    Ok(home.join("auth").join(format!("{id}.json")))
}
/// 目录只允许节点运行用户访问，不跟随登录目录符号链接。
pub fn prepare_parent(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("missing parent"))?;
    fs::create_dir_all(parent)?;
    ensure!(
        !fs::symlink_metadata(parent)?.file_type().is_symlink(),
        "auth directory cannot be a symlink"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
/// 只读取普通、有大小上限且结构完整的存储状态，不在错误中输出其内容。
pub fn check_state(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path)?;
    ensure!(
        meta.file_type().is_file() && meta.len() <= MAX_STATE_BYTES,
        "invalid state file"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            meta.permissions().mode() & 0o077 == 0,
            "state file must be private"
        );
    }
    let value: serde_json::Value = serde_json::from_slice(&fs::read(path)?)?;
    ensure!(
        value["cookies"].is_array() && value["origins"].is_array(),
        "invalid storage state"
    );
    Ok(())
}
/// 临时快照校验和落盘后原子替换；写失败不会先清除上一次有效登录状态。
pub fn commit(temporary: &Path, destination: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(temporary, fs::Permissions::from_mode(0o600))?;
    }
    check_state(temporary)?;
    fs::File::open(temporary)?.sync_all()?;
    fs::rename(temporary, destination)?;
    fs::File::open(destination.parent().unwrap())?.sync_all()?;
    Ok(())
}
/// 导入由运维准备的状态；调用者必须独占节点 home，避免与活动会话并发替换。
pub fn import(home: &Path, id: &str, source: &Path) -> Result<()> {
    check_state(source)?;
    let destination = state_path(home, id)?;
    prepare_parent(&destination)?;
    let temporary = destination.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    fs::copy(source, &temporary)?;
    let result = commit(&temporary, &destination);
    let _ = fs::remove_file(temporary);
    result
}

/// 同轮两组共享的初始内容和版本；空状态也要固定，避免第二组读到第一组刚保存的登录。
#[derive(Clone, Serialize, Deserialize)]
pub struct Snapshot {
    /// 启动时共享槽位的内容摘要，用于阻止旧会话覆盖后续更新。
    pub version: Option<String>,
    /// 只供节点内恢复使用，绝不写入报告或控制面。
    pub state: Option<serde_json::Value>,
}

/// 槽位锁跨 session-host 进程生效；只在短暂文件事务中持有，不跨浏览器命令等待。
fn lock(path: &Path) -> Result<fs::File> {
    prepare_parent(path)?;
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path.with_extension("lock"))?;
    file.lock_exclusive()?;
    Ok(file)
}

/// 缺失与损坏明确区分；自动复用仅允许缺失，不能忽略损坏或权限异常。
fn current(path: &Path) -> Result<Snapshot> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Snapshot {
            version: None,
            state: None,
        }),
        Err(error) => Err(error.into()),
        Ok(_) => {
            check_state(path)?;
            let bytes = fs::read(path)?;
            Ok(Snapshot {
                version: Some(hex::encode(Sha256::digest(&bytes))),
                state: Some(serde_json::from_slice(&bytes)?),
            })
        }
    }
}

/// 同一轮固定一次初始状态；保存共享槽位后也不会改变另一组尚未启动的初始状态。
pub fn snapshot(path: &Path, identity: Option<&str>) -> Result<Snapshot> {
    let _guard = lock(path)?;
    let Some(identity) = identity else {
        return current(path);
    };
    let directory = path.with_extension("snapshots");
    // 复用封闭标识校验，不把外部身份当作任意路径。
    let destination = state_path(&directory, identity)?;
    prepare_parent(&destination)?;
    if destination.try_exists()? {
        check_private_file(&destination, MAX_STATE_BYTES * 2)?;
        return Ok(serde_json::from_slice(&fs::read(destination)?)?);
    }
    let initial = current(path)?;
    let temporary = destination.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    private_write(&temporary, &serde_json::to_vec(&initial)?)?;
    fs::rename(&temporary, &destination)?;
    fs::File::open(destination.parent().unwrap())?.sync_all()?;
    // 最长任务为 24 小时，48 小时之外的轮次文件已不可能被活动任务使用。
    for entry in fs::read_dir(destination.parent().unwrap())? {
        let entry = entry?;
        if entry.file_type()?.is_file()
            && entry
                .metadata()?
                .modified()?
                .elapsed()
                .unwrap_or_default()
                .as_secs()
                > SNAPSHOT_RETENTION_SECONDS
        {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(initial)
}

/// 快照文件只允许节点用户读取，写入成功后同步内容。
pub fn private_write(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

/// 只接受节点私有、有界的普通文件，避免把异常路径作为快照读取。
fn check_private_file(path: &Path, limit: u64) -> Result<()> {
    let meta = fs::symlink_metadata(path)?;
    ensure!(
        meta.is_file() && meta.len() <= limit,
        "invalid snapshot file"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            meta.permissions().mode() & 0o077 == 0,
            "snapshot must be private"
        );
    }
    Ok(())
}

/// 保存时比较启动版本；另一会话已更新则保留新状态，并清除本次临时文件。
/// 成功保存后更新本会话版本，允许同一人工处理过程再次明确保存。
pub fn commit_if_current(
    temporary: &Path,
    destination: &Path,
    version: &mut Option<String>,
) -> Result<bool> {
    let _guard = lock(destination)?;
    if current(destination)?.version != *version {
        let _ = fs::remove_file(temporary);
        return Ok(false);
    }
    commit(temporary, destination)?;
    *version = current(destination)?.version;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    /// 范围：并行启动固定空快照、首次保存和旧版本拒绝覆盖；不证明真实站点登录有效。
    #[test]
    fn shared_snapshot_and_compare_before_save() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_path(dir.path(), "account").unwrap();
        let first = snapshot(&state, Some("pair")).unwrap();
        assert!(first.state.is_none());
        let temporary = dir.path().join("first.json");
        private_write(
            &temporary,
            br#"{"cookies":[],"origins":[],"fixture":"first"}"#,
        )
        .unwrap();
        let mut version = first.version.clone();
        assert!(commit_if_current(&temporary, &state, &mut version).unwrap());
        let second = snapshot(&state, Some("pair")).unwrap();
        assert!(second.state.is_none());
        assert!(second.version.is_none());
        let temporary = dir.path().join("second.json");
        private_write(
            &temporary,
            br#"{"cookies":[],"origins":[],"fixture":"second"}"#,
        )
        .unwrap();
        assert!(!commit_if_current(&temporary, &state, &mut second.version.clone()).unwrap());
        assert!(!temporary.exists());
        let next = snapshot(&state, Some("next-pair")).unwrap();
        assert_eq!(next.state.unwrap()["fixture"], "first");
        assert_eq!(next.version, version);
        assert!(snapshot(&state, Some("../invalid")).is_err());
    }

    /// 范围：已有快照在同轮内保持不变、同一会话可再次保存及损坏文件拒绝；不覆盖浏览器导出。
    #[test]
    fn pinned_existing_state_and_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_path(dir.path(), "account").unwrap();
        prepare_parent(&state).unwrap();
        private_write(
            &state,
            br#"{"cookies":[],"origins":[],"fixture":"original"}"#,
        )
        .unwrap();
        let original = snapshot(&state, Some("pair")).unwrap();
        let mut version = original.version.clone();
        for name in ["updated", "updated-again"] {
            let temporary = dir.path().join(name);
            private_write(
                &temporary,
                serde_json::to_string(
                    &serde_json::json!({"cookies":[],"origins":[],"fixture":name}),
                )
                .unwrap()
                .as_bytes(),
            )
            .unwrap();
            assert!(commit_if_current(&temporary, &state, &mut version).unwrap());
        }
        assert_eq!(
            snapshot(&state, Some("pair")).unwrap().state.unwrap()["fixture"],
            "original"
        );
        assert_eq!(
            snapshot(&state, Some("next")).unwrap().state.unwrap()["fixture"],
            "updated-again"
        );
        fs::write(&state, "broken").unwrap();
        assert!(snapshot(&state, Some("broken")).is_err());
    }
    /// 范围：路径、私有权限和原子快照；不证明业务登录仍有效。
    #[test]
    fn private_state_import() {
        let dir = tempfile::tempdir().unwrap();
        assert!(state_path(dir.path(), "../other").is_err());
        let file = dir.path().join("source.json");
        fs::write(&file, br#"{"cookies":[],"origins":[]}"#).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        }
        import(dir.path(), "account", &file).unwrap();
        let destination = state_path(dir.path(), "account").unwrap();
        check_state(&destination).unwrap();
        fs::write(&file, "invalid").unwrap();
        assert!(import(dir.path(), "account", &file).is_err());
        check_state(&destination).unwrap();
    }
}
