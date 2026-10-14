//! 每个真实 tab 使用独立连接采集网络元数据，观察不清空历史，不读取响应正文。
use super::Dom;
use crate::error::Result;
use serde_json::{Value, json};
use std::collections::VecDeque;

/// 单 tab 的历史上限；截断后只能证明已保留的正向事实。
const NETWORK_HISTORY: usize = 500;

/// 认证头、正文和 URL 查询参数在收到事件时即丢弃，不进入历史缓存。
pub(super) struct NetworkCapture {
    session: String,
    target: String,
    entries: VecDeque<Value>,
    truncated: bool,
}

impl NetworkCapture {
    /// 请求与响应以 Chromium 身份关联；重定向覆盖该请求的旧地址，不能拼接错误状态。
    pub(super) fn event(&mut self, event: &Value) {
        if event["sessionId"] != self.session {
            return;
        }
        let p = &event["params"];
        if event["method"] == "Network.requestWillBeSent" {
            self.entries
                .retain(|entry| entry["requestId"] != p["requestId"]);
            let raw = json!({"requests":[{"url":p["request"]["url"],"method":p["request"]["method"],"resourceType":p["type"]}]});
            let Ok(clean) = crate::network::sanitize(&raw) else {
                return;
            };
            let mut entry = clean["requests"][0].clone();
            entry["requestId"] = p["requestId"].clone();
            entry["navigationId"] = p["loaderId"].clone();
            entry["frameId"] = p["frameId"].clone();
            entry["timestamp"] = p["wallTime"].clone();
            self.entries.push_back(entry);
            if self.entries.len() > NETWORK_HISTORY {
                self.entries.pop_front();
                self.truncated = true;
            }
        } else if event["method"] == "Network.responseReceived"
            && let Some(entry) = self
                .entries
                .iter_mut()
                .find(|entry| entry["requestId"] == p["requestId"])
        {
            entry["status"] = p["response"]["status"].clone();
        }
    }
}

impl Dom {
    /// 认证相关输入前排空旧事件，再清除所有旧请求；迟到响应不能复活旧账号的事实。
    pub(crate) async fn network_invalidate(&mut self) -> Result<()> {
        self.network_snapshot().await?;
        let capture = self.network.as_mut().unwrap();
        capture.entries.clear();
        capture.truncated = false;
        Ok(())
    }

    /// 在首次业务导航前订阅目标 tab；不会把后台兄弟 tab 的请求归给活动页。
    pub(crate) async fn network_start(&mut self, target: &str) -> Result<()> {
        let session = self.attach(target).await?;
        self.network = Some(NetworkCapture {
            session: session.clone(),
            target: target.into(),
            entries: VecDeque::new(),
            truncated: false,
        });
        self.call(Some(&session), "Network.enable", json!({}))
            .await?;
        Ok(())
    }

