use super::*;
use std::os::unix::fs::PermissionsExt;

/// 构造最小旧 host 配置，验证新增字段的反序列化默认值；不引入真实身份材料。
fn config(root: &Path, preference: Option<bool>) -> EngineConfig {
    let mut value = json!({"binary":root.join("engine.py"),"session":uuid::Uuid::new_v4().simple().to_string(),"directory":root,"allow_unverified_writes":false});
    if let Some(preference) = preference {
        value["reduced_motion"] = json!(preference);
    }
    serde_json::from_value(value).unwrap()
}

/// 范围：旧配置默认值、固定引擎 args 的字符串格式、显式关闭；真实媒体查询由 motion_smoke.py 验证。
#[test]
fn motion_launch_configuration_preserves_explicit_opt_out() {
    for preference in [None, Some(true), Some(false)] {
        let root = tempfile::tempdir().unwrap();
        let config = config(root.path(), preference);
        assert_eq!(config.reduced_motion, preference.unwrap_or(true));
        Engine::new(config).unwrap();
        let actual: Value =
            serde_json::from_slice(&std::fs::read(root.path().join("agent-browser.json")).unwrap())
                .unwrap();
        assert_eq!(
            actual["args"],
            if preference == Some(false) {
                "--force-prefers-no-reduced-motion"
            } else {
                "--force-prefers-reduced-motion"
            }
        );
    }
}

/// 范围：实际调用顺序和错误媒体回执必须在账号准备前失败；Python 仅模拟 CLI，不是浏览器验收。
#[tokio::test]
async fn mismatched_motion_proof_stops_before_identity_preparation() {
    let root = tempfile::tempdir().unwrap();
    let binary = root.path().join("engine.py");
    std::fs::write(
        &binary,
        r#"#!/usr/bin/env python3
import json,sys
from pathlib import Path
args=sys.argv[sys.argv.index('--json')+1:]
with Path('calls').open('a') as f: f.write(args[0]+'\n')
print(json.dumps({'success':True,'data':{'result':False}}))
"#,
    )
    .unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut config = config(root.path(), None);
    config.external_account = Some(json!({"leaseId":"fixture"}));
    let mut engine = Engine::new(config).unwrap();
    let error = engine.open(5_000).await.unwrap_err();
    assert_eq!(error.code, "MOTION_PREFERENCE_MISMATCH");
    assert_eq!(
        std::fs::read_to_string(root.path().join("calls")).unwrap(),
        "open\neval\n"
    );
}
