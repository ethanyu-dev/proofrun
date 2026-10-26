//! 同一 tab 的固定运行时探针；不提供任意脚本入口，不读取缓存正文或账号材料。
use super::*;
/// 单次缓存枚举上限；只读取元数据，不打开或创建缓存。
const CACHE_LIMIT: usize = 200;
/// 编译期固定只读探针，不能由任务替换脚本文本。
const RUNTIME_INSPECT: &str = include_str!("runtime-inspect.js");
/// 编译期固定清理动作，仅作用于当前隔离 origin。
const RUNTIME_CLEANUP: &str = include_str!("runtime-cleanup.js");

impl Dom {
    /// 在主文档的隔离世界取证，页面覆盖全局函数不会改变探针实现。
    pub(crate) async fn runtime_inspect(&mut self, target: &str) -> Result<Value> {
        let mut value = self.runtime_script(target, RUNTIME_INSPECT).await?;
        if let Some(origin) = value["origin"].as_str().map(str::to_owned) {
            value["cacheStorage"] = self
                .cache_snapshot(target, &origin)
                .await
                .unwrap_or_else(|_| json!({"status":"unavailable","reason":"CACHE_READ_FAILED"}));
        }
        Ok(value)
    }
    /// 使用 CDP 的缓存身份分页，缓存被页面并发删除时报告不可用，不创建空缓存。
    async fn cache_snapshot(&mut self, target: &str, origin: &str) -> Result<Value> {
        let session = match self.network_session(target) {
            Some(session) => session,
            None => self.attach(target).await?,
        };
        let reply = self
            .call(
                Some(&session),
                "CacheStorage.requestCacheNames",
                json!({"securityOrigin":origin}),
            )
            .await?;
        let caches = reply["caches"].as_array().ok_or_else(fault)?;
        let mut names = Vec::new();
        let mut entries = Vec::new();
        let mut truncated = caches.len() > CACHE_LIMIT;
        for cache in caches.iter().take(CACHE_LIMIT) {
            let name: String = cache["cacheName"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(160)
                .collect();
            names.push(name.clone());
            let left = CACHE_LIMIT - entries.len();
            if left == 0 {
                truncated = true;
                continue;
            }
            let page = self
                .call(
                    Some(&session),
                    "CacheStorage.requestEntries",
                    json!({"cacheId":cache["cacheId"],"skipCount":0,"pageSize":left}),
                )
                .await?;
            let rows = page["cacheDataEntries"].as_array().ok_or_else(fault)?;
            truncated |= page["returnCount"].as_u64().unwrap_or(u64::MAX) > rows.len() as u64;
            for row in rows.iter().take(left) {
                let mut url = reqwest::Url::parse(row["requestURL"].as_str().unwrap_or(""))
                    .map_err(|_| fault())?;
                let _ = url.set_username("");
                let _ = url.set_password(None);
                url.set_query(None);
                url.set_fragment(None);
                let rsc = row["requestURL"]
                    .as_str()
                    .and_then(|raw| reqwest::Url::parse(raw).ok())
                    .is_some_and(|url| url.query_pairs().any(|(key, _)| key == "_rsc"))
                    || row["requestHeaders"].as_array().is_some_and(|headers| {
                        headers.iter().any(|header| {
                            header["name"].as_str().is_some_and(|key| {
                                key.eq_ignore_ascii_case("rsc")
                                    || key.eq_ignore_ascii_case("next-router-state-tree")
                            })
                        })
                    });
                truncated |= url.as_str().len() > 2048;
                entries.push(json!({"cacheName":name,"url":url.as_str().chars().take(2048).collect::<String>(),"method":row["requestMethod"],"rsc":rsc,"responseStatus":row["responseStatus"]}));
            }
        }
        Ok(
            json!({"status":"observed","supported":true,"names":names,"entries":entries,"truncated":truncated,"scope":"current-origin","redacted":true}),
        )
    }
    /// 预置动作与普通写入共享命令去重和未知结果保护。
    pub(crate) async fn runtime_action(&mut self, target: &str, action: &str) -> Result<Value> {
        let script = match action {
            "online" => {
                "(() => { const at=Date.now(); dispatchEvent(new Event('online')); return {performed:true,event:'online',dispatchedAt:at}; })()"
            }
            "pwa.cleanup" => RUNTIME_CLEANUP,
            _ => {
                return Err(Fault::rejected(
                    "INVALID_ACTION",
                    "unsupported runtime operation",
                ));
            }
        };
        self.runtime_script(target, script).await
    }
    /// 输入脚本只来自编译期常量；上下文绑定本次主文档，导航竞态由 CDP 明确拒绝。
    async fn runtime_script(&mut self, target: &str, script: &str) -> Result<Value> {
        let session = match self.network_session(target) {
            Some(session) => session,
            None => self.attach(target).await?,
        };
        let tree = self
            .call(Some(&session), "Page.getFrameTree", json!({}))
            .await?;
        let frame = tree["frameTree"]["frame"]["id"]
            .as_str()
            .ok_or_else(fault)?;
        let world = self
            .call(
                Some(&session),
                "Page.createIsolatedWorld",
                json!({"frameId":frame,"worldName":"proofrun-runtime"}),
            )
            .await?;
        let result = self.call(Some(&session), "Runtime.evaluate", json!({"expression":script,"contextId":world["executionContextId"],"returnByValue":true,"awaitPromise":true,"timeout":2000})).await?;
        if result.get("exceptionDetails").is_some() {
            return Err(Fault::unknown(
                "RUNTIME_PROBE_FAILED",
                "runtime operation failed",
            ));
        }
        result["result"].get("value").cloned().ok_or_else(fault)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // 范围：独立真实 Chrome 和回环站点验证 SW、缓存元数据、online 与清理；不连接生产或模型。
    #[tokio::test]
    #[ignore = "需要显式提供独立测试用 Chromium 路径"]
    async fn native_runtime_observes_and_cleans_same_origin() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                tokio::spawn(async move {
                    let mut request = [0u8; 8192];
                    let n = socket.read(&mut request).await.unwrap();
                    let request = String::from_utf8_lossy(&request[..n]);
                    let (content_type, body) = if request.starts_with("GET /sw.js") {
                        (
                            "application/javascript",
                            "self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));",
                        )
                    } else {
                        (
                            "text/html",
                            "<html><body>runtime fixture<script>window.onlineCount=0;addEventListener('online',()=>onlineCount++);</script></body></html>",
                        )
                    };
                    let status = if request.contains("q=0 ") {
                        "400 Bad Request"
                    } else {
                        "200 OK"
                    };
                    let response = format!(
                        "HTTP/1.1 {status}\r\nCache-Control: no-store\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
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
        let session = dom.attach(target).await.unwrap();
        dom.call(Some(&session), "Page.navigate", json!({"url":url}))
            .await
            .unwrap();

        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let tree = dom
                    .call(Some(&session), "Page.getFrameTree", json!({}))
                    .await
                    .unwrap();
                if tree["frameTree"]["frame"]["url"] == format!("{url}/") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        let ready = dom.call(Some(&session), "Runtime.evaluate", json!({"expression":"(async()=>{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;await (await caches.open('fixture-v1')).put('/asset?token=secret',new Response('private-body'));return true})()","awaitPromise":true,"returnByValue":true})).await.unwrap();
        assert_eq!(ready["result"]["value"], true, "{ready}");
        let first = dom.runtime_inspect(target).await.unwrap();
        assert_eq!(first["status"], "observed");
        assert_eq!(
            first["serviceWorker"]["registrations"][0]["active"]["state"],
            "activated"
        );
        assert_eq!(first["cacheStorage"]["names"], json!(["fixture-v1"]));
        assert_eq!(
            first["cacheStorage"]["entries"][0]["url"],
            format!("{url}/asset")
        );
        assert!(!first.to_string().contains("secret"));
        assert!(!first.to_string().contains("private-body"));
        dom.call(Some(&session), "Runtime.evaluate", json!({"expression":"fetch('/_next/image?url=%2Fasset&w=64&q=80').then(()=>true)","awaitPromise":true,"returnByValue":true})).await.unwrap();
        dom.network_snapshot().await.unwrap();
        let probe = dom
            .network_probe(&format!("{url}/_next/image?url=%2Fasset&w=64&q=0"))
            .await
            .unwrap();
        assert_eq!(probe["networkProbe"]["status"], 400);
        assert_eq!(
            probe["networkProbe"]["headers"]["cache-control"],
            "no-store"
        );
        assert_eq!(probe["networkProbe"]["credentials"], "omitted");
        assert!(
            dom.network_probe(&format!("{url}/_next/image?url=%2Fother&w=64&q=0"))
                .await
                .is_err()
        );
        // 真实聚焦监听器转移焦点，原键不派发；下一次观察公开新焦点供重新决策。
        dom.call(Some(&session),"Runtime.evaluate",json!({"expression":"document.body.insertAdjacentHTML('beforeend', `<button id='focus-jump' onfocus=\"document.querySelector('#focus-receiver').focus()\">jump focus</button><input id='focus-receiver' aria-label='receiver'>`)"})).await.unwrap();
        let observed = dom.snapshot(target, None).await.unwrap();
        let button = observed["targets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "jump focus")
            .unwrap();
        assert_eq!(button["focusable"], true);
        let failure = dom
            .act(button["target"].as_str().unwrap(), "focus", None)
            .await
            .unwrap_err();
        assert_eq!(failure.code, "KEYBOARD_FOCUS_UNCONFIRMED");
        assert!(!failure.requires_session_close(false));
        let focus_state=dom.call(Some(&session), "Runtime.evaluate", json!({"expression":"({active:document.activeElement.id,focused:document.hasFocus(),visibility:document.visibilityState})","returnByValue":true})).await.unwrap();
        let refreshed = dom.snapshot(target, None).await.unwrap();
        assert!(
            refreshed["targets"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["name"] == "receiver" && t["focused"] == true),
            "focus snapshot: {} {}",
            refreshed["targets"],
            focus_state
        );
        dom.runtime_action(target, "online").await.unwrap();
        let count = dom
            .call(
                Some(&session),
                "Runtime.evaluate",
                json!({"expression":"window.onlineCount","returnByValue":true}),
            )
            .await
            .unwrap();
        assert_eq!(count["result"]["value"], 1);
        dom.runtime_action(target, "pwa.cleanup").await.unwrap();
        let clean = dom.runtime_inspect(target).await.unwrap();
        assert_eq!(clean["serviceWorker"]["registrations"], json!([]));
        assert_eq!(clean["cacheStorage"]["names"], json!([]));
        // 清理注册不等于当前文档已脱离 controller，结果必须保留真实 controller 供后续刷新核验。
        assert!(clean["serviceWorker"].get("controller").is_some());
        chrome.kill().await.unwrap();
        chrome.wait().await.unwrap();
        server.abort();
    }
}
