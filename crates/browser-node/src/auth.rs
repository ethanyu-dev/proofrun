//! 节点身份材料的私有文件读写，不维护跨执行登录快照。
use anyhow::{Result, ensure};
use std::{fs, path::Path};

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
pub(crate) fn check_private_file(path: &Path, limit: u64) -> Result<()> {
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
