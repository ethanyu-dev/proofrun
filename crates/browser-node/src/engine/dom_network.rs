//! 每个真实 tab 使用独立连接采集网络元数据，观察不清空历史，不读取响应正文。
use super::Dom;
use crate::error::Result;
use serde_json::{Value, json};
use std::collections::VecDeque;

/// 单 tab 的历史上限；截断后只能证明已保留的正向事实。
const NETWORK_HISTORY: usize = 500;
/// Console 只保留有界错误记录，不遍历或序列化页面对象。
const CONSOLE_HISTORY: usize = 100;

/// 认证头、正文和 URL 查询参数在收到事件时即丢弃，不进入历史缓存。
pub(super) struct NetworkCapture {
    session: String,
    target: String,
    entries: VecDeque<Value>,
    truncated: bool,
    /// 主渲染目标的异常有界保存，截断后不能证明没有异常。
    console: VecDeque<Value>,
    /// 截断后缺少记录不能作为不存在异常的证明。
    console_truncated: bool,
    /// 最近一次受限公开图片探测，单独标注凭据和采集位置。
    last_probe: Option<Value>,
    /// 全部订阅确认之后才允许声明新导航的窗口覆盖。
    ready: bool,
    /// 只记订阅后观察到的非重定向起点，由快照中的真实 frame/loader 再核对。
    navigation_starts: VecDeque<(String, String)>,
    /// 认证失效清空时重设窗口起点，不跨身份沿用完整性。
    started_at: u64,
}

