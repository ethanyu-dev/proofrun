//! 停机维护与跨主机重启恢复；所有入口先独占节点目录，不与主服务并发修改账本。
use crate::{
    artifacts,
    config::NodeConfig,
    engine, process,
    store::{SessionRecord, Store},
};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use std::{
    fs,
    time::{Duration, SystemTime},
};

/// 保留窗口至少一天，避免刚关闭的会话还在交付结果时清理数据。
const DAY_SECONDS: u64 = 86_400;

/// 只接受真实主机重启且旧随机 unit 不活动的情况，不提供同一启动周期的强制解锁。
pub async fn recover_reboot(config: &NodeConfig) -> Result<Value> {
    let _lock = artifacts::lock_home(&config.home)?;
    let store = Store::open(&config.home.join("node.db"))?;
    let boot = process::boot_id()?;
    let records = store.sessions().await?;
    for record in &records {
        ensure!(
            record.boot_id != boot,
            "same-boot session requires cgroup cleanup, not reboot recovery"
        );
        let info = process::unit_info(&record.unit).await?;
        ensure!(
            info.get("LoadState").map(String::as_str) == Some("not-found")
                || matches!(
                    info.get("ActiveState").map(String::as_str),
                    Some("inactive" | "failed")
                ),
            "old session unit is still active"
        );
    }
    let count = records.len();
    for mut record in records {
        record.state = "CLOSED".into();
        store.save_session(record).await?;
    }
    store.recover_commands().await?;
    Ok(json!({"recovered":count,"replayed":false,"bootId":boot}))
}

/// 仅清理已关闭且所有结果已确认的旧目录；轻量身份墓碑永久保留以阻止迟到重放。
pub async fn retain(config: &NodeConfig, days: u64, apply: bool) -> Result<Value> {
    ensure!((1..=3650).contains(&days), "retention days out of range");
    let _lock = artifacts::lock_home(&config.home)?;
    let store = Store::open(&config.home.join("node.db"))?;
    let records: Vec<SessionRecord> = store.call(|db| {
        let mut statement = db.prepare("SELECT record FROM sessions s WHERE state='CLOSED' AND NOT EXISTS(SELECT 1 FROM outbox WHERE json_extract(payload,'$.sessionId')=s.id) AND NOT EXISTS(SELECT 1 FROM artifacts WHERE session_id=s.id AND available=0)")?;
        statement.query_map([], |row| row.get::<_,String>(0))?.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }).await?;
    let mut cleaned = Vec::new();
    for record in records {
        // launch_id 必须是本机生成的 UUID，不能将损坏账本中的任意路径交给递归删除。
        ensure!(
            record.launch_id.len() == 32 && record.launch_id.bytes().all(|b| b.is_ascii_hexdigit()),
            "invalid launch identity"
        );
        let path = config.home.join("sessions").join(&record.launch_id);
        let info = match fs::symlink_metadata(&path) {
            Ok(info) => info,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        ensure!(
            info.is_dir() && !info.file_type().is_symlink(),
            "session directory is not a plain directory"
        );
        if SystemTime::now()
            .duration_since(info.modified()?)
            .unwrap_or_default()
            < Duration::from_secs(days * DAY_SECONDS)
        {
            continue;
        }
        if apply {
            fs::remove_dir_all(path)?;
            let socket = engine::socket_directory(&record.launch_id);
            if socket.exists() {
                fs::remove_dir_all(socket)?;
            }
            let id = record.session_id.clone();
            store.call(move |db| {
                db.execute("UPDATE commands SET result=json_remove(result,'$.data') WHERE json_extract(meta,'$.sessionId')=?", [&id])?;
                db.execute("DELETE FROM artifacts WHERE session_id=? AND available=1", [&id])?;
                Ok(())
            }).await?;
        }
        cleaned.push(record.session_id);
    }
    Ok(
        json!({"applied":apply,"sessions":cleaned,"retained":"identities, deduplication results and authentication states"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    /// 范围：维护必须等待关闭事件确认，清理保留身份墓碑；不模拟系统重启或真实 cgroup。
    #[tokio::test]
    async fn retains_unacknowledged_sessions_and_deduplication() {
        let root = tempfile::tempdir().unwrap();
        let config = NodeConfig {
            home: root.path().to_path_buf(),
            ..Default::default()
        };
        let store = Store::open(&root.path().join("node.db")).unwrap();
        let record = SessionRecord {
            session_id: "test-session".into(),
            unit: "fixture".into(),
            boot_id: "old-boot".into(),
            cgroup: None,
            invocation: None,
            state: "ACTIVE".into(),
            launch_id: uuid::Uuid::new_v4().simple().to_string(),
            lease_id: "fixture-lease".into(),
            fence: 1,
            node_epoch: "fixture-epoch".into(),
        };
        store.reserve(record.clone(), 1).await.unwrap();
        let path = root.path().join("sessions").join(&record.launch_id);
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("profile-data"), "private").unwrap();
        fs::File::open(&path)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(3 * DAY_SECONDS))
            .unwrap();
        let mut closed = record.clone();
        closed.state = "CLOSED".into();
        store.save_session(closed).await.unwrap();
        assert!(
            retain(&config, 1, true).await.unwrap()["sessions"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(path.exists());
        store
            .ack("session:test-session:CLOSED".into())
            .await
            .unwrap();
        assert_eq!(
            retain(&config, 1, false).await.unwrap()["sessions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(path.exists());
        retain(&config, 1, true).await.unwrap();
        assert!(!path.exists());
        assert!(store.reserve(record, 1).await.is_err());
    }
}
