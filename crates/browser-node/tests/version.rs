use serde_json::Value;
use std::process::Command;

/// 验证真实 CLI 与编译身份一致且无法被运行时环境覆盖；不启动 Linux 节点或浏览器。
#[test]
fn cli_reports_compiled_identity_without_loading_config() {
    let output = Command::new(env!("CARGO_BIN_EXE_proofrun-node"))
        .args([
            "--config",
            "/missing/proofrun-version-test.toml",
            "build-info",
        ])
        .env("PROOFRUN_BUILD_VERSION", "node-v99.0.0-fake")
        .env("PROOFRUN_BUILD_COMMIT", "f".repeat(40))
        .output()
        .unwrap();
    assert!(output.status.success());
    let info: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        info,
        serde_json::to_value(proofrun_node::version::current()).unwrap()
    );
    let version = Command::new(env!("CARGO_BIN_EXE_proofrun-node"))
        .arg("--version")
        .output()
        .unwrap();
    assert!(version.status.success());
    assert_eq!(
        String::from_utf8(version.stdout).unwrap().trim(),
        format!("proofrun-node {}", proofrun_node::version::VERSION)
    );
}