/// 使用 UTC 毫秒标明观察边界；授权计时仍由其他模块的单调时钟承担。
fn capture_time() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl NetworkCapture {
    /// 完整性只适用于订阅后、当前主文档 loader 的 HTTP 请求元数据，不表示整站或未来无请求。
    fn coverage(&self, frame: &Value, navigation: &Value) -> Value {
        let started = self.ready
            && self.navigation_starts.iter().any(|(f, n)| {
                frame.as_str() == Some(f.as_str()) && navigation.as_str() == Some(n.as_str())
            });
        let mut reasons = Vec::new();
        if !started {
            reasons.push("NAVIGATION_START_NOT_OBSERVED");
        }
        if self.truncated {
            reasons.push("HISTORY_TRUNCATED");
        }
        json!({"scope":"current-main-document-loader-http","complete":reasons.is_empty(),"reasons":reasons,
            "startedAt":self.started_at,"capturedAt":capture_time(),"navigationId":navigation,
            "excludedScopes":["other-tabs","child-frame-loaders","workers","websockets","response-bodies","future-events"]})
    }
    /// 错误完整性只覆盖当前渲染连接的订阅窗口，不包含其他进程或订阅前事件。
    fn console_coverage(&self) -> Value {
        let mut reasons = Vec::new();
        if !self.ready {
            reasons.push("SUBSCRIPTION_NOT_READY");
        }
        if self.console_truncated {
            reasons.push("HISTORY_TRUNCATED");
        }
        json!({"scope":"active-renderer-error-events-since-subscription","complete":reasons.is_empty(),
            "eventTypes":["Runtime.exceptionThrown","Runtime.consoleAPICalled:error","Runtime.consoleAPICalled:assert"],
            "startedAt":self.started_at,"capturedAt":capture_time(),"reasons":reasons,
            "excludedScopes":["before-subscription","other-tabs","out-of-process-iframes","workers","browser-log-domain","other-console-types","future-events"]})
    }

    /// 身份切换撤销旧证据及覆盖起点；订阅连接保持可用，迟到重定向不能恢复旧窗口完整性。
    fn invalidate(&mut self) {
        self.entries.clear();
        self.truncated = false;
        self.console.clear();
        self.console_truncated = false;
        self.last_probe = None;
        self.navigation_starts.clear();
        self.started_at = capture_time();
    }

    /// 请求与响应以 Chromium 身份关联；重定向逐跳保留，最终响应只更新最新一跳。
    pub(super) fn event(&mut self, event: &Value) {
        if event["sessionId"] != self.session {
            return;
        }
        let p = &event["params"];
        if ["Runtime.exceptionThrown", "Runtime.consoleAPICalled"]
            .contains(&event["method"].as_str().unwrap_or(""))
        {
            if event["method"] == "Runtime.exceptionThrown"
                || matches!(p["type"].as_str(), Some("error" | "assert"))
            {
                // 不序列化任意 Console 对象；保留错误类型、位置及有界文本。
                let message = if event["method"] == "Runtime.exceptionThrown" {
                    p["exceptionDetails"]["text"]
                        .as_str()
                        .unwrap_or("uncaught exception")
                } else if p["type"] == "assert" {
                    "console.assert"
                } else {
                    "console.error"
                };
                self.console.push_back(json!({"kind":event["method"],"message":message.chars().take(1000).collect::<String>(),"timestamp":p["timestamp"],"line":p["exceptionDetails"]["lineNumber"]}));
                if self.console.len() > CONSOLE_HISTORY {
                    self.console.pop_front();
                    self.console_truncated = true;
                }
            }
            return;
        }
        if event["method"] == "Network.requestWillBeSent" {
            // redirectResponse 表示这是链中后续一跳；缺失首跳时不能据此补认导航完整。
            if self.ready
                && p["type"] == "Document"
                && p.get("redirectResponse").is_none()
                && let (Some(frame), Some(loader)) = (p["frameId"].as_str(), p["loaderId"].as_str())
                && !loader.is_empty()
            {
                self.navigation_starts
                    .push_back((frame.into(), loader.into()));
                if self.navigation_starts.len() > NETWORK_HISTORY {
                    self.navigation_starts.pop_front();
                }
            }
            if let Some(previous) = self
                .entries
                .iter_mut()
                .rev()
                .find(|entry| entry["requestId"] == p["requestId"])
                && p.get("redirectResponse").is_some()
            {
                previous["status"] = p["redirectResponse"]["status"].clone();
                previous["headers"] = response_headers(&p["redirectResponse"]["headers"]);
                previous["redirect"] = json!(true);
            }
            let raw = json!({"requests":[{"url":p["request"]["url"],"method":p["request"]["method"],"resourceType":p["type"]}]});
            let Ok(clean) = crate::network::sanitize(&raw) else {
                return;
            };
            let mut entry = clean["requests"][0].clone();
            if let Some(image) = image_parameters(p["request"]["url"].as_str().unwrap_or("")) {
                entry["image"] = image;
            }
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
                .rev()
                .find(|entry| entry["requestId"] == p["requestId"])
        {
            entry["status"] = p["response"]["status"].clone();
            entry["headers"] = response_headers(&p["response"]["headers"]);
        }
    }
}

impl Dom {
    /// 运行时探针复用长期采集连接，避免每次观察增加未释放的 CDP 会话。
    pub(crate) fn network_session(&self, target: &str) -> Option<String> {
        self.network
            .as_ref()
            .filter(|capture| capture.target == target)
            .map(|capture| capture.session.clone())
    }
    /// 认证相关输入前排空旧事件，再清除所有旧请求；迟到响应不能复活旧账号的事实。
    pub(crate) async fn network_invalidate(&mut self) -> Result<()> {
        self.network_snapshot().await?;
        self.network.as_mut().unwrap().invalidate();
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
            console: VecDeque::new(),
            console_truncated: false,
            last_probe: None,
            ready: false,
            navigation_starts: VecDeque::new(),
            started_at: capture_time(),
        });
        self.call(Some(&session), "Runtime.enable", json!({}))
            .await?;
        self.call(Some(&session), "Page.enable", json!({})).await?;
        self.call(Some(&session), "Network.enable", json!({}))
            .await?;
        let capture = self.network.as_mut().unwrap();
        capture.ready = true;
        capture.started_at = capture_time();
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
        let coverage = capture.coverage(&tree["frameTree"]["frame"]["id"], navigation);
        Ok(
            json!({"requests":requests,"navigationId":navigation,"targetId":capture.target,"scope":"tab-navigation","truncated":capture.truncated,"complete":false,"coverage":coverage,"redacted":true,"probe":capture.last_probe}),
        )
    }
}