    /// 只返回当前主文档导航的记录；Page 回复之前的通知均已由 call 处理。
    pub(crate) async fn network_snapshot(&mut self) -> Result<Value> {
        let session = self.network.as_ref().unwrap().session.clone();
        let tree = self
            .call(Some(&session), "Page.getFrameTree", json!({}))
            .await?;
        let navigation = &tree["frameTree"]["frame"]["loaderId"];
        let capture = self.network.as_ref().unwrap();
        let requests: Vec<_> = capture
            .entries
            .iter()
            .filter(|entry| &entry["navigationId"] == navigation)
            .cloned()
            .collect();
        Ok(
            json!({"requests":requests,"navigationId":navigation,"targetId":capture.target,"scope":"tab-navigation","truncated":capture.truncated,"complete":false,"redacted":true}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// 合成事件只检查脱敏和容量，不代表实际 Chromium 已捕获请求。
    #[test]
    fn bounded_redacted_events_keep_response_identity() {
        let mut capture = NetworkCapture {
            session: "s".into(),
            target: "t".into(),
            entries: VecDeque::new(),
            truncated: false,
        };
        for i in 0..=NETWORK_HISTORY {
            capture.event(&json!({"sessionId":"s","method":"Network.requestWillBeSent","params":{"requestId":i.to_string(),"loaderId":"n","frameId":"f","wallTime":1,"request":{"url":"https://fixture.test/api?token=secret","method":"GET","headers":{"Authorization":"secret"},"postData":"secret"}}}));
        }
        capture.event(&json!({"sessionId":"other","method":"Network.responseReceived","params":{"requestId":NETWORK_HISTORY.to_string(),"response":{"status":500}}}));
        assert!(capture.entries.back().unwrap()["status"].is_null());
        capture.event(&json!({"sessionId":"s","method":"Network.responseReceived","params":{"requestId":NETWORK_HISTORY.to_string(),"response":{"status":200,"body":"secret"}}}));
        assert_eq!(capture.entries.len(), NETWORK_HISTORY);
        assert!(capture.truncated);
        assert_eq!(capture.entries.back().unwrap()["status"], 200);
        assert!(
            !serde_json::to_string(&capture.entries)
                .unwrap()
                .contains("secret")
        );
    }

    /// 真实隔离 Chromium 与本地 HTTP 验证初始请求跨观察保留、刷新隔离、兄弟 tab 排除；不连接业务站点或模型。
    #[tokio::test]
    #[ignore = "需要显式提供独立测试用 Chromium 路径"]
    async fn native_network_preserves_initial_response_and_navigation_scope() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                tokio::spawn(async move {
                    let mut request = [0u8; 8192];
                    let n = socket.read(&mut request).await.unwrap();
                    let request = String::from_utf8_lossy(&request[..n]);
                    let body = if request.starts_with("GET /api") {
                        "{}"
                    } else {
                        "<html><body>fixture<script>fetch('/api?token=secret')</script></body></html>"
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    socket.write_all(response.as_bytes()).await.unwrap();
                });
            }
        });
        let profile = tempfile::tempdir().unwrap();
        let mut chrome =
            tokio::process::Command::new(std::env::var("PROOFRUN_TEST_CHROME").unwrap())
                .args([
                    "--headless=new",
                    "--no-sandbox",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--remote-debugging-port=0",
                ])
                .arg(format!("--user-data-dir={}", profile.path().display()))
                .arg("about:blank")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
        let metadata = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if let Ok(value) =
                    tokio::fs::read_to_string(profile.path().join("DevToolsActivePort")).await
                {
                    break value;
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .unwrap();
        let lines: Vec<_> = metadata.lines().collect();
        let mut dom = Dom::connect(&format!("ws://127.0.0.1:{}{}", lines[0], lines[1]))
            .await
            .unwrap();
        let targets = dom
            .call(None, "Target.getTargets", json!({}))
            .await
            .unwrap();
        let target = targets["targetInfos"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["type"] == "page")
            .unwrap()["targetId"]
            .as_str()
            .unwrap();
        dom.network_start(target).await.unwrap();
        let session = dom.network.as_ref().unwrap().session.clone();
        dom.call(Some(&session), "Page.navigate", json!({"url":url}))
            .await
            .unwrap();
        let first = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let snapshot = dom.network_snapshot().await.unwrap();
                if snapshot["requests"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["url"] == format!("{url}/api") && r["status"] == 200)
                {
                    break snapshot;
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .unwrap();
        let second = dom.network_snapshot().await.unwrap();
        for request in first["requests"].as_array().unwrap() {
            assert!(second["requests"].as_array().unwrap().contains(request));
        }
        assert!(!first.to_string().contains("secret"));
        dom.call(
            None,
            "Target.createTarget",
            json!({"url":format!("{url}/sibling")}),
        )
        .await
        .unwrap();
        assert!(
            !dom.network_snapshot()
                .await
                .unwrap()
                .to_string()
                .contains("sibling")
        );
        // 人工输入前失效同导航的旧请求；之后的迟到响应不能重新证明旧身份。
        dom.network_invalidate().await.unwrap();
        assert!(
            dom.network_snapshot().await.unwrap()["requests"]
                .as_array()
                .unwrap()
                .iter()
                .all(|entry| !first["requests"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|old| old["requestId"] == entry["requestId"]))
        );
        dom.call(
            Some(&session),
            "Page.navigate",
            json!({"url":"about:blank"}),
        )
        .await
        .unwrap();
        let next = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let snapshot = dom.network_snapshot().await.unwrap();
                if snapshot["navigationId"] != first["navigationId"] {
                    break snapshot;
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .unwrap();
        assert!(next["requests"].as_array().unwrap().is_empty());
        chrome.kill().await.unwrap();
        chrome.wait().await.unwrap();
        server.abort();
    }
}
