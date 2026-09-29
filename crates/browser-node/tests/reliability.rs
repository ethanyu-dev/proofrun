use proofrun_node::{
    artifacts::lock_home,
    engine::{self, Engine, EngineConfig},
    protocol::{ActBrowserAction, BrowserCommand},
    store::{AdmissionError, Begin, SessionRecord, Store},
};
use serde_json::json;

// 构造纯数据库测试用的会话记录；unit/cgroup 字段不指向真实 systemd 资源。
fn record(id: &str) -> SessionRecord {
    SessionRecord {
        session_id: id.into(),
        unit: format!("unit-{id}"),
        boot_id: "boot".into(),
        cgroup: Some("/test".into()),
        invocation: Some("invocation".into()),
        state: "STARTING".into(),
        launch_id: id.into(),
        lease_id: "lease".into(),
        fence: 1,
        node_epoch: "epoch".into(),
    }
}
/// 验证范围：SQLite 命令登记、同 ID 去重、结果不可覆盖及 ACK 删除 outbox。
/// 不覆盖真实浏览器派发或网络断线后的重送。
#[tokio::test]
async fn commits_before_dispatch_and_never_replays_duplicates() {
    let home = tempfile::tempdir().unwrap();
    let store = Store::open(&home.path().join("db")).unwrap();
    assert!(matches!(
        store
            .begin("cmd".into(), "hash".into(), json!({"commandId":"cmd"}))
            .await
            .unwrap(),
        Begin::New
    ));
    assert!(matches!(
        store
            .begin("cmd".into(), "hash".into(), json!({}))
            .await
            .unwrap(),
        Begin::Pending
    ));
    assert!(matches!(
        store
            .begin("cmd".into(), "different".into(), json!({}))
            .await
            .unwrap_err()
            .downcast_ref::<AdmissionError>(),
        Some(AdmissionError::CommandConflict)
    ));
    let result = json!({"type":"command.result","commandId":"cmd","effect":"COMPLETED"});
    store.finish("cmd".into(), result.clone()).await.unwrap();
    store
        .finish("cmd".into(), json!({"effect":"MAY_HAVE_HAPPENED"}))
        .await
        .unwrap();
    match store
        .begin("cmd".into(), "hash".into(), json!({}))
        .await
        .unwrap()
    {
        Begin::Finished(value) => assert_eq!(value, result),
        _ => panic!("must return committed result"),
    }
    assert_eq!(store.pending().await.unwrap(), vec![result]);
    store.ack("cmd".into()).await.unwrap();
    assert!(store.pending().await.unwrap().is_empty());
}
/// 验证范围：未提交终态的账本记录恢复为 UNKNOWN，重查时不重新派发。
/// 这里直接调用恢复方法，不模拟主进程 SIGKILL 或业务服务写入。
#[tokio::test]
async fn interrupted_dispatch_recovers_as_unknown_without_payload_replay() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("db");
    let store = Store::open(&path).unwrap();
    store
        .begin(
            "write".into(),
            "hash".into(),
            json!({"commandId":"write","sessionId":"session"}),
        )
        .await
        .unwrap();
    store.recover_commands().await.unwrap();
    let pending = store.pending().await.unwrap();
    assert_eq!(pending[0]["operationStatus"], "UNKNOWN");
    assert_eq!(pending[0]["effect"], "MAY_HAVE_HAPPENED");
    let reopened = Store::open(&path).unwrap();
    assert!(matches!(
        reopened
            .begin("write".into(), "hash".into(), json!({}))
            .await
            .unwrap(),
        Begin::Finished(_)
    ));
}
/// 验证范围：CLOSING 和 QUARANTINED 在 SQLite 容量计算中继续占位。
/// CLOSED 状态由夹具写入，不证明 systemd/cgroup 已实际关闭。
#[tokio::test]
async fn closing_and_quarantined_sessions_keep_capacity_until_verified_closed() {
    let home = tempfile::tempdir().unwrap();
    let store = Store::open(&home.path().join("db")).unwrap();
    let mut first = record("first");
    store.reserve(first.clone(), 1).await.unwrap();
    for state in ["CLOSING", "QUARANTINED"] {
        first.state = state.into();
        store.save_session(first.clone()).await.unwrap();
        assert!(store.reserve(record("second"), 1).await.is_err());
    }
    first.state = "CLOSED".into();
    store.save_session(first).await.unwrap();
    store.reserve(record("second"), 1).await.unwrap();
    assert!(
        store
            .pending()
            .await
            .unwrap()
            .iter()
            .any(|event| event["closureVerified"] == true)
    );
}
/// 验证范围：开发写入开关、导航 URL 与 CLI 选项参数边界。
/// 仅检查 argv 构造，不执行 shell、浏览器或真实网页请求。
#[test]
fn excludes_raw_shell_flags_and_disables_unverified_writes() {
    let command = BrowserCommand::BrowserAct {
        action: ActBrowserAction::Click,
        target: Some("#save".into()),
        value: None,
        observation_id: Some("obs".into()),
        x: None,
        y: None,
    };
    assert_eq!(
        engine::validate(&command, false).unwrap_err().code,
        "ENGINE_WRITES_UNVERIFIED"
    );
    assert!(
        engine::action_args(
            ActBrowserAction::Navigate,
            Some("file:///etc/passwd".into()),
            None
        )
        .is_err()
    );
    assert!(engine::action_args(ActBrowserAction::Click, Some("--cdp".into()), None).is_err());
    assert_eq!(
        engine::action_args(
            ActBrowserAction::Fill,
            Some("#name".into()),
            Some("$(touch /tmp/unsafe)".into())
        )
        .unwrap(),
        vec!["fill", "#name", "$(touch /tmp/unsafe)"]
    );
}
/// 验证范围：Rust 入口使用原始 Schema 拒绝未知命令及额外字段。
/// 不覆盖 TS 侧所有字段约束或控制面鉴权。
#[test]
fn schema_generated_command_rejects_unrecognized_operations_and_fields() {
    let mut value = json!({"protocolVersion":"0.1","commandId":"a","nodeId":"n","nodeEpoch":"e","sessionId":"s","leaseId":"l","fence":1,"timeoutMs":1000,"command":{"type":"session.close"}});
    assert!(proofrun_node::protocol::parse_command(value.clone()).is_ok());
    value["command"] = json!({"type":"shell","args":["rm"]});
    assert!(proofrun_node::protocol::parse_command(value.clone()).is_err());
    value["command"] = json!({"type":"session.close","args":[]});
    assert!(proofrun_node::protocol::parse_command(value).is_err());
}
/// 验证范围：同一数据目录的文件锁互斥，并可在释放后重新获取。
/// 不涉及跨主机共享文件系统或节点进程恢复。
#[test]
fn only_one_supervisor_can_own_a_home() {
    let home = tempfile::tempdir().unwrap();
    let first = lock_home(home.path()).unwrap();
    assert!(lock_home(home.path()).is_err());
    drop(first);
    assert!(lock_home(home.path()).is_ok());
}
/// 验证范围：超过单次调用期限时终止并回收直接启动的 CLI 子进程。
/// 不覆盖后台 daemon 或 systemd cgroup 中的后代进程。
#[tokio::test]
async fn deadline_kills_and_reaps_the_cli_process() {
    let mut command = tokio::process::Command::new("python3");
    command.args(["-c", "import time; time.sleep(30)"]);
    let started = std::time::Instant::now();
    assert!(
        proofrun_node::process::capture(command, std::time::Duration::from_millis(100))
            .await
            .is_err()
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
}
/// 验证范围：超大 stdout 被 OUTPUT_LIMIT 拒绝，避免无界读取。
/// 输入是 Python 夹具，不代表真实 agent-browser 输出格式。
#[tokio::test]
async fn excessive_cli_output_is_bounded() {
    let mut command = tokio::process::Command::new("python3");
    command.args(["-c", "import sys; sys.stdout.write('x'*3000000)"]);
    let error = proofrun_node::process::capture(command, std::time::Duration::from_secs(3))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("OUTPUT_LIMIT"));
}
/// 验证范围：退出但没有返回 JSON 的引擎进程不能被报告为成功。
/// 不启动真实 Chrome，也不检查浏览器会话清理。
#[tokio::test]
async fn empty_engine_binary_is_not_reported_as_success() {
    let home = tempfile::tempdir().unwrap();
    let mut engine = Engine::new(EngineConfig {
        binary: "/usr/bin/false".into(),
        chrome: None,
        session: uuid::Uuid::new_v4().to_string(),
        directory: home.path().into(),
        allow_unverified_writes: false,
        auth_state: None,
        restore_auth: false,
        restore_auth_if_present: false,
        auth_snapshot_id: None,
        network_evidence: false,
        live_view: false,
    })
    .unwrap();
    assert!(engine.open(1000).await.is_err());
}