/// 只暴露无查询参数的站内图片路径；探测只能改变已观察图片的质量，不能替换资源地址。
fn image_parameters(raw: &str) -> Option<Value> {
    let url = reqwest::Url::parse(raw).ok()?;
    if url.path() != "/_next/image" {
        return None;
    }
    let pairs: Vec<_> = url.query_pairs().collect();
    if pairs.len() != 3 {
        return None;
    }
    let get = |key: &str| {
        pairs
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_ref())
    };
    let source = get("url")?;
    if !source.starts_with('/')
        || source.starts_with("//")
        || source.contains(['?', '#', '\\'])
        || source.len() > 2048
    {
        return None;
    }
    let width = get("w")?.parse::<u32>().ok()?;
    let quality = get("q")?.parse::<u8>().ok()?;
    if width == 0 || width > 16384 || quality > 100 {
        return None;
    }
    Some(json!({"source":source,"width":width,"quality":quality}))
}

/// 仅保留验收所需响应头；认证、Cookie 和任意响应头不会进入证据。
fn response_headers(headers: &Value) -> Value {
    let mut out = serde_json::Map::new();
    if let Some(headers) = headers.as_object() {
        for (key, value) in headers {
            let name = key.to_ascii_lowercase();
            if [
                "location",
                "cache-control",
                "content-type",
                "pragma",
                "expires",
            ]
            .contains(&name.as_str())
            {
                let raw = value.as_str().unwrap_or("");
                let clean = if name == "location" {
                    if let Ok(mut url) = reqwest::Url::parse(raw) {
                        let _ = url.set_username("");
                        let _ = url.set_password(None);
                        url.set_query(None);
                        url.set_fragment(None);
                        url.to_string()
                    } else {
                        raw.split(['?', '#']).next().unwrap_or("").to_owned()
                    }
                } else {
                    raw.to_owned()
                };
                out.insert(name, json!(clean.chars().take(2048).collect::<String>()));
            }
        }
    }
    Value::Object(out)
}

impl Dom {
    /// Console 范围明确限定当前渲染目标；不据零条记录推断跨进程 iframe 无异常。
    pub(crate) fn console_snapshot(&self) -> Value {
        match self.network.as_ref() {
            Some(c) => {
                json!({"scope":"active-tab-renderer-since-subscription","entries":c.console,"truncated":c.console_truncated,"complete":false,
                    "coverage":c.console_coverage()})
            }
            None => json!({"status":"unavailable"}),
        }
    }

