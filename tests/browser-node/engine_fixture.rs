//! 无浏览器故障夹具的 AX 观察适配；只验证协议和进程监管，不代表真实页面证据。
use super::{Engine, Result, Value, json};

impl Engine {
    /// 固定引用只用于 fake_engine.py，发布构建不编译此路径。
    pub(super) async fn fixture_observation(&mut self, timeout: u64) -> Result<Value> {
        let snapshot = self.cli(vec!["snapshot".into()], timeout).await?;
        let mut text = snapshot["snapshot"].as_str().unwrap_or_default().to_owned();
        let mut targets = Vec::new();
        if let Some(refs) = snapshot["refs"].as_object() {
            for (index, (reference, descriptor)) in refs.iter().enumerate() {
                let target = format!("element-{}", index + 1);
                self.targets.insert(target.clone(), format!("@{reference}"));
                text = text.replace(&format!("[ref={reference}]"), &format!("[target={target}]"));
                targets.push(
                    json!({"target":target,"role":descriptor["role"],"name":descriptor["name"]}),
                );
            }
        }
        Ok(
            json!({"text":text,"targets":targets,"tabs":[],"truncated":false,
            "coverage":{"controls":{"scope":"fixture","visibility":"unknown"}}}),
        )
    }

    /// 夹具网络日志不宣称具备真实 tab 归属或浏览器采集能力。
    pub(super) async fn fixture_network(&self, timeout: u64) -> Result<Value> {
        let value = self
            .cli(vec!["network".into(), "requests".into()], timeout)
            .await?;
        crate::network::sanitize(&value)
    }
    /// 只模拟超时命令的进程行为，不提供真实条件成立证明。
    pub(super) async fn fixture_wait(
        &self,
        selector: &str,
        text: &str,
        timeout: u64,
    ) -> Result<Value> {
        let selector = serde_json::to_string(&selector).unwrap();
        let text = serde_json::to_string(&text).unwrap();
        // 只把用户输入序列化成 JS 字符串字面量；不接收可执行脚本。
        let expression = format!(
            "(() => {{ const walk = root => {{ for (const el of root.querySelectorAll('*')) {{ if (el.matches({selector}) && (el.textContent || '').includes({text})) return true; if (el.shadowRoot && walk(el.shadowRoot)) return true; try {{ if (el.contentDocument && walk(el.contentDocument)) return true; }} catch {{}} }} return false; }}; return walk(document); }})()"
        );
        self.cli(
            vec![
                "wait".into(),
                "--fn".into(),
                expression,
                "--timeout".into(),
                timeout.to_string(),
            ],
            timeout,
        )
        .await?;
        Ok(json!({"conditionMet":true}))
    }
}
