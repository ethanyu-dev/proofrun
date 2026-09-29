//! 截图暂存与交付。只有核对并持久化存储回执后，才宣布证据可用并删除本地文件。
use crate::{config::NodeConfig, store::Store};
use anyhow::{Context, Result, ensure};
use futures_util::StreamExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::Mutex;
/// 单张截图上限为 8 MiB，避免单个命令占满本地证据额度。
const MAX_FILE: u64 = 8 * 1024 * 1024;
/// 单份 Chromium trace 的独立上限，仍受整个 spool 总额度约束。
const MAX_TRACE: u64 = 64 * 1024 * 1024;
#[derive(Clone)]
/// 截图的本地 spool 和可靠上传器。
pub struct Artifacts {
    /// spool 容量、文件目录和上传入口。
    config: Arc<NodeConfig>,
    /// 截图与可用事件的持久记录。
    store: Store,
    /// 串行执行额度检查和文件登记，避免并发截图突破配额。
    lock: Arc<Mutex<()>>,
}
impl Artifacts {
    /// 绑定节点配置与持久记录，上传可在网关断线时独立重试。
    pub fn new(config: Arc<NodeConfig>, store: Store) -> Self {
        Self {
            config,
            store,
            lock: Arc::new(Mutex::new(())),
        }
    }
    /// 将 host 临时截图搬入受配额保护的 spool，并返回 PENDING 引用。
    pub async fn collect(
        &self,
        session_id: &str,
        command_id: &str,
        data: &mut Value,
    ) -> Result<()> {
        let trace = data.get("localTrace").is_some();
        let kind = if trace { "TRACE" } else { "SCREENSHOT" };
        let Some(path) = data.as_object_mut().and_then(|o| {
            o.remove(if trace {
                "localTrace"
            } else {
                "localScreenshot"
            })
        }) else {
            return Ok(());
        };
        let _guard = self.lock.lock().await;
        // 只接受节点会话目录中的文件，避免 host 路径进入任意本机文件。
        let source = std::fs::canonicalize(path.as_str().context("invalid screenshot path")?)?;
        let sessions = std::fs::canonicalize(self.config.home.join("sessions"))?;
        ensure!(
            source.starts_with(sessions),
            "screenshot outside owned session directory"
        );
        let metadata = std::fs::metadata(&source)?;
        ensure!(
            metadata.is_file() && metadata.len() <= if trace { MAX_TRACE } else { MAX_FILE },
            "screenshot exceeds limit"
        );
        let root = self.config.home.join("artifacts");
        std::fs::create_dir_all(&root)?;
        let used = std::fs::read_dir(&root)?
            .filter_map(|e| e.ok())
            .filter_map(|e| e.metadata().ok())
            .map(|m| m.len())
            .sum::<u64>();
        ensure!(
            used + metadata.len() <= self.config.artifact_limit_bytes,
            "ARTIFACT_QUOTA"
        );
        let bytes = tokio::fs::read(&source).await?;
        if trace {
            let value: Value = serde_json::from_slice(&bytes)?;
            ensure!(value["traceEvents"].is_array(), "invalid trace format");
        } else {
            ensure!(
                bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
                "invalid screenshot format"
            );
        }
        let hash = hex::encode(Sha256::digest(&bytes));
        let id = uuid::Uuid::new_v4().to_string();
        let target = root.join(&id);
        let temporary = root.join(format!("{id}.tmp"));
        // 先 fsync 文件和目录，再把引用提交到 SQLite；重启后不会指向未落盘文件。
        tokio::fs::write(&temporary, &bytes).await?;
        std::fs::File::open(&temporary)?.sync_all()?;
        tokio::fs::rename(&temporary, &target).await?;
        std::fs::File::open(&root)?.sync_all()?;
        let row = (
            id.clone(),
            session_id.to_owned(),
            command_id.to_owned(),
            hash.clone(),
            target.to_string_lossy().into_owned(),
        );
        self.store
            .call(move |db| {
                db.execute(
                    "INSERT INTO artifacts(id,session_id,command_id,hash,path,kind) VALUES(?,?,?,?,?,?)",
                    rusqlite::params![row.0, row.1, row.2, row.3, row.4, kind],
                )?;
                Ok(())
            })
            .await?;
        let _ = tokio::fs::remove_file(source).await;
        data["artifactRefs"] =
            json!([{"artifactId":id,"kind":kind,"sha256":hash,"status":"PENDING"}]);
        Ok(())
    }
    /// 上传待处理文件；只有核对持久化回执后才提交 AVAILABLE 并删除本地副本。
    pub async fn upload_pending(&self, client: &reqwest::Client, token: &str) -> Result<()> {
        let Some(endpoint) = &self.config.artifact_upload_url else {
            return Ok(());
        };
        let rows: Vec<(String, String, String, String)> = self
            .store
            .call(|db| {
                let mut q = db
                    .prepare("SELECT id,hash,path,kind FROM artifacts WHERE available=0 LIMIT 8")?;
                Ok(
                    q.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                        .collect::<rusqlite::Result<_>>()?,
                )
            })
            .await?;
        for (id, hash, path, kind) in rows {
            let file = tokio::fs::File::open(&path).await?;
            let length = file.metadata().await?.len();
            let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(file));
            let response = client
                .put(format!("{}/{id}", endpoint.trim_end_matches('/')))
                .bearer_auth(token)
                .header(
                    "Content-Type",
                    if kind == "TRACE" {
                        "application/vnd.proofrun.trace+json"
                    } else {
                        "image/png"
                    },
                )
                .header("Content-Length", length)
                .header("X-Content-Sha256", &hash)
                .body(body)
                .send()
                .await?
                .error_for_status()?;
            let mut stream = response.bytes_stream();
            let mut bytes = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk?;
                ensure!(
                    bytes.len() + chunk.len() <= 8192,
                    "oversized upload receipt"
                );
                bytes.extend_from_slice(&chunk);
            }
            let receipt: Value = serde_json::from_slice(&bytes)?;
            ensure!(
                receipt["artifactId"] == id
                    && receipt["sha256"] == hash
                    && receipt["stored"] == true,
                "invalid storage receipt"
            );
            self.store
                .call(move |db| {
                    let tx = db.transaction()?;
                    tx.execute("UPDATE artifacts SET available=1 WHERE id=?", [&id])?;
                    let event = json!({
                        "type": "artifact.available", "messageId": format!("artifact:{id}"),
                        "artifactId": id, "sha256": hash
                    });
                    tx.execute(
                        "INSERT OR IGNORE INTO outbox VALUES(?,?)",
                        rusqlite::params![format!("artifact:{id}"), event.to_string()],
                    )?;
                    tx.commit()?;
                    Ok(())
                })
                .await?;
            // 存储回执已持久化，此时才允许回收本地文件。
            tokio::fs::remove_file(path).await?;
        }
        Ok(())
    }
}
/// 目录所有权守卫；不向调用方暴露可复制的锁句柄。
pub struct HomeLock {
    /// 持有实际文件锁，守卫释放时显式解锁而不等待重复句柄关闭。
    file: std::fs::File,
}
impl Drop for HomeLock {
    /// 子进程启动可能短暂继承文件描述符；所有权不能因此延长到后代退出。
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.file);
    }
}
/// 独占节点数据目录，阻止两个主进程同时管理同一批会话和 SQLite 文件。
pub fn lock_home(home: &Path) -> Result<HomeLock> {
    use fs2::FileExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(home.join("node.lock"))?;
    file.try_lock_exclusive()
        .context("another node owns this home")?;
    Ok(HomeLock { file })
}
/// 读取或原子创建持久节点身份，写入后 fsync 以供崩溃恢复。
pub fn installation_id(home: &Path) -> Result<String> {
    let path = home.join("node-id");
    if path.exists() {
        let id = std::fs::read_to_string(path)?;
        uuid::Uuid::parse_str(id.trim())?;
        return Ok(id.trim().into());
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    file.write_all(id.as_bytes())?;
    file.sync_all()?;
    std::fs::File::open(home)?.sync_all()?;
    Ok(id)
}
/// 用随机 launch_id 定位本次会话的私有目录。
pub fn session_directory(config: &NodeConfig, launch_id: &str) -> PathBuf {
    config.home.join("sessions").join(launch_id)
}

#[cfg(test)]
mod tests {
    use super::lock_home;

    /// 验证范围：存在重复句柄时，释放锁守卫仍归还目录所有权。
    /// 用真实 dup 句柄复现继承效果，不模拟 fork 调度、主机重启或网络文件系统。
    #[test]
    fn home_lock_release_does_not_wait_for_duplicate_handle() {
        let home = tempfile::tempdir().unwrap();
        let owner = lock_home(home.path()).unwrap();
        let duplicate = owner.file.try_clone().unwrap();
        drop(owner);
        let next = lock_home(home.path()).expect("released owner must allow the next supervisor");
        assert!(lock_home(home.path()).is_err());
        drop(duplicate);
        drop(next);
    }
}

#[cfg(test)]
mod trace_tests {
    use super::*;

    /// 验证范围：真实文件及 SQLite 的 TRACE 类型、摘要和 PENDING 登记；不模拟 Chromium 采集或远端上传。
    #[tokio::test]
    async fn trace_spool_persists_kind_and_rejects_invalid_json() {
        let home = tempfile::tempdir().unwrap();
        let config = Arc::new(NodeConfig {
            home: home.path().to_owned(),
            ..NodeConfig::default()
        });
        let store = Store::open(&home.path().join("node.db")).unwrap();
        let collector = Artifacts::new(config, store.clone());
        let session = home.path().join("sessions/test");
        std::fs::create_dir_all(&session).unwrap();
        let path = session.join("trace.json");
        let bytes = br#"{"traceEvents":[{"name":"fixture","ph":"I","ts":1}]}"#;
        std::fs::write(&path, bytes).unwrap();
        let mut data = json!({"localTrace":path});
        collector
            .collect("session", "command", &mut data)
            .await
            .unwrap();
        assert!(data.get("localTrace").is_none());
        assert_eq!(data["artifactRefs"][0]["kind"], "TRACE");
        assert_eq!(
            data["artifactRefs"][0]["sha256"],
            hex::encode(Sha256::digest(bytes))
        );
        assert_eq!(data["artifactRefs"][0]["status"], "PENDING");
        let kind: String = store
            .call(|db| Ok(db.query_row("SELECT kind FROM artifacts", [], |row| row.get(0))?))
            .await
            .unwrap();
        assert_eq!(kind, "TRACE");
        std::fs::write(&path, br#"{"other":[]}"#).unwrap();
        assert!(
            collector
                .collect("session", "bad", &mut json!({"localTrace":path}))
                .await
                .is_err()
        );
    }
}
