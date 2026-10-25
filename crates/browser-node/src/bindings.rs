//! 节点拥有者管理的控制面授权。绑定身份与端点不可改写，撤销后的账本保留原归属。
use crate::{artifacts, config::NodeConfig, pairing, store::Store};
use anyhow::{Result, ensure};
use clap::Subcommand;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::PathBuf;

#[derive(Clone, Serialize, Deserialize)]
/// 仅存放在私有 SQLite 中的绑定材料；列表输出必须显式挑选非密钥字段。
pub struct Binding {
    /// 随机生成且不可复用，同时作为该 API 看到的节点身份。
    pub id: String,
    /// 原有账本导入时为空；新绑定使用自身 id 作为范围。
    pub scope: String,
    /// 节点拥有者设置的本地名称，不来自远端控制面。
    pub name: String,
    /// 固定的控制面网关入口。
    pub gateway_url: String,
    /// 与网关同源的证据上传入口。
    pub artifact_upload_url: Option<String>,
    /// 该控制面签发的独立机器凭据。
    pub token: String,
    /// 该控制面的资源池名称。
    pub pool: String,
    /// 节点拥有者批准的精确浏览器来源，控制面不能自行扩展。
    pub console_origins: Vec<String>,
}
#[derive(Subcommand)]
/// 绑定命令只接受本地管理员调用，不通过远程控制协议暴露。
pub enum Action {
    /// 新增授权；不会替换任何现有绑定或会话。
    Add {
        /// 本机唯一名称；撤销后保留，不能复用。
        #[arg(long)]
        name: String,
        /// 从节点可达的控制面 HTTP(S) origin。
        #[arg(long)]
        api: String,
        /// 与目标服务配对码匹配的资源池。
        #[arg(long)]
        pool: String,
        /// 可重复传入精确客户端来源，不接受通配来源。
        #[arg(long, required = true)]
        console_origin: Vec<String>,
        /// 配对码文件路径，内容不会进入命令参数或输出。
        #[arg(long)]
        pairing_token_file: PathBuf,
    },
    /// 停机后将旧单控制面身份和账本原样导入，保留待确认事件。
    ImportLegacy {
        /// 本机唯一名称；撤销后保留，不能复用。
        #[arg(long)]
        name: String,
        /// 可重复传入精确客户端来源，不接受通配来源。
        #[arg(long, required = true)]
        console_origin: Vec<String>,
    },
    /// 列出授权状态，不输出机器凭据。
    List,
    /// 停止接收新任务，现有会话继续运行。
    Drain { name: String },
    /// 恢复已排空绑定的准入；已撤销绑定不能恢复。
    Resume { name: String },
    /// 持久撤权并关闭所属会话；不会删除数据或改变其他绑定。
    Revoke { name: String },
}
/// origin 必须精确，不允许路径、通配符或非回环明文地址。
pub fn origin(value: &str) -> Result<String> {
    let url = reqwest::Url::parse(value)?;
    crate::gateway::validate_endpoint(value)?;
    ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some_and(|host| !host.contains('*'))
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none(),
        "必须填写 HTTP(S) origin，不能携带路径或参数"
    );
    Ok(url.origin().ascii_serialization())
}
impl Binding {
    /// 构造绑定专用视图；机器资源、目录和直连监听仍来自同一 Node 配置。
    pub fn config(&self, base: &NodeConfig) -> NodeConfig {
        let mut config = base.clone();
        config.gateway_url = self.gateway_url.clone();
        config.artifact_upload_url = self.artifact_upload_url.clone();
        config.pool = self.pool.clone();
        config
    }
    /// 校验本地授权材料；加载失败不能降级成无来源限制的连接。
    pub fn validate(&self) -> Result<()> {
        uuid::Uuid::parse_str(&self.id)?;
        ensure!(
            self.scope.is_empty() || self.scope == self.id,
            "绑定范围无效"
        );
        ensure!(
            !self.name.is_empty() && self.name.len() <= 64 && !self.pool.is_empty(),
            "名称或资源池无效"
        );
        ensure!((32..=256).contains(&self.token.len()), "机器凭据长度无效");
        ensure!(!self.console_origins.is_empty(), "至少批准一个客户端来源");
        for value in &self.console_origins {
            ensure!(origin(value)? == *value, "来源必须规范化");
        }
        crate::gateway::validate_endpoint(&self.gateway_url)?;
        let gateway = reqwest::Url::parse(&self.gateway_url)?;
        ensure!(
            matches!(gateway.scheme(), "ws" | "wss"),
            "网关必须使用 ws/wss"
        );
        if let Some(upload) = &self.artifact_upload_url {
            crate::gateway::validate_endpoint(upload)?;
            let upload = reqwest::Url::parse(upload)?;
            ensure!(
                matches!(upload.scheme(), "http" | "https")
                    && gateway.host_str() == upload.host_str()
                    && gateway.port_or_known_default() == upload.port_or_known_default(),
                "证据上传必须与网关同源"
            );
        }
        Ok(())
    }
}
/// 同一数据库里的注册表由运行服务和本地 CLI 通过事务协调。
pub async fn list(store: &Store) -> Result<Vec<(Binding, String)>> {
    store
        .call(|db, _| {
            let mut q = db.prepare("SELECT config,state FROM bindings ORDER BY name")?;
            q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .map(|r| {
                    let (config, state) = r?;
                    let binding: Binding = serde_json::from_str(&config)?;
                    binding.validate()?;
                    Ok((binding, state))
                })
                .collect()
        })
        .await
}
/// 插入时不允许复用名称或身份，避免旧结果投递到新服务。
pub async fn insert(store: &Store, binding: Binding) -> Result<()> {
    binding.validate()?;
    store
        .call(move |db, _| {
            let tx = db.transaction()?;
            tx.execute(
                "INSERT INTO bindings(id,scope,name,config,state) VALUES(?,?,?,?,'ACTIVE')",
                params![
                    binding.id,
                    binding.scope,
                    binding.name,
                    serde_json::to_string(&binding)?
                ],
            )?;
            tx.execute("DELETE FROM binding_requests WHERE name=?", [&binding.name])?;
            tx.commit()?;
            Ok(())
        })
        .await
}
/// 未取得配对响应前只持久化端点与随机身份，不保存一次性配对码。
async fn pending(store: &Store, binding: Binding) -> Result<Binding> {
    store
        .call(move |db, _| {
            let previous: Option<String> = db
                .query_row(
                    "SELECT config FROM binding_requests WHERE name=?",
                    [&binding.name],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(previous) = previous {
                let previous: Binding = serde_json::from_str(&previous)?;
                ensure!(
                    previous.gateway_url == binding.gateway_url
                        && previous.pool == binding.pool
                        && previous.console_origins == binding.console_origins,
                    "未完成配对的名称不能改绑到另一服务；请使用另一名称"
                );
                return Ok(previous);
            }
            db.execute(
                "INSERT INTO binding_requests(name,config) VALUES(?,?)",
                params![binding.name, serde_json::to_string(&binding)?],
            )?;
            Ok(binding)
        })
        .await
}
/// 状态修改在事务中线性化；资源预留也在同一 SQLite 写事务中检查状态。
pub async fn change(store: &Store, name: String, state: &'static str) -> Result<()> {
    store
        .call(move |db, _| {
            let changed = db.execute(
                "UPDATE bindings SET state=? WHERE name=? AND state!='REVOKED'",
                params![state, name],
            )?;
            ensure!(changed == 1, "绑定不存在或已撤销；撤销后需重新授权新身份");
            Ok(())
        })
        .await
}
/// 执行本地管理；旧绑定导入要求停机，其余操作支持运行时提交。
pub async fn run(config: &NodeConfig, action: Action) -> Result<Value> {
    std::fs::create_dir_all(&config.home)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&config.home, std::fs::Permissions::from_mode(0o700))?;
    }
    // 序列化本地配对，避免重名并发请求消耗多个配对码。
    let admin_lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(config.home.join("bindings.lock"))?;
    fs2::FileExt::try_lock_exclusive(&admin_lock)?;
    let path = config.home.join("node.db");
    // 旧程序仍运行时不得由新 CLI 先迁移其账本；导入身份也必须从头持有主服务锁。
    let scoped = if path.exists() {
        let db = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        db.prepare("PRAGMA table_info(sessions)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|column| column == "binding")
    } else {
        false
    };
    let _offline = if !scoped || matches!(&action, Action::ImportLegacy { .. }) {
        Some(artifacts::lock_home(&config.home)?)
    } else {
        None
    };
    let store = Store::open(&path)?;
    match action {
        Action::List => {}
        Action::Add {
            name,
            api,
            pool,
            console_origin,
            pairing_token_file,
        } => {
            let existing = list(&store).await?;
            ensure!(
                !config.credential_file.exists()
                    || existing.iter().any(|(b, _)| b.scope.is_empty()),
                "请先停机执行 bindings import-legacy，明确旧控制面的客户端来源"
            );
            ensure!(
                !existing.iter().any(|(b, _)| b.name == name),
                "绑定名称已存在"
            );
            let api = origin(&api)?;
            let id = uuid::Uuid::new_v4().simple().to_string();
            let mut binding = Binding {
                id: id.clone(),
                scope: id,
                name,
                gateway_url: format!("{}/v1/nodes/connect", api.replacen("http", "ws", 1)),
                artifact_upload_url: Some(format!("{api}/v1/artifacts")),
                token: "x".repeat(32),
                pool,
                console_origins: console_origin
                    .iter()
                    .map(|s| origin(s))
                    .collect::<Result<_>>()?,
            };
            binding.validate()?;
            // 配对请求身份先落盘；响应丢失后用同一配对码重试不会创建另一个节点。
            binding = pending(&store, binding).await?;
            let receipt =
                pairing::exchange(&binding.config(config), &pairing_token_file, &binding.id)
                    .await?;
            binding.token = receipt["token"].as_str().unwrap().into();
            insert(&store, binding).await?;
        }
        Action::ImportLegacy {
            name,
            console_origin,
        } => {
            ensure!(
                list(&store).await?.is_empty(),
                "已有显式绑定，不能再次导入旧身份"
            );
            let binding = Binding {
                id: artifacts::installation_id(&config.home)?,
                scope: String::new(),
                name,
                gateway_url: config.gateway_url.clone(),
                artifact_upload_url: config.artifact_upload_url.clone(),
                token: config.credential()?,
                pool: config.pool.clone(),
                console_origins: console_origin
                    .iter()
                    .map(|s| origin(s))
                    .collect::<Result<_>>()?,
            };
            insert(&store, binding).await?;
        }
        Action::Drain { name } => change(&store, name, "DRAINING").await?,
        Action::Resume { name } => change(&store, name, "ACTIVE").await?,
        Action::Revoke { name } => change(&store, name, "REVOKED").await?,
    }
    let mut result = Vec::new();
    for (binding, state) in list(&store).await? {
        let sessions = store.scoped(&binding.scope).sessions().await?.len();
        result.push(json!({"id":binding.id,"name":binding.name,"gatewayUrl":binding.gateway_url,"pool":binding.pool,"consoleOrigins":binding.console_origins,"state":state,"remainingSessions":sessions}));
    }
    Ok(
        json!({"bindings":result,"note":"状态已持久化；撤销后的进程回收以 remainingSessions 为零为准"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    /// 构造有效但不访问网络的本地绑定，测试不会使用生产凭据。
    pub(crate) fn fixture(name: &str) -> Binding {
        let id = uuid::Uuid::new_v4().simple().to_string();
        Binding {
            id: id.clone(),
            scope: id,
            name: name.into(),
            gateway_url: "wss://api.test/v1/nodes/connect".into(),
            artifact_upload_url: Some("https://api.test/v1/artifacts".into()),
            token: "t".repeat(32),
            pool: "default".into(),
            console_origins: vec!["https://console.test".into()],
        }
    }
    /// 范围：配对响应丢失后的身份恢复及端点固定；不向真实 API 配对。
    #[tokio::test]
    async fn pairing_retry_keeps_identity_and_rejects_endpoint_changes() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(&root.path().join("node.db")).unwrap();
        let first = pending(&store, fixture("dev")).await.unwrap();
        assert_eq!(pending(&store, fixture("dev")).await.unwrap().id, first.id);
        let mut other = fixture("dev");
        other.gateway_url = "wss://other.test/v1/nodes/connect".into();
        assert!(pending(&store, other).await.is_err());
        insert(&store, first.clone()).await.unwrap();
        assert!(insert(&store, fixture("dev")).await.is_err());
        assert_eq!(list(&store).await.unwrap()[0].0.id, first.id);
    }
    /// 范围：同 ID 命令、会话、事件与重启恢复按绑定隔离；不启动浏览器或验收机器资源指标。
    #[tokio::test]
    async fn scoped_ledger_survives_colliding_ids_ack_drain_and_revoke() {
        use crate::store::{Begin, SessionRecord};
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("node.db");
        let store = Store::open(&path).unwrap();
        let a = fixture("prod");
        let b = fixture("dev");
        insert(&store, a.clone()).await.unwrap();
        insert(&store, b.clone()).await.unwrap();
        let sa = store.scoped(&a.scope);
        let sb = store.scoped(&b.scope);
        for (s, hash) in [(&sa, "prod"), (&sb, "dev")] {
            assert!(matches!(
                s.begin(
                    "same-command".into(),
                    hash.into(),
                    json!({"messageId":"same-command","sessionId":"same-session"})
                )
                .await
                .unwrap(),
                Begin::New
            ));
        }
        sa.finish(
            "same-command".into(),
            json!({"messageId":"same-command","owner":"prod"}),
        )
        .await
        .unwrap();
        sb.recover_commands().await.unwrap();
        sa.ack("same-command".into()).await.unwrap();
        assert!(sa.pending().await.unwrap().is_empty());
        assert_eq!(sb.pending().await.unwrap()[0]["operationStatus"], "UNKNOWN");
        assert!(
            sa.begin("same-command".into(), "dev".into(), json!({}))
                .await
                .is_err()
        );
        let record:SessionRecord=serde_json::from_value(json!({"session_id":"same-session","unit":"fixture","boot_id":"fixture","cgroup":null,"invocation":null,"state":"STARTING","launch_id":"fixture","lease_id":"same-lease","fence":1,"node_epoch":"epoch"})).unwrap();
        sa.reserve(record.clone()).await.unwrap();
        sb.reserve(record.clone()).await.unwrap();
        assert_eq!(store.all_sessions().await.unwrap().len(), 2);
        assert_eq!(sa.sessions().await.unwrap().len(), 1);
        change(&store, "prod".into(), "DRAINING").await.unwrap();
        let mut next = record;
        next.session_id = "next".into();
        assert!(sa.reserve(next.clone()).await.is_err());
        sb.reserve(next.clone()).await.unwrap();
        change(&store, "prod".into(), "ACTIVE").await.unwrap();
        sa.reserve(next).await.unwrap();
        change(&store, "prod".into(), "REVOKED").await.unwrap();
        assert!(change(&store, "prod".into(), "ACTIVE").await.is_err());
        assert_eq!(sb.binding_state().await.unwrap(), "ACTIVE");
        let reopened = Store::open(&path).unwrap();
        assert_eq!(
            reopened.scoped(&a.scope).binding_state().await.unwrap(),
            "REVOKED"
        );
        assert_eq!(reopened.scoped(&b.scope).pending().await.unwrap().len(), 1);
    }
    /// 范围：新 CLI 不能在旧主服务持有目录时迁移数据库；不启动真实守护进程。
    #[tokio::test]
    async fn legacy_import_locks_before_schema_migration() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("node.db");
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,state TEXT,record TEXT);")
            .unwrap();
        let config = NodeConfig {
            home: root.path().into(),
            ..Default::default()
        };
        let lock = artifacts::lock_home(root.path()).unwrap();
        assert!(
            run(
                &config,
                Action::ImportLegacy {
                    name: "prod".into(),
                    console_origin: vec!["https://console.test".into()]
                }
            )
            .await
            .is_err()
        );
        let columns: Vec<String> = db
            .prepare("PRAGMA table_info(sessions)")
            .unwrap()
            .query_map([], |r| r.get(1))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert!(!columns.contains(&"binding".into()));
        drop(lock);
    }
    /// 范围：节点拥有者批准的来源格式及上传端点约束；不验收真实 TLS 证书。
    #[test]
    fn origin_and_upload_are_pinned() {
        for value in [
            "https://*.console.test",
            "https://console.test/path",
            "https://user@console.test",
            "http://remote.test",
            "https://console.test?x=1",
        ] {
            assert!(origin(value).is_err());
        }
        assert_eq!(
            origin("http://localhost:5173").unwrap(),
            "http://localhost:5173"
        );
        let mut b = fixture("test");
        assert!(b.validate().is_ok());
        b.artifact_upload_url = Some("https://another.test/v1/artifacts".into());
        assert!(b.validate().is_err());
    }
}