    /// 仅重放当前 origin 已观察到的图片端点；公开无凭据探测与浏览器会话响应分别标记。
    pub(crate) async fn network_probe(&mut self, url: &str) -> crate::error::Result<Value> {
        use crate::error::Fault;
        let requested = reqwest::Url::parse(url)
            .map_err(|_| Fault::rejected("INVALID_TARGET", "HTTP URL required"))?;
        let capture = self
            .network
            .as_ref()
            .ok_or_else(|| Fault::rejected("CAPABILITY_UNSUPPORTED", "network capture missing"))?;
        let session = capture.session.clone();
        let tree = self
            .call(Some(&session), "Page.getFrameTree", json!({}))
            .await?;
        let page = reqwest::Url::parse(tree["frameTree"]["frame"]["url"].as_str().unwrap_or(""))
            .map_err(|_| Fault::rejected("INVALID_TARGET", "page origin missing"))?;
        let capture = self.network.as_ref().unwrap();
        let requested_image = image_parameters(url);
        let known = requested_image.as_ref().is_some_and(|image| {
            capture.entries.iter().any(|e| {
                e["navigationId"] == tree["frameTree"]["frame"]["loaderId"]
                    && e["url"]
                        == format!(
                            "{}{}",
                            requested.origin().ascii_serialization(),
                            requested.path()
                        )
                    && e["image"]["source"] == image["source"]
                    && e["image"]["width"] == image["width"]
            })
        });
        if !matches!(requested.scheme(), "http" | "https")
            || requested.origin() != page.origin()
            || !requested.username().is_empty()
            || requested.password().is_some()
            || requested.path() != "/_next/image"
            || !known
            || requested
                .query_pairs()
                .any(|(k, _)| !["url", "w", "q"].contains(&k.as_ref()))
        {
            return Err(Fault::rejected(
                "PROBE_SCOPE_FORBIDDEN",
                "only observed same-origin image endpoint parameters may be replayed",
            ));
        }
        let response = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|_| Fault::rejected("PROBE_FAILED", "client unavailable"))?
            .get(requested.clone())
            .send()
            .await
            .map_err(|_| Fault::unknown("PROBE_FAILED", "request outcome unavailable"))?;
        let headers = response
            .headers()
            .iter()
            .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_string(), json!(v))))
            .collect::<serde_json::Map<_, _>>();
        let data = json!({"scope":"node-public-probe","credentials":"omitted","followRedirects":false,"url":format!("{}{}",requested.origin().ascii_serialization(),requested.path()),"quality":requested.query_pairs().find(|(k,_)|k=="q").map(|(_,v)|v.into_owned()),"status":response.status().as_u16(),"headers":response_headers(&Value::Object(headers))});
        self.network.as_mut().unwrap().last_probe = Some(data.clone());
        Ok(json!({"performed":true,"networkProbe":data}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
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
            console: VecDeque::new(),
            console_truncated: false,
            last_probe: None,
            ready: false,
            navigation_starts: VecDeque::new(),
            started_at: capture_time(),
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

    // 范围：重定向逐跳保留且敏感响应头、Location 凭据丢弃；事件为协议夹具。
    #[test]
    fn redirects_and_probe_parameters_are_bounded() {
        let mut capture = NetworkCapture {
            session: "s".into(),
            target: "t".into(),
            entries: VecDeque::new(),
            truncated: false,
            console: VecDeque::new(),
            console_truncated: false,
            last_probe: None,
            ready: false,
            navigation_starts: VecDeque::new(),
            started_at: capture_time(),
        };
        capture.event(&json!({"sessionId":"s","method":"Network.requestWillBeSent","params":{"requestId":"r","loaderId":"n","request":{"url":"https://site.test/start","method":"GET"}}}));
        capture.event(&json!({"sessionId":"s","method":"Network.requestWillBeSent","params":{"requestId":"r","loaderId":"n","redirectResponse":{"status":307,"headers":{"Location":"https://user:secret@site.test/end?token=secret","Set-Cookie":"secret"}},"request":{"url":"https://site.test/end","method":"GET"}}}));
        capture.event(&json!({"sessionId":"s","method":"Network.responseReceived","params":{"requestId":"r","response":{"status":200,"headers":{"Cache-Control":"no-store"}}}}));
        assert_eq!(capture.entries.len(), 2);
        assert_eq!(capture.entries[0]["status"], 307);
        assert_eq!(
            capture.entries[0]["headers"]["location"],
            "https://site.test/end"
        );
        assert_eq!(capture.entries[1]["status"], 200);
        assert!(
            !serde_json::to_string(&capture.entries)
                .unwrap()
                .contains("secret")
        );
        assert!(image_parameters("https://site.test/_next/image?url=%2Fasset&w=64&q=0").is_some());
        for invalid in [
            "https://site.test/_next/image?url=http://internal.test&w=64&q=80",
            "https://site.test/_next/image?url=%2Fasset%3Ftoken%3Dsecret&w=64&q=80",
            "https://site.test/_next/image?url=%2Fasset&w=64&q=80&extra=1",
        ] {
            assert!(image_parameters(invalid).is_none());
        }
    }

    // 范围：协议事件夹具检查范围完整性的前提，不能代表生产事件流无丢失。
    #[test]
    fn scoped_coverage_requires_observed_navigation_and_untruncated_history() {
        let mut capture = NetworkCapture {
            session: "s".into(),
            target: "t".into(),
            entries: VecDeque::new(),
            truncated: false,
            console: VecDeque::new(),
            console_truncated: false,
            last_probe: None,
            ready: false,
            navigation_starts: VecDeque::new(),
            started_at: capture_time(),
        };
        let event = json!({"sessionId":"s","method":"Network.requestWillBeSent","params":{
            "requestId":"r","type":"Document","frameId":"f","loaderId":"n",
            "request":{"url":"https://fixture.test/","method":"GET"}}});
        assert_eq!(
            capture.console_coverage()["reasons"],
            json!(["SUBSCRIPTION_NOT_READY"])
        );
        capture.event(&event);
        capture.ready = true;
        assert_eq!(capture.console_coverage()["complete"], true);
        for _ in 0..=CONSOLE_HISTORY {
            capture.event(&json!({"sessionId":"s","method":"Runtime.consoleAPICalled","params":{"type":"error"}}));
        }
        assert_eq!(capture.console.len(), CONSOLE_HISTORY);
        assert_eq!(capture.console_coverage()["complete"], false);
        assert_eq!(
            capture.console_coverage()["reasons"],
            json!(["HISTORY_TRUNCATED"])
        );
        assert_eq!(
            capture.coverage(&json!("f"), &json!("n"))["complete"],
            false
        );
        capture.event(&event);
        let coverage = capture.coverage(&json!("f"), &json!("n"));
        assert_eq!(coverage["complete"], true);
        assert_eq!(coverage["scope"], "current-main-document-loader-http");
        assert_eq!(
            capture.coverage(&json!("other"), &json!("n"))["complete"],
            false
        );
        assert_eq!(
            capture.coverage(&json!("f"), &json!("old"))["complete"],
            false
        );
        capture.truncated = true;
        assert_eq!(
            capture.coverage(&json!("f"), &json!("n"))["reasons"],
            json!(["HISTORY_TRUNCATED"])
        );
        capture.navigation_starts.clear();
        assert_eq!(
            capture.coverage(&json!("f"), &json!("n"))["reasons"],
            json!(["NAVIGATION_START_NOT_OBSERVED", "HISTORY_TRUNCATED"])
        );
    }

    /// 合成已订阅的单目标采集器，复用真实事件与失效逻辑，不模拟 CDP 传输。
    fn ready_capture() -> NetworkCapture {
        NetworkCapture {
            session: "s".into(),
            target: "t".into(),
            entries: VecDeque::new(),
            truncated: false,
            console: VecDeque::new(),
            console_truncated: false,
            last_probe: None,
            ready: true,
            navigation_starts: VecDeque::new(),
            started_at: capture_time(),
        }
    }

    // 范围：缺失首跳、订阅未就绪、身份清空和完整重定向链；协议夹具不代表生产请求流完整。
    #[test]
    fn redirect_continuation_never_establishes_navigation_coverage() {
        let start = json!({"sessionId":"s","method":"Network.requestWillBeSent","params":{
            "requestId":"r","type":"Document","frameId":"f","loaderId":"n",
            "request":{"url":"https://fixture.test/start","method":"GET"}}});
        let mut redirect = start.clone();
        redirect["params"]["redirectResponse"] =
            json!({"status":302,"headers":{"Location":"/end"}});
        redirect["params"]["request"]["url"] = json!("https://fixture.test/end");
        let mut late = ready_capture();
        late.event(&redirect);
        assert_eq!(late.entries.len(), 1);
        assert_eq!(late.coverage(&json!("f"), &json!("n"))["complete"], false);
        assert_eq!(
            late.coverage(&json!("f"), &json!("n"))["reasons"],
            json!(["NAVIGATION_START_NOT_OBSERVED"])
        );
        let mut not_ready = ready_capture();
        not_ready.ready = false;
        not_ready.event(&start);
        not_ready.ready = true;
        not_ready.event(&redirect);
        assert_eq!(
            not_ready.coverage(&json!("f"), &json!("n"))["complete"],
            false
        );
        let mut full = ready_capture();
        full.event(&start);
        full.event(&redirect);
        assert_eq!(full.entries.len(), 2);
        assert_eq!(full.entries[0]["status"], 302);
        assert_eq!(full.coverage(&json!("f"), &json!("n"))["complete"], true);
        full.invalidate();
        full.event(&redirect);
        assert_eq!(full.entries.len(), 1);
        assert_eq!(full.coverage(&json!("f"), &json!("n"))["complete"], false);
        // 清空后只有新的非重定向导航首跳可以建立自己的完整窗口。
        let mut next = start;
        next["params"]["loaderId"] = json!("next");
        full.event(&next);
        assert_eq!(full.coverage(&json!("f"), &json!("next"))["complete"], true);
        assert_eq!(full.coverage(&json!("f"), &json!("n"))["complete"], false);
    }

    // 范围：断言错误、普通错误及异常均入账，忽略非错误类型/其他会话，并遵守容量与失效边界；不读取 Console 对象。
    #[test]
    fn console_assertions_are_captured_without_arguments() {
        let mut capture = ready_capture();
        for kind in ["log", "warn", "debug", "info", "trace", "assert", "error"] {
            capture.event(
                &json!({"sessionId":"s","method":"Runtime.consoleAPICalled","params":{
                "type":kind,"timestamp":1,"args":[{"value":"secret"}]}}),
            );
        }
        capture.event(&json!({"sessionId":"other","method":"Runtime.consoleAPICalled","params":{"type":"assert"}}));
        capture.event(&json!({"sessionId":"s","method":"Runtime.exceptionThrown","params":{"exceptionDetails":{"text":"Uncaught","lineNumber":1}}}));
        assert_eq!(capture.console.len(), 3);
        assert_eq!(capture.console[0]["message"], "console.assert");
        assert_eq!(capture.console[1]["message"], "console.error");
        assert_eq!(capture.console[2]["kind"], "Runtime.exceptionThrown");
        assert!(
            !serde_json::to_string(&capture.console)
                .unwrap()
                .contains("secret")
        );
        assert_eq!(capture.console_coverage()["complete"], true);
        assert!(
            capture.console_coverage()["eventTypes"]
                .as_array()
                .unwrap()
                .contains(&json!("Runtime.consoleAPICalled:assert"))
        );
        for _ in 0..CONSOLE_HISTORY {
            capture.event(&json!({"sessionId":"s","method":"Runtime.consoleAPICalled","params":{"type":"assert"}}));
        }
        assert_eq!(capture.console.len(), CONSOLE_HISTORY);
        assert_eq!(capture.console_coverage()["complete"], false);
        capture.invalidate();
        assert!(capture.console.is_empty());
        assert_eq!(capture.console_coverage()["complete"], true);
    }

    /// 真实隔离 Chromium 与本地 HTTP 验证断言采集、重定向缺口、跨观察保留和 tab 隔离；不连接业务站点或模型。
    #[tokio::test]
    #[ignore = "需要显式提供独立测试用 Chromium 路径"]
    async fn native_network_preserves_initial_response_and_navigation_scope() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let redirect_seen = Arc::new(tokio::sync::Notify::new());
        let redirect_release = Arc::new(tokio::sync::Notify::new());
        let seen = redirect_seen.clone();
        let release = redirect_release.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let seen = seen.clone();
                let release = release.clone();
                tokio::spawn(async move {
                    let mut request = [0u8; 8192];
                    let n = socket.read(&mut request).await.unwrap();
                    let request = String::from_utf8_lossy(&request[..n]);
                    let path = request.split_whitespace().nth(1).unwrap_or("");
                    if path == "/pending-redirect" || path == "/redirect" {
                        if path == "/pending-redirect" {
                            seen.notify_one();
                            release.notified().await;
                        }
                        socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: /redirected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
                        return;
                    }
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
        dom.call(Some(&session), "Runtime.evaluate", json!({"expression":"console.assert(true, 'silent'); console.assert(false, 'private-assert'); console.error('private-error');"})).await.unwrap();
        let console = dom.console_snapshot();
        assert_eq!(
            console["entries"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|e| e["message"] == "console.assert")
                .count(),
            1
        );
        assert_eq!(
            console["entries"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|e| e["message"] == "console.error")
                .count(),
            1
        );
        assert!(!console.to_string().contains("private-"));
        assert_eq!(dom.console_snapshot()["complete"], false);
        assert_eq!(dom.console_snapshot()["coverage"]["complete"], true);
        assert_eq!(first["complete"], false);
        assert_eq!(first["coverage"]["complete"], true);
        assert_eq!(first["coverage"]["navigationId"], first["navigationId"]);
        let second = dom.network_snapshot().await.unwrap();
        for request in first["requests"].as_array().unwrap() {
            // favicon 等异步请求可能在两次观察之间收到响应；身份和已知事实必须保留，
            // 尚未知的状态码允许被真实响应补齐，不能要求整条可增长记录完全相等。
            let retained = second["requests"]
                .as_array()
                .unwrap()
                .iter()
                .find(|next| next["requestId"] == request["requestId"])
                .expect("观察不能丢失已有请求");
            for (key, value) in request.as_object().unwrap() {
                if key == "status" && value.is_null() {
                    continue;
                }
                assert_eq!(&retained[key], value, "已有网络事实不能被覆盖：{key}");
            }
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
        assert_eq!(
            dom.network_snapshot().await.unwrap()["coverage"]["complete"],
            false
        );
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
        // 独立导航连接使采集器能在真实首跳尚未返回时失效；后续 302 不得补认缺失首跳。
        let mut navigator = Dom::connect(&format!("ws://127.0.0.1:{}{}", lines[0], lines[1]))
            .await
            .unwrap();
        let nav_session = navigator.attach(target).await.unwrap();
        let pending_url = format!("{url}/pending-redirect");
        let navigation = tokio::spawn(async move {
            navigator
                .call(
                    Some(&nav_session),
                    "Page.navigate",
                    json!({"url":pending_url}),
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), redirect_seen.notified())
            .await
            .unwrap();
        // Page.getFrameTree 会等待挂起的导航提交；通过浏览器级往返排空真实首跳事件，
        // 再调用同一底层失效函数模拟采集窗口切断，不声称生产人工输入能打断挂起导航。
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                dom.call(None, "Browser.getVersion", json!({}))
                    .await
                    .unwrap();
                if dom
                    .network
                    .as_ref()
                    .unwrap()
                    .entries
                    .iter()
                    .any(|r| r["url"] == format!("{url}/pending-redirect"))
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .unwrap();
        dom.network.as_mut().unwrap().invalidate();
        redirect_release.notify_one();
        tokio::time::timeout(Duration::from_secs(5), navigation)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let partial = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let snapshot = dom.network_snapshot().await.unwrap();
                if snapshot["requests"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["url"] == format!("{url}/redirected") && r["status"] == 200)
                {
                    break snapshot;
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(partial["coverage"]["complete"], false);
        assert_eq!(
            partial["coverage"]["reasons"],
            json!(["NAVIGATION_START_NOT_OBSERVED"])
        );
        assert!(
            !partial["requests"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["url"] == format!("{url}/pending-redirect"))
        );
        // 同一采集器随后观察到新导航的真实首跳，完整重定向链仍可证明范围内完整。
        dom.call(
            Some(&session),
            "Page.navigate",
            json!({"url":format!("{url}/redirect")}),
        )
        .await
        .unwrap();
        let full = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let snapshot = dom.network_snapshot().await.unwrap();
                if snapshot["requests"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["url"] == format!("{url}/redirected") && r["status"] == 200)
                {
                    break snapshot;
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(full["coverage"]["complete"], true);
        assert!(
            full["requests"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["url"] == format!("{url}/redirect") && r["status"] == 302)
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
