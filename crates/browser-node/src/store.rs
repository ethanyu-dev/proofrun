//! SQLite 恢复账本。专用线程独占数据库连接，并在浏览器派发前记录命令意图。
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use tokio::sync::{mpsc, oneshot};

/// 投递给 SQLite 专用线程的短事务，不跨浏览器或网络 I/O 持有连接。
type Job = Box<dyn FnOnce(&mut Connection) + Send>;
#[derive(Clone)]
/// 数据库访问句柄；所有副本共享同一个 SQLite 工作线程。
pub struct Store {
    /// 有界任务通道，限制数据库积压对主服务的影响。
    tx: mpsc::Sender<Job>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
/// 会话的持久创建意图及关闭身份，供崩溃恢复核实原进程范围。
pub struct SessionRecord {
    /// 控制面分配且不可复用的会话身份。
    pub session_id: String,
    /// 此次启动专用的 systemd unit 名。
    pub unit: String,
    /// 原进程所在主机启动周期；变化时不能凭旧 cgroup 推断关闭。
    pub boot_id: String,
    /// systemd 分配的进程范围；缺失时不能证实资源已回收。
    pub cgroup: Option<String>,
    /// 防止同名 unit 被其他启动实例替代的 systemd 身份。
    pub invocation: Option<String>,
    /// STARTING、ACTIVE、CLOSING、CLOSED 或 QUARANTINED。
    pub state: String,
    /// 本次会话启动的随机身份，绑定 unit、profile 与 socket 目录。
    pub launch_id: String,
    /// 原执行租约身份，关闭事件需要回报给控制面。
    pub lease_id: String,
    /// 原租约栅栏值。
    pub fence: u64,
    /// 创建该会话时的节点进程身份。
    pub node_epoch: String,
}
#[derive(Debug, thiserror::Error)]
pub enum AdmissionError {
    #[error("command ID already binds another request")]
    CommandConflict,
    #[error("all browser slots are occupied")]
    Capacity,
    #[error("session ID has already been used")]
    SessionExists,
}
/// 开始去重记录后的命令状态；Pending 和 Finished 均不可再次派发。
#[derive(Debug)]
pub enum Begin {
    New,
    Pending,
    Finished(Value),
}
impl Store {
    /// 创建恢复表并启动唯一的 SQLite 连接所有者。
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open(path)?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, state TEXT NOT NULL, record TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, hash TEXT NOT NULL, meta TEXT NOT NULL, result TEXT);
          CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, command_id TEXT NOT NULL, hash TEXT NOT NULL, path TEXT NOT NULL, available INTEGER NOT NULL DEFAULT 0);")?;
        // 旧节点证据默认为 PNG；升级后在同一个 spool 中可靠交付 TRACE。
        let has_kind = connection
            .prepare("PRAGMA table_info(artifacts)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|name| name == "kind");
        if !has_kind {
            connection.execute(
                "ALTER TABLE artifacts ADD COLUMN kind TEXT NOT NULL DEFAULT 'SCREENSHOT'",
                [],
            )?;
        }
        let (tx, mut rx) = mpsc::channel::<Job>(64);
        // 单线程持有连接；短事务不跨越浏览器或网络 I/O。
        std::thread::Builder::new()
            .name("proofrun-store".into())
            .spawn(move || {
                let mut connection = connection;
                while let Some(job) = rx.blocking_recv() {
                    job(&mut connection);
                }
            })?;
        Ok(Self { tx })
    }
    /// 在专用线程执行一个数据库工作单元，不阻塞 Tokio 执行线程。
    pub async fn call<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Box::new(move |db| {
                let _ = tx.send(f(db));
            }))
            .await
            .map_err(|_| anyhow::anyhow!("store stopped"))?;
        rx.await
            .map_err(|_| anyhow::anyhow!("store worker stopped"))?
    }
    /// 派发前登记 commandId；同 ID 仅可取回原结果或进行中状态。
    pub async fn begin(&self, id: String, hash: String, meta: Value) -> Result<Begin> {
        self.call(move |db| {
            let row: Option<(String, Option<String>)> = db
                .query_row("SELECT hash,result FROM commands WHERE id=?", [&id], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .optional()?;
            if let Some((stored, result)) = row {
                if stored != hash {
                    return Err(AdmissionError::CommandConflict.into());
                }
                return Ok(match result {
                    Some(value) => Begin::Finished(serde_json::from_str(&value)?),
                    None => Begin::Pending,
                });
            }
            // 派发前持久化；此后崩溃时保守地将命令恢复为 UNKNOWN。
            db.execute(
                "INSERT INTO commands(id,hash,meta) VALUES(?,?,?)",
                params![id, hash, meta.to_string()],
            )?;
            Ok(Begin::New)
        })
        .await
    }
    /// 原子提交终态和待 ACK 结果；迟到完成不得覆盖先前已提交的结果。
    pub async fn finish(&self, id: String, result: Value) -> Result<()> {
        self.call(move |db| {
            let tx = db.transaction()?;
            tx.execute(
                "UPDATE commands SET result=? WHERE id=? AND result IS NULL",
                params![result.to_string(), id],
            )?;
            // 已提交的结果不可被迟到的完成消息覆盖。
            let value: String =
                tx.query_row("SELECT result FROM commands WHERE id=?", [&id], |r| {
                    r.get(0)
                })?;
            tx.execute(
                "INSERT OR IGNORE INTO outbox VALUES(?,?)",
                params![id, value],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
    }
    /// 在同一事务中检查容量、阻止 sessionId 复用并记录创建意图。
    pub async fn reserve(&self, record: SessionRecord, capacity: usize) -> Result<()> {
        self.call(move |db| {
            let tx = db.transaction()?;
            let count: u32 = tx.query_row(
                "SELECT count(*) FROM sessions WHERE state != 'CLOSED'",
                [],
                |r| r.get(0),
            )?;
            if count as usize >= capacity {
                return Err(AdmissionError::Capacity.into());
            }
            if tx
                .query_row(
                    "SELECT 1 FROM sessions WHERE id=?",
                    [&record.session_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some()
            {
                return Err(AdmissionError::SessionExists.into());
            }
            tx.execute(
                "INSERT INTO sessions VALUES(?,?,?)",
                params![
                    record.session_id,
                    record.state,
                    serde_json::to_string(&record)?
                ],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
    }
    /// 持久化状态；终态同时写入可重送的关闭事件。
    pub async fn save_session(&self, record: SessionRecord) -> Result<()> {
        self.call(move |db| {
            let tx = db.transaction()?;
            tx.execute(
                "UPDATE sessions SET state=?,record=? WHERE id=?",
                params![
                    record.state,
                    serde_json::to_string(&record)?,
                    record.session_id
                ],
            )?;
            if matches!(record.state.as_str(), "CLOSED" | "QUARANTINED") {
                let id = format!("session:{}:{}", record.session_id, record.state);
                let event = serde_json::json!({
                    "type": "session.closed", "messageId": id,
                    "sessionId": record.session_id, "nodeEpoch": record.node_epoch,
                    "leaseId": record.lease_id, "fence": record.fence,
                    "state": record.state, "closureVerified": record.state == "CLOSED"
                });
                tx.execute(
                    "INSERT OR IGNORE INTO outbox VALUES(?,?)",
                    params![id, event.to_string()],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
        .await
    }
    /// 返回所有未确认 CLOSED 的会话，供启动恢复与心跳占用统计。
    pub async fn sessions(&self) -> Result<Vec<SessionRecord>> {
        self.call(|db| {
            let mut s = db.prepare("SELECT record FROM sessions WHERE state != 'CLOSED'")?;
            let rows = s.query_map([], |r| r.get::<_, String>(0))?;
            rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
        })
        .await
    }
    /// 将崩溃前未提交结果改为 UNKNOWN，并仅重送结果而不重放动作。
    pub async fn recover_commands(&self) -> Result<()> {
        self.call(|db| {
            let rows: Vec<(String, String)> = db
                .prepare("SELECT id,meta FROM commands WHERE result IS NULL")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            let tx = db.transaction()?;
            for (id, meta) in rows {
                let mut result: Value = serde_json::from_str(&meta)?;
                result["type"] = "command.result".into();
                result["operationStatus"] = "UNKNOWN".into();
                result["effect"] = "MAY_HAVE_HAPPENED".into();
                result["error"] = serde_json::json!({
                    "code": "NODE_RESTARTED",
                    "message": "No committed result; the operation is not replayed."
                });
                tx.execute(
                    "UPDATE commands SET result=? WHERE id=?",
                    params![result.to_string(), id],
                )?;
                tx.execute(
                    "INSERT OR IGNORE INTO outbox VALUES(?,?)",
                    params![id, result.to_string()],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
        .await
    }
    /// 分批读取待确认消息；断线重连时继续发送同一 messageId。
    pub async fn pending(&self) -> Result<Vec<Value>> {
        self.call(|db| {
            let mut s = db.prepare("SELECT payload FROM outbox ORDER BY rowid LIMIT 64")?;
            s.query_map([], |r| r.get::<_, String>(0))?
                .map(|r| Ok(serde_json::from_str(&r?)?))
                .collect()
        })
        .await
    }
    /// 仅在控制面确认持久接收后删除 outbox 消息。
    pub async fn ack(&self, id: String) -> Result<()> {
        self.call(move |db| {
            db.execute("DELETE FROM outbox WHERE id=?", [id])?;
            Ok(())
        })
        .await
    }
}
