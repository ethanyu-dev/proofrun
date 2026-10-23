//! 通过会话私有 CDP 连接读取原生 DOM；元素身份绑定实际 backend node，不按名称重找替代节点。
#[path = "dom_cookies.rs"]
mod cookie_cleanup;
#[path = "dom_inspection.rs"]
mod inspection;
#[path = "dom_network.rs"]
mod network_capture;
use crate::error::{Fault, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use tokio::net::TcpStream;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message};

#[cfg(test)]
#[path = "dom_tests.rs"]
mod regression_tests;

/// 一次观察的正文和元素上限；裁剪必须显式返回，不能据缺失内容判失败。
const TEXT_LIMIT: usize = 200_000;
const TARGET_LIMIT: usize = 2000;
/// 目标描述单独限额，尤其防止包含大量下拉选项的页面突破网关消息上限。
const TARGET_BYTES: usize = 256_000;
/// Trace 流的文件上限与证据存储一致。
const TRACE_BYTES: usize = 64 * 1024 * 1024;
/// 单条 CDP 回复可大于平台观察，规范化后才发往控制面。
const CDP_LIMIT: usize = 32 * 1024 * 1024;
/// 只读探针同时检查可见性、控件状态与滚动范围，不接受调用者提供的脚本。
const INSPECT_CONTROL: &str = include_str!("inspect-control.js");
/// 点击命中验证包含有界的复合下拉展示层归属检查。
const CHECK_HIT: &str = include_str!("check-hit.js");
/// 定向按键前确认真实焦点；聚焦不会隐式滚动，也不代表后续业务校验已触发。
const FOCUS_FOR_PRESS: &str = include_str!("focus-for-press.js");
/// 每个真实文档独立的只读观察环境，隔离页面框架对 DOM 包装对象的重写。
const OBSERVATION_WORLD: &str = "proofrun-observation";
/// 仅保存少量异常的首行及节点身份，避免堆栈撑大模型上下文。
const INSPECTION_ERROR_SAMPLES: usize = 5;
/// 可操作角色采用明确白名单；通用 role 和继承的鼠标样式都不是点击证据。
const CONTROL_ROLES: &[&str] = &[
    "button",
    "link",
    "checkbox",
    "radio",
    "switch",
    "tab",
    "menuitem",
    "menuitemradio",
    "menuitemcheckbox",
    "option",
    "gridcell",
    "combobox",
    "textbox",
    "searchbox",
    "spinbutton",
    "slider",
    "treeitem",
];
/// 原生选项与字符串限制单独报告，不能静默宣称选项已读完。
const OPTION_LIMIT: usize = 200;
/// lang 仅是页面声明，不推断正文语言；异常长的声明按未知处理。
const LANGUAGE_CHARS: usize = 128;

/// 原生节点引用包含渲染进程会话；跨域 iframe 的 backend ID 不与主文档混用。
#[derive(Clone)]
struct Target {
    /// 节点所在渲染进程的私有 CDP 会话。
    session: String,
    /// Chromium 实际节点身份，不按选择器重新匹配。
    backend: i64,
    /// 由真实 frame 创建的隔离上下文；导航后随当前观察一并失效。
    context: i64,
}
/// 每份观察独占连接和节点映射；刷新或任何动作后由引擎丢弃。
pub struct Dom {
    /// 独立网络连接的有界历史；普通 DOM 连接不启用。
    network: Option<network_capture::NetworkCapture>,
    /// 仅连接当前隔离浏览器的本机调试端口。
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    /// 当前连接内单调增加的请求身份。
    next: u64,
    /// 本次观察中公开目标到实际节点的绑定。
    targets: HashMap<String, Target>,
    /// 当前标签页及其跨进程 iframe 会话，供条件等待复用。
    sessions: Vec<String>,
    /// Tracing.end 的完成通知可早于命令回复，必须保留而不能丢弃。
    trace_complete: Option<Value>,
}
impl Dom {
    /// 端点只能来自已启动的本机引擎，不接受任务或模型指定的调试地址。
    pub async fn connect(url: &str) -> Result<Self> {
        let parsed = reqwest::Url::parse(url).map_err(|_| fault())?;
        if parsed.scheme() != "ws"
            || !matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
        {
            return Err(Fault::rejected(
                "DOM_ENDPOINT",
                "expected private loopback CDP endpoint",
            ));
        }
        let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
            .max_message_size(Some(CDP_LIMIT))
            .max_frame_size(Some(CDP_LIMIT));
        let (socket, _) = tokio_tungstenite::connect_async_with_config(url, Some(config), false)
            .await
            .map_err(|_| fault())?;
        Ok(Self {
            socket,
            next: 0,
            targets: HashMap::new(),
            sessions: Vec::new(),
            trace_complete: None,
            network: None,
        })
    }
    /// 单会话内串行请求；其他通知不作为命令回复，传输未知不重发。
    async fn call(&mut self, session: Option<&str>, method: &str, params: Value) -> Result<Value> {
        self.next += 1;
        let id = self.next;
        let mut command = json!({"id":id,"method":method,"params":params});
        if let Some(session) = session {
            command["sessionId"] = json!(session);
        }
        self.socket
            .send(Message::Text(command.to_string().into()))
            .await
            .map_err(|_| cdp_fault(method, "send", None))?;
        while let Some(message) = self.socket.next().await {
            let message = message.map_err(|_| cdp_fault(method, "receive", None))?;
            if let Message::Text(text) = message {
                let value: Value =
                    serde_json::from_str(&text).map_err(|_| cdp_fault(method, "decode", None))?;
                if let Some(network) = &mut self.network {
                    network.event(&value);
                }
                if value["method"] == "Tracing.tracingComplete" {
                    self.trace_complete = Some(value["params"].clone());
                }
                if value["id"] == id {
                    if value.get("error").is_some() {
                        return Err(cdp_fault(
                            method,
                            "protocol",
                            value["error"]["code"].as_i64(),
                        ));
                    }
                    return Ok(value["result"].clone());
                }
            }
        }
        Err(cdp_fault(method, "closed", None))
    }
    /// 登录相关脚本固定在节点代码中，敏感参数只走 CDP arguments，不进入 CLI。
    async fn identity_call(
        &mut self,
        target: &str,
        function: &str,
        args: Vec<Value>,
    ) -> Result<Value> {
        let session = self.attach(target).await?;
        let object = self
            .call(
                Some(&session),
                "Runtime.evaluate",
                json!({"expression":"globalThis"}),
            )
            .await?;
        let result=self.call(Some(&session),"Runtime.callFunctionOn",json!({"objectId":object["result"]["objectId"],"functionDeclaration":function,"arguments":args.into_iter().map(|v|json!({"value":v})).collect::<Vec<_>>(),"returnByValue":true})).await?;
        if result.get("exceptionDetails").is_some() {
            return Ok(Value::Bool(false));
        }
        Ok(result["result"]["value"].clone())
    }
    /// 正文完整且存在正向身份标记才能自动确认，单纯“没看到退出按钮”不能证明角色。
    pub(super) async fn identity_probe(
        &mut self,
        target: &str,
        origin: &str,
        checks: &Value,
    ) -> Result<bool> {
        Ok(self.identity_call(target,"function(origin,checks){if(location.origin!==origin||document.readyState==='loading')return false;const text=document.body?.innerText||'';return text.length>0&&text.length<=200000&&checks.some(c=>c.method==='text')&&checks.every(c=>c.method==='text'?text.includes(c.value):!text.includes(c.value))}",vec![json!(origin),checks.clone()]).await?==true)
    }
    /// 登录成功标记必须可见，挑战页或旧 DOM 不能被当成成功回执。
    pub(super) async fn identity_ready(
        &mut self,
        target: &str,
        origin: &str,
        selector: &str,
    ) -> Result<bool> {
        Ok(self.identity_call(target,"function(origin,selector){if(location.origin!==origin)return false;const el=document.querySelector(selector);return !!el&&el.getClientRects().length>0}",vec![json!(origin),json!(selector)]).await?==true)
    }
    /// 只清除本 profile 指定源的状态；这是本地隔离，不代表站点服务端登出。
    pub(super) async fn identity_clear(&mut self, target: &str, origin: &str) -> Result<()> {
        let session = self.attach(target).await?;
        self.call(
            Some(&session),
            "Storage.clearDataForOrigin",
            json!({"origin":origin,"storageTypes":"all"}),
        )
        .await?;
        Ok(())
    }
    /// 表单签名及表单提交源同时核对，失败不会尝试其他选择器或凭据。
    pub(super) async fn identity_login(
        &mut self,
        target: &str,
        origin: &str,
        recipe: &Value,
        clear: bool,
    ) -> Result<bool> {
        Ok(self
            .identity_call(
                target,
                include_str!("identity-login.js"),
                vec![json!(origin), recipe.clone(), json!(clear)],
            )
            .await?
            == true)
    }
    /// 只接受节点生成的 Cookie 参数；通过当前页所属浏览器上下文写入，绝不回传 Cookie 值。
    pub async fn set_cookie(&mut self, target: &str, params: Value) -> Result<()> {
        let session = self.attach(target).await?;
        let result = self
            .call(Some(&session), "Network.setCookie", params)
            .await?;
        if result["success"] != true {
            return Err(Fault::rejected(
                "COOKIE_REJECTED",
                "browser rejected cookie",
            ));
        }
        Ok(())
    }
    /// 命中查询接受文档坐标，鼠标输入接受视口坐标；只在查询时补上当前渲染会话的滚动偏移。
    async fn hit_at(&mut self, session: &str, x: f64, y: f64) -> Result<Value> {
        let metrics = self
            .call(Some(session), "Page.getLayoutMetrics", json!({}))
            .await?;
        let viewport = &metrics["cssLayoutViewport"];
        let left = viewport["pageX"].as_f64().ok_or_else(fault)?;
        let top = viewport["pageY"].as_f64().ok_or_else(fault)?;
        self.call(Some(session), "DOM.getNodeForLocation", json!({
            "x":(x+left).round() as i64,"y":(y+top).round() as i64,"includeUserAgentShadowDOM":true
        })).await
    }
    /// 采集完整时间窗口的 timeline、用户标记、加载和截图；缓冲满时停止而非静默覆盖开头。
    pub async fn trace_start(&mut self) -> Result<()> {
        self.call(None, "Tracing.start", json!({
            "traceConfig":{"recordMode":"recordUntilFull","traceBufferSizeInKb":65536,
                "includedCategories":["devtools.timeline","v8.execute","blink.user_timing","loading","disabled-by-default-devtools.screenshot"],"excludedCategories":["*"]},
            "transferMode":"ReturnAsStream","streamFormat":"json"
        })).await?;
        Ok(())
    }
    /// 流式落盘并检查 Chromium 的丢失标记；超限或不完整的 trace 不得宣称交付成功。
    pub async fn trace_stop(&mut self, path: &std::path::Path) -> Result<()> {
        use tokio::io::AsyncWriteExt;
        self.call(None, "Tracing.end", json!({})).await?;
        while self.trace_complete.is_none() {
            let message = self
                .socket
                .next()
                .await
                .ok_or_else(fault)?
                .map_err(|_| fault())?;
            if let Message::Text(text) = message {
                let value: Value = serde_json::from_str(&text).map_err(|_| fault())?;
                if value["method"] == "Tracing.tracingComplete" {
                    self.trace_complete = Some(value["params"].clone());
                }
            }
        }
        let complete = self.trace_complete.take().unwrap();
        if complete["dataLossOccurred"] == true {
            return Err(Fault::rejected(
                "TRACE_INCOMPLETE",
                "Chromium trace buffer lost events",
            ));
        }
        let handle = complete["stream"].as_str().ok_or_else(fault)?;
        let mut file = tokio::fs::File::create(path).await.map_err(|_| fault())?;
        let mut length = 0;
        loop {
            let chunk = self
                .call(None, "IO.read", json!({"handle":handle,"size":262144}))
                .await?;
            let data = chunk["data"].as_str().ok_or_else(fault)?;
            length += data.len();
            if chunk["base64Encoded"] == true || length > TRACE_BYTES {
                return Err(Fault::rejected(
                    "TRACE_INCOMPLETE",
                    "trace exceeds supported JSON size",
                ));
            }
            file.write_all(data.as_bytes()).await.map_err(|_| fault())?;
            if chunk["eof"] == true {
                break;
            }
        }
        self.call(None, "IO.close", json!({"handle":handle}))
            .await?;
        file.sync_all().await.map_err(|_| fault())?;
        Ok(())
    }
    /// 使用扁平会话，允许在同一传输连接区分页面和 iframe 渲染进程。
    async fn attach(&mut self, target: &str) -> Result<String> {
        let result = self
            .call(
                None,
                "Target.attachToTarget",
                json!({"targetId":target,"flatten":true}),
            )
            .await?;
        result["sessionId"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(fault)
    }
    /// 在隔离上下文检查节点；仅为实际溢出且绑定 wheel 监听的 hidden 容器补充虚拟滚动能力。
    async fn inspect(&mut self, session: &str, object: &Value) -> Result<Value> {
        let facts = self.call(Some(session), "Runtime.callFunctionOn",
            json!({"objectId":object,"functionDeclaration":INSPECT_CONTROL,"returnByValue":true})).await?;
        if inspected_facts(&facts)
            .is_some_and(|v| v["visible"] == true && v["wheelCandidate"] == true)
        {
            // 监听器属于页面主世界；只在该世界查询 CDP 元数据，布局与动作仍使用隔离对象。
            let node = self
                .call(
                    Some(session),
                    "DOM.describeNode",
                    json!({"objectId":object}),
                )
                .await?;
            let page_object = self
                .call(
                    Some(session),
                    "DOM.resolveNode",
                    json!({"backendNodeId":node["node"]["backendNodeId"]}),
                )
                .await?;
            let events = self
                .call(
                    Some(session),
                    "DOMDebugger.getEventListeners",
                    json!({"objectId":page_object["object"]["objectId"]}),
                )
                .await?;
            self.call(
                Some(session),
                "Runtime.releaseObject",
                json!({"objectId":page_object["object"]["objectId"]}),
            )
            .await?;
            if events["listeners"].as_array().is_some_and(|listeners| {
                listeners.iter().any(|listener| {
                    matches!(listener["type"].as_str(), Some("wheel" | "mousewheel"))
                })
            }) {
                return self.call(Some(session), "Runtime.callFunctionOn",
                    json!({"objectId":object,"functionDeclaration":INSPECT_CONTROL,"arguments":[{"value":true}],"returnByValue":true})).await;
            }
        }
        Ok(facts)
    }
    /// 原生快照包含布局、字段值、无 ARIA 节点、开放及关闭 shadow tree；OOPIF 按所属 frame 单独采集。
    pub async fn snapshot(&mut self, target: &str, selected_frame: Option<&str>) -> Result<Value> {
        let main = self.attach(target).await?;
        let tree = self
            .call(Some(&main), "Page.getFrameTree", json!({}))
            .await?;
        let main_frame = tree["frameTree"]["frame"]["id"]
            .as_str()
            .ok_or_else(fault)?
            .to_owned();
        let mut frames = HashSet::new();
        collect_frames(&tree["frameTree"], &mut frames);
        let targets = self.call(None, "Target.getTargets", json!({})).await?;
        let mut sessions = vec![main];
        let mut attached = HashSet::new();
        // OOPIF 不一定出现在主进程 frame tree；沿父 frame 扩展，只接入当前页的后代。
        loop {
            let mut added = false;
            for target in targets["targetInfos"].as_array().ok_or_else(fault)? {
                let Some(id) = target["targetId"].as_str() else {
                    continue;
                };
                if target["type"] != "iframe" || attached.contains(id) {
                    continue;
                }
                let belongs = frames.contains(id)
                    || ["parentFrameId", "parentId"].iter().any(|key| {
                        target[key]
                            .as_str()
                            .is_some_and(|parent| frames.contains(parent))
                    });
                if !belongs {
                    continue;
                }
                let session = self.attach(id).await?;
                let tree = self
                    .call(Some(&session), "Page.getFrameTree", json!({}))
                    .await?;
                collect_frames(&tree["frameTree"], &mut frames);
                frames.insert(id.to_owned());
                attached.insert(id.to_owned());
                sessions.push(session);
                added = true;
            }
            if !added {
                break;
            }
        }
        let mut text = String::new();
        let mut documents = Vec::new();
        let mut descriptors = Vec::new();
        let mut descriptor_bytes = 0;
        let mut truncated = false;
        let mut controls_total = 0usize;
        let mut offscreen = 0usize;
        let mut omitted_controls = 0usize;
        let mut options_omitted = 0usize;
        let mut inspection_errors = 0usize;
        let mut inspection_error_samples = Vec::new();
        let mut excluded_reasons: HashMap<String, usize> = HashMap::new();
        let mut delegated_containers = 0usize;
        self.sessions = sessions.clone();
        for session in sessions {
            let snapshot = self
                .call(
                    Some(&session),
                    "DOMSnapshot.captureSnapshot",
                    json!({"computedStyles":["visibility","overflow-x","overflow-y"],"includeDOMRects":true}),
                )
                .await?;
            let strings = snapshot["strings"].as_array().ok_or_else(fault)?;
            let string = |v: &Value| -> String {
                v.as_u64()
                    .and_then(|i| strings.get(i as usize))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned()
            };
            for doc in snapshot["documents"].as_array().ok_or_else(fault)? {
                if selected_frame.is_some_and(|frame| string(&doc["frameId"]) != frame) {
                    continue;
                }
                // 与正文使用同一份原生快照，区分不同 frame 的声明，避免从翻译后的文字猜测 lang。
                documents.push(json!({"frameId":string(&doc["frameId"]),
                    "isMainFrame":string(&doc["frameId"]) == main_frame,
                    "url":string(&doc["documentURL"]),"lang":document_language(doc, strings)}));
                push_bounded(
                    &mut text,
                    &format!("\n[document {}]\n", string(&doc["documentURL"])),
                    &mut truncated,
                );
                // frame 身份来自 Chromium 快照，不能使用页面改写后的 ownerDocument 推断。
                let world = self
                    .call(
                        Some(&session),
                        "Page.createIsolatedWorld",
                        json!({"frameId":string(&doc["frameId"]),"worldName":OBSERVATION_WORLD}),
                    )
                    .await?;
                let context = world["executionContextId"].as_i64().ok_or_else(fault)?;
                let nodes = &doc["nodes"];
                let names = nodes["nodeName"].as_array().ok_or_else(fault)?;
                let mut visible = HashSet::new();
                let mut scroll_containers = HashSet::new();
                for (i, node) in doc["layout"]["nodeIndex"]
                    .as_array()
                    .ok_or_else(fault)?
                    .iter()
                    .enumerate()
                {
                    let Some(index) = node.as_u64().map(|n| n as usize) else {
                        continue;
                    };
                    let styles = &doc["layout"]["styles"][i];
                    if string(&styles[0]) == "hidden" || string(&styles[0]) == "collapse" {
                        continue;
                    }
                    visible.insert(index);
                    if [1, 2].iter().any(|j| {
                        matches!(string(&styles[*j]).as_str(), "auto" | "scroll" | "hidden")
                    }) {
                        scroll_containers.insert(index);
                    }
                }
                let clicks: HashSet<usize> = nodes["isClickable"]["index"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|n| n.as_u64().map(|i| i as usize))
                    .collect();
                let mut captions: HashMap<usize, String> = HashMap::new();
                for (i, name) in names.iter().enumerate() {
                    if !visible.contains(&i) || string(name) != "#text" {
                        continue;
                    }
                    let content = string(&nodes["nodeValue"][i]);
                    let mut parent = nodes["parentIndex"][i].as_i64().unwrap_or(-1);
                    for _ in 0..12 {
                        if parent < 0 {
                            break;
                        }
                        let caption = captions.entry(parent as usize).or_default();
                        if caption.len() < 512 {
                            caption.extend(content.trim().chars().take(512));
                            caption.push(' ');
                        }
                        parent = nodes["parentIndex"][parent as usize].as_i64().unwrap_or(-1);
                    }
                }
                let mut candidates =
                    inspection::candidates(nodes, strings, &visible, &clicks, &scroll_containers);
                let mut inspections = self
                    .inspect_controls(&session, context, nodes, &candidates)
                    .await?;
                for (i, name) in names.iter().enumerate() {
                    if !visible.contains(&i) {
                        continue;
                    }
                    let tag = string(name).to_lowercase();
                    if tag == "#text" {
                        let value = string(&nodes["nodeValue"][i]);
                        if !value.trim().is_empty() {
                            push_bounded(&mut text, value.trim(), &mut truncated);
                            push_bounded(&mut text, "\n", &mut truncated);
                        }
                        continue;
                    }
                    let Some(control) = candidates.remove(&i) else {
                        continue;
                    };
                    let inspection::Control {
                        attrs,
                        role,
                        native_control,
                        clickable,
                    } = control;
                    let mut label = captions.get(&i).cloned().unwrap_or_default();
                    if tag == "input" || tag == "textarea" || tag == "select" {
                        let parent = nodes["parentIndex"][i].as_u64().map(|n| n as usize);
                        if let Some(parent) = parent.filter(|p| string(&names[*p]) == "LABEL") {
                            label = captions.get(&parent).cloned().unwrap_or_default();
                        }
                        if let Some(id) = attrs.get("id") {
                            for (li, ln) in names.iter().enumerate() {
                                if string(ln) != "LABEL" {
                                    continue;
                                }
                                if nodes["attributes"][li].as_array().is_some_and(|a| {
                                    a.chunks(2).any(|p| {
                                        p.len() == 2
                                            && string(&p[0]) == "for"
                                            && string(&p[1]) == *id
                                    })
                                }) {
                                    label = captions.get(&li).cloned().unwrap_or_default();
                                    break;
                                }
                            }
                        }
                    }
                    let name = attrs
                        .get("aria-label")
                        .cloned()
                        .filter(|s| !s.is_empty())
                        .or_else(|| (!label.trim().is_empty()).then(|| label.trim().to_owned()))
                        .or_else(|| attrs.get("placeholder").cloned())
                        .or_else(|| attrs.get("title").cloned())
                        .or_else(|| attrs.get("id").cloned())
                        .unwrap_or_else(|| tag.clone());
                    let field = rare_value(&nodes["inputValue"], i)
                        .map(&string)
                        .unwrap_or_default();
                    let mut value = if attrs.get("type").is_some_and(|t| t == "password") {
                        "[redacted]".into()
                    } else {
                        field
                    };
                    let (object_id, inspected) = inspections.remove(&i).ok_or_else(fault)?;
                    let Some(facts) = inspected_facts(&inspected) else {
                        // 异常和未知不能计作隐藏；本轮不授予动作身份，由覆盖信息提示重新采集。
                        inspection_errors += 1;
                        if inspection_error_samples.len() < INSPECTION_ERROR_SAMPLES {
                            let reason = inspected["exceptionDetails"]["exception"]["description"]
                                .as_str()
                                .unwrap_or("missing or invalid visibility result");
                            inspection_error_samples.push(json!({"tag":tag,"backendNodeId":nodes["backendNodeId"][i],"frame":string(&doc["frameId"]),"reason":reason.lines().next().unwrap_or(reason).chars().take(240).collect::<String>()}));
                        }
                        continue;
                    };
                    if facts["visible"] != true {
                        offscreen += 1;
                        *excluded_reasons
                            .entry(
                                facts["visibilityReason"]
                                    .as_str()
                                    .unwrap_or("unknown")
                                    .to_owned(),
                            )
                            .or_default() += 1;
                        continue;
                    }
                    // 框架根容器的监听只负责事件委托，不能以整页文字作为点击目标。
                    let clickable = clickable
                        && (native_control
                            || CONTROL_ROLES.contains(&role.as_str())
                            || facts["delegatedContainer"] != true);
                    if !clickable
                        && !native_control
                        && facts["delegatedContainer"] == true
                        && !facts["scroll"].is_object()
                    {
                        delegated_containers += 1;
                        continue;
                    }
                    let mut operations = Vec::new();
                    if facts["disabled"] != true {
                        if tag == "iframe" {
                            operations.push("frame");
                        } else if tag == "select" {
                            operations.push("select");
                        } else if native_control
                            || facts["editable"] == true
                            || (clickable
                                && (!facts["scroll"].is_object()
                                    || CONTROL_ROLES.contains(&role.as_str())))
                        {
                            operations.push("click");
                            operations.push("hover");
                        }
                        if facts["editable"] == true {
                            operations.push("fill");
                            operations.push("type");
                        }
                        if role == "checkbox" {
                            operations.push("check");
                            operations.push("uncheck");
                        }
                    }
                    if facts["scroll"].is_object() && facts["disabled"] != true {
                        operations.push("scroll");
                    }
                    // 普通 overflow 容器只有真实溢出时才具有滚动能力。
                    if operations.is_empty() && !native_control && !clickable {
                        continue;
                    }
                    controls_total += 1;
                    if descriptors.len() >= TARGET_LIMIT {
                        omitted_controls += 1;
                        continue;
                    }
                    let mut options = Value::Null;
                    if tag == "select" {
                        let state = self.call(Some(&session), "Runtime.callFunctionOn", json!({"objectId":object_id,"functionDeclaration":"function(limit){return {value:this.value,total:this.options.length,options:Array.from(this.options).slice(0,limit).map(o=>({value:o.value,label:o.label.slice(0,256),selected:o.selected,disabled:o.disabled||!!o.closest(\"optgroup[disabled]\")}))}}","arguments":[{"value":OPTION_LIMIT}],"returnByValue":true})).await?;
                        value = state["result"]["value"]["value"]
                            .as_str()
                            .unwrap_or("")
                            .to_owned();
                        options = state["result"]["value"]["options"].clone();
                        options_omitted += state["result"]["value"]["total"]
                            .as_u64()
                            .unwrap_or(0)
                            .saturating_sub(OPTION_LIMIT as u64)
                            as usize;
                    }
                    let name = facts["label"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .unwrap_or(&name);
                    let name: String = name.chars().take(512).collect();
                    let value: String = value.chars().take(2048).collect();
                    let marker = {
                        let id = format!("dom-{}", self.targets.len() + 1);
                        // 比较身份绑定文档、frame 和实际节点；公开动作仍只接受本次 target。
                        let comparison_key = hex::encode(Sha256::digest(format!(
                            "{}:{}:{}:{}",
                            target,
                            string(&doc["frameId"]),
                            nodes["backendNodeId"][0],
                            nodes["backendNodeId"][i]
                        )));
                        let descriptor = json!({"target":id,"role":role,"name":name,"tag":tag,"value":value,"options":options,
                            "comparisonKey":comparison_key,"visible":true,"visibilityScope":"frame", "visibilityReason":facts["visibilityReason"],"ariaHidden":facts["ariaHidden"],"inert":facts["inert"],"operations":operations,
                            "disabled":facts["disabled"],"expanded":facts["expanded"],"checked":facts["checked"],
                            "context":facts["context"],"clip":facts["clip"],"disclosure":facts["disclosure"],"selected":facts["selected"],"activeRegion":facts["activeRegion"],"scroll":facts["scroll"],"region":facts["region"],"frame":string(&doc["frameId"])});
                        let bytes = descriptor.to_string().len();
                        if descriptor_bytes + bytes > TARGET_BYTES {
                            omitted_controls += 1;
                            continue;
                        }
                        descriptor_bytes += bytes;
                        self.targets.insert(
                            id.clone(),
                            Target {
                                session: session.clone(),
                                backend: nodes["backendNodeId"][i].as_i64().ok_or_else(fault)?,
                                context,
                            },
                        );
                        descriptors.push(descriptor);
                        format!(" [target={id}]")
                    };
                    push_bounded(
                        &mut text,
                        &format!(
                            "<{tag}>{marker} name={} value={}{}{}\n",
                            json!(name),
                            json!(value),
                            if attrs.contains_key("disabled") {
                                " disabled"
                            } else {
                                ""
                            },
                            if rare_value(&nodes["inputChecked"], i).is_some() {
                                " checked"
                            } else {
                                ""
                            }
                        ),
                        &mut truncated,
                    );
                }
            }
        }
        Ok(
            json!({"text":text,"targets":descriptors,"documents":documents,"truncated":truncated || omitted_controls > 0 || options_omitted > 0 || inspection_errors > 0,"source":"native-dom",
            "coverage":{"text":{"scope":"rendered DOM","truncated":truncated},
                "controls":{"scope":"frame viewport","total":controls_total,"returned":descriptors.len(),"omitted":omitted_controls,"outsideViewportOrHidden":offscreen,"excludedReasons":excluded_reasons,"inspectionErrors":inspection_errors,"inspectionErrorSamples":inspection_error_samples,"delegatedContainers":delegated_containers,"inspectionWorld":"isolated","parentFrameClipping":"same-origin verified; cross-origin unknown"},
                "options":{"omitted":options_omitted},"unrendered":"未知；未展开或虚拟列表未加载内容不在本次 DOM 中"}}),
        )
    }
    /// iframe 选择由实际节点解析，不能把任意字符串当成渲染进程身份。
    pub async fn frame(&mut self, id: &str) -> Result<String> {
        let target = self
            .targets
            .get(id)
            .cloned()
            .ok_or_else(|| Fault::rejected("INVALID_TARGET", "iframe target missing"))?;
        let result = self
            .call(
                Some(&target.session),
                "DOM.describeNode",
                json!({"backendNodeId":target.backend,"depth":1}),
            )
            .await?;
        if result["node"]["nodeName"] != "IFRAME" && result["node"]["nodeName"] != "FRAME" {
            return Err(Fault::rejected(
                "INVALID_TARGET",
                "frame requires an iframe element",
            ));
        }
        result["node"]["contentDocument"]["frameId"]
            .as_str()
            .or_else(|| result["node"]["frameId"].as_str())
            .map(str::to_owned)
            .ok_or_else(fault)
    }
    /// 条件等待遍历本次页所属渲染会话和所有 shadow 根；不读取其它标签页。
    pub async fn condition(
        &mut self,
        selector: &str,
        text: &str,
        frame: Option<&str>,
    ) -> Result<bool> {
        for session in self.sessions.clone() {
            let tree = self
                .call(
                    Some(&session),
                    "DOM.getDocument",
                    json!({"depth":-1,"pierce":true}),
                )
                .await?;
            let mut roots = Vec::new();
            collect_roots(&tree["root"], None, frame, &mut roots);
            for backend in roots {
                let object = self
                    .call(
                        Some(&session),
                        "DOM.resolveNode",
                        json!({"backendNodeId":backend}),
                    )
                    .await?;
                let result=self.call(Some(&session),"Runtime.callFunctionOn",json!({"objectId":object["object"]["objectId"],"functionDeclaration":"function(selector,text){try{return Array.from(this.querySelectorAll(selector)).some(el=>(el.textContent||'').includes(text))}catch{return null}}","arguments":[{"value":selector},{"value":text}],"returnByValue":true})).await?;
                if result["result"]["value"] == true {
                    return Ok(true);
                }
                if result["result"]["value"].is_null() {
                    return Err(Fault::rejected("INVALID_ARGUMENT", "invalid CSS selector"));
                }
            }
        }
        Ok(false)
    }
    /// 只确认本次观察中的平台身份，不接受原始 CDP 或 CLI 节点编号。
    pub fn owns(&self, target: &str) -> bool {
        self.targets.contains_key(target)
    }
    /// 目标滚动必须命中已观察到的真实溢出容器；命令成功与滚动位移分别返回。
    pub async fn scroll(&mut self, target: &str, direction: &str) -> Result<Value> {
        let target = self
            .targets
            .get(target)
            .cloned()
            .ok_or_else(|| Fault::rejected("INVALID_TARGET", "unknown scroll target"))?;
        let resolved = self
            .call(
                Some(&target.session),
                "DOM.resolveNode",
                json!({"backendNodeId":target.backend,"executionContextId":target.context}),
            )
            .await?;
        let object = resolved["object"]["objectId"].clone();
        let read = self.inspect(&target.session, &object).await?;
        let before = inspected_facts(&read).ok_or_else(fault)?.clone();
        if before["visible"] != true || !before["scroll"].is_object() {
            return Err(Fault::rejected(
                "INVALID_SCROLL_TARGET",
                "choose a visible target with scroll capability",
            ));
        }
        let px = before["point"]["x"].as_f64().ok_or_else(fault)?;
        let py = before["point"]["y"].as_f64().ok_or_else(fault)?;
        let bounds = self
            .call(
                Some(&target.session),
                "DOM.getContentQuads",
                json!({"objectId":object}),
            )
            .await?;
        let quad = bounds["quads"][0]
            .as_array()
            .filter(|q| q.len() == 8)
            .ok_or_else(fault)?;
        let q = |i: usize| quad[i].as_f64().ok_or_else(fault);
        let x = q(0)? + px * (q(2)? - q(0)?) + py * (q(6)? - q(0)?);
        let y = q(1)? + px * (q(3)? - q(1)?) + py * (q(7)? - q(1)?);
        // 只使用探针实际可见区域内的点；shadow 内部命中沿组合树核实归属。
        let hit = self.hit_at(&target.session, x, y).await?;
        let hit = self
            .call(
                Some(&target.session),
                "DOM.resolveNode",
                json!({"backendNodeId":hit["backendNodeId"],"executionContextId":target.context}),
            )
            .await?;
        let check = self.call(Some(&target.session), "Runtime.callFunctionOn",
            json!({"objectId":object,"functionDeclaration":"function(hit){for(let n=hit;n;n=n.parentNode||n.host){if(n===this)return true}return false}","arguments":[{"objectId":hit["object"]["objectId"]}],"returnByValue":true})).await?;
        if check["result"]["value"] != true {
            return Err(Fault::rejected(
                "TARGET_OBSCURED",
                "scroll container is covered",
            ));
        }
        let (direction, distance) = super::scroll::parse(direction)?;
        let (dx, dy) = match direction {
            "down" => (0, distance),
            "up" => (0, -distance),
            "right" => (distance, 0),
            "left" => (-distance, 0),
            _ => {
                return Err(Fault::rejected(
                    "INVALID_ARGUMENT",
                    "invalid scroll direction",
                ));
            }
        };
        self.call(
            Some(&target.session),
            "Input.dispatchMouseEvent",
            json!({"type":"mouseWheel","x":x,"y":y,"deltaX":dx,"deltaY":dy}),
        )
        .await?;
        // 派发后只读等待短暂布局更新；失败不能假装操作尚未开始或自动重放。
        let after = self.call(Some(&target.session), "Runtime.callFunctionOn",
            json!({"objectId":object,"functionDeclaration":"function(){return new Promise(resolve=>setTimeout(()=>resolve({x:this.scrollLeft,y:this.scrollTop}),100))}","awaitPromise":true,"returnByValue":true})).await?;
        let after = &after["result"]["value"];
        Ok(
            json!({"performed":true,"scroll":{"before":before["scroll"],"after":after,
            "moved":before["scroll"]["x"] != after["x"] || before["scroll"]["y"] != after["y"]}}),
        )
    }
    /// 每次操作再次核实真实节点仍连接；不能按同名、相同位置或新 DOM 节点自动替换。
    pub async fn act(&mut self, target: &str, action: &str, value: Option<&str>) -> Result<()> {
        let mut input_started = false;
        self.act_inner(target, action, value, &mut input_started)
            .await
            .map_err(|error| {
                if !input_started && error.code == "DOM_ENGINE_FAILED" {
                    // 定位/命中检查失败时尚未派发目标输入，允许重取观察；不复用本次元素身份。
                    Fault::rejected("DOM_ACTION_PRECONDITION_FAILED", error.message)
                } else {
                    error
                }
            })
    }
    /// 在可能触发页面监听器的首个请求之前标记输入开始，回复丢失也不能降级成可重试。
    async fn act_inner(
        &mut self,
        target: &str,
        action: &str,
        value: Option<&str>,
        input_started: &mut bool,
    ) -> Result<()> {
        let target = self
            .targets
            .get(target)
            .cloned()
            .ok_or_else(|| Fault::rejected("INVALID_TARGET", "unknown DOM target"))?;
        let object = self
            .call(
                Some(&target.session),
                "DOM.resolveNode",
                json!({"backendNodeId":target.backend,"executionContextId":target.context}),
            )
            .await
            .map_err(|_| Fault::rejected("STALE_OBSERVATION", "DOM target no longer exists"))?;
        let object_id = object["object"]["objectId"]
            .as_str()
            .ok_or_else(fault)?
            .to_owned();
        let state = self.inspect(&target.session, &json!(object_id)).await?;
        let state = inspected_facts(&state).ok_or_else(fault)?;
        if state["connected"] != true || state["disabled"] == true {
            return Err(Fault::rejected(
                "STALE_OBSERVATION",
                "DOM target detached or disabled",
            ));
        }
        if state["visible"] != true {
            return Err(Fault::rejected(
                "TARGET_OBSCURED",
                "DOM target is no longer visible; observe again",
            ));
        }
        if ["check", "uncheck"].contains(&action) && state["checked"] == (action == "check") {
            return Ok(());
        }
        if action == "focus" {
            // focus 监听器可能转移焦点、导航或移除目标，派发后失败不能当作未执行重试。
            *input_started = true;
            let focused = self.call(Some(&target.session), "Runtime.callFunctionOn",
                json!({"objectId":object_id,"functionDeclaration":FOCUS_FOR_PRESS,"returnByValue":true})).await?;
            if focused.get("exceptionDetails").is_some() || focused["result"]["value"] != true {
                return Err(Fault::unknown(
                    "KEYBOARD_FOCUS_UNCONFIRMED",
                    "target focus was not confirmed; key was not dispatched",
                ));
            }
            return Ok(());
        }
        if action == "select" {
            if state["tag"] != "select" {
                return Err(Fault::rejected(
                    "INVALID_TARGET",
                    "select requires a native select; click a custom dropdown and observe its options",
                ));
            }
            *input_started = true;
            let result=self.call(Some(&target.session),"Runtime.callFunctionOn",json!({"objectId":object_id,"functionDeclaration":"function(value){const option=Array.from(this.options).find(o=>o.value===value||o.label===value);if(!option)return false;this.value=option.value;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return true}","arguments":[{"value":value.unwrap_or("")}],"returnByValue":true})).await?;
            if result.get("exceptionDetails").is_some() {
                return Err(cdp_fault("Runtime.callFunctionOn", "exception", None));
            }
            if result["result"]["value"] != true {
                return Err(Fault::rejected(
                    "INVALID_TARGET",
                    "select option not present",
                ));
            }
            return Ok(());
        }
        // 目标已经通过视口可见检查，不在准备阶段隐式滚动页面；滚动监听器也可能改变业务状态。
        // 部分可见目标使用探针的可见区域，离屏目标由 Agent 显式滚动并重新观察。
        if ["fill", "type"].contains(&action) {
            // focus 本身会触发监听器，因此不能等到 insertText 才标记副作用边界。
            *input_started = true;
            let ready = self.call(Some(&target.session),"Runtime.callFunctionOn",json!({"objectId":object_id,"functionDeclaration":"function(){if(this.readOnly||(!this.isContentEditable&&!['input','textarea'].includes(this.localName)))return false;this.focus();return true}","returnByValue":true})).await?;
            if ready.get("exceptionDetails").is_some() {
                return Err(cdp_fault("Runtime.callFunctionOn", "exception", None));
            }
            if ready["result"]["value"] != true {
                return Err(Fault::rejected("INVALID_TARGET", "target is not editable"));
            }
            if action == "fill" {
                self.call(Some(&target.session),"Input.dispatchKeyEvent",json!({"type":"keyDown","key":"a","code":"KeyA","modifiers":2,"commands":["selectAll"]})).await?;
                self.call(
                    Some(&target.session),
                    "Input.dispatchKeyEvent",
                    json!({"type":"keyUp","key":"a","code":"KeyA","modifiers":2}),
                )
                .await?;
            }
            self.call(
                Some(&target.session),
                "Input.insertText",
                json!({"text":value.unwrap_or("")}),
            )
            .await?;
        } else {
            let bounds = self
                .call(
                    Some(&target.session),
                    "DOM.getContentQuads",
                    json!({"objectId":object_id}),
                )
                .await?;
            let quad = bounds["quads"][0]
                .as_array()
                .filter(|q| q.len() == 8)
                .ok_or_else(|| {
                    Fault::rejected("TARGET_OBSCURED", "target has no visible bounds")
                })?;
            let px = state["point"]["x"].as_f64().ok_or_else(fault)?;
            let py = state["point"]["y"].as_f64().ok_or_else(fault)?;
            let q = |index: usize| quad[index].as_f64().ok_or_else(fault);
            let x = q(0)? + px * (q(2)? - q(0)?) + py * (q(6)? - q(0)?);
            let y = q(1)? + px * (q(3)? - q(1)?) + py * (q(7)? - q(1)?);
            // 在输入派发前核实遮挡；跨 shadow host 以 composed ancestors 判断目标关系。
            let hit = self.hit_at(&target.session, x, y).await?;
            let hit_object = self
                .call(
                    Some(&target.session),
                    "DOM.resolveNode",
                    json!({"backendNodeId":hit["backendNodeId"],"executionContextId":target.context}),
                )
                .await?;
            let check=self.call(Some(&target.session),"Runtime.callFunctionOn",json!({"objectId":object_id,"functionDeclaration":CHECK_HIT,"arguments":[{"objectId":hit_object["object"]["objectId"]}],"returnByValue":true})).await?;
            if check["result"]["value"] != true {
                return Err(Fault::rejected(
                    "TARGET_OBSCURED",
                    "DOM target is covered; observe before choosing another action",
                ));
            }
            *input_started = true;
            self.call(
                Some(&target.session),
                "Input.dispatchMouseEvent",
                json!({"type":"mouseMoved","x":x,"y":y}),
            )
            .await?;
            if action != "hover" {
                for event in ["mousePressed", "mouseReleased"] {
                    self.call(
                        Some(&target.session),
                        "Input.dispatchMouseEvent",
                        json!({"type":event,"x":x,"y":y,"button":"left","clickCount":1}),
                    )
                    .await?;
                }
            }
        }
        Ok(())
    }
}
/// 只接受明确返回的可见性事实；脚本异常、空结果和格式错误均保留为未知。
fn inspected_facts(response: &Value) -> Option<&Value> {
    if response.get("exceptionDetails").is_some() {
        return None;
    }
    let facts = &response["result"]["value"];
    facts["visible"].as_bool()?;
    Some(facts)
}

/// 快照稀疏字段通过 index/value 关联，不能把节点序号当作值数组下标。
fn rare_value(value: &Value, index: usize) -> Option<&Value> {
    let i = value["index"]
        .as_array()?
        .iter()
        .position(|n| n.as_u64() == Some(index as u64))?;
    value["value"]
        .as_array()
        .and_then(|v| v.get(i))
        .or(Some(&Value::Null))
}
/// 收集已确认属于页面的 frame 身份，作为跨进程子帧关联的起点。
fn collect_frames(tree: &Value, frames: &mut HashSet<String>) {
    if let Some(id) = tree["frame"]["id"].as_str() {
        frames.insert(id.to_owned());
    }
    for child in tree["childFrames"].as_array().into_iter().flatten() {
        collect_frames(child, frames);
    }
}
/// CDP 传输失败可能发生于输入派发之后，默认保留未知效果，绝不重试输入。
fn fault() -> Fault {
    Fault::unknown("DOM_ENGINE_FAILED", "native DOM command failed")
}

/// 只保留内部方法名、传输阶段和数字错误码，不透传可能夹带页面内容或凭据的 CDP 原文。
fn cdp_fault(method: &str, stage: &str, code: Option<i64>) -> Fault {
    Fault::unknown(
        "DOM_ENGINE_FAILED",
        format!(
            "CDP {method} {stage}{}",
            code.map(|c| format!(" ({c})")).unwrap_or_default()
        ),
    )
}

/// 空字符串表示 HTML 未声明 lang；缺少 HTML 节点或属性格式损坏时返回未知。
fn document_language(doc: &Value, strings: &[Value]) -> Option<String> {
    let string = |value: &Value| strings.get(value.as_u64()? as usize)?.as_str();
    let nodes = &doc["nodes"];
    let index = nodes["nodeName"]
        .as_array()?
        .iter()
        .position(|name| string(name) == Some("HTML"))?;
    let attributes = nodes["attributes"][index].as_array()?;
    if attributes.len() % 2 != 0 {
        return None;
    }
    for pair in attributes.as_chunks::<2>().0 {
        if string(&pair[0])? == "lang" {
            let value = string(&pair[1])?;
            return (value.chars().count() <= LANGUAGE_CHARS).then(|| value.to_owned());
        }
    }
    Some(String::new())
}

/// 保留每个 document/shadow root 的真实 backend 身份，并按所属 frame 过滤。
fn collect_roots(
    node: &Value,
    inherited: Option<&str>,
    selected: Option<&str>,
    roots: &mut Vec<i64>,
) {
    let frame = node["frameId"].as_str().or(inherited);
    if matches!(node["nodeType"].as_i64(), Some(9 | 11))
        && selected.is_none_or(|id| frame == Some(id))
        && let Some(id) = node["backendNodeId"].as_i64()
    {
        roots.push(id);
    }
    for key in ["children", "shadowRoots"] {
        for child in node[key].as_array().into_iter().flatten() {
            collect_roots(child, frame, selected, roots);
        }
    }
    if node["contentDocument"].is_object() {
        collect_roots(&node["contentDocument"], frame, selected, roots);
    }
}

/// UTF-8 安全裁剪单个巨型文本节点，避免单次追加突破观察预算。
fn push_bounded(text: &mut String, value: &str, truncated: &mut bool) {
    let available = TEXT_LIMIT.saturating_sub(text.len());
    let mut end = value.len().min(available);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    text.push_str(&value[..end]);
    *truncated |= end < value.len();
}

#[cfg(test)]
mod inspection_tests {
    use super::inspected_facts;
    use serde_json::json;

    // 范围：模拟 CDP 回复，隐藏是有效事实而异常/缺失/错误类型为未知；不模拟真实浏览器隔离性。
    #[test]
    fn probe_failure_is_not_a_hidden_control() {
        let hidden =
            json!({"result":{"value":{"visible":false,"visibilityReason":"outside_viewport"}}});
        assert_eq!(inspected_facts(&hidden).unwrap()["visible"], false);
        assert!(
            inspected_facts(&json!({"result":{"value":{"visible":true}},"exceptionDetails":{}}))
                .is_none()
        );
        assert!(inspected_facts(&json!({"result":{"type":"undefined"}})).is_none());
        assert!(inspected_facts(&json!({"result":{"value":{"visible":"false"}}})).is_none());
    }
}

#[cfg(test)]
mod cookie_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // 范围：真实本地 Chromium 写入及 HTTP 请求携带 HttpOnly Cookie；不覆盖生产 SSO、MFA 或服务端凭据有效性。
    #[tokio::test]
    #[ignore = "需要显式提供独立测试用 Chromium 路径"]
    async fn cookie_reaches_request_in_private_browser() {
        let binary = std::env::var("PROOFRUN_TEST_CHROME").expect("test Chromium path");
        let profile = tempfile::tempdir().unwrap();
        let mut chrome = tokio::process::Command::new(binary)
            .args([
                "--headless=new",
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
        let active = profile.path().join("DevToolsActivePort");
        let metadata = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                if let Ok(s) = tokio::fs::read_to_string(&active).await {
                    break s;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
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
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let params = crate::engine::cookies::parameters(
            &json!({"url":url,"name":"proofrun_test","value":"fixture_only","httpOnly":true}),
        )
        .unwrap();
        dom.set_cookie(target, params).await.unwrap();
        let readable = crate::engine::cookies::parameters(
            &json!({"url":url,"name":"readable_test","value":"visible_fixture","httpOnly":false}),
        )
        .unwrap();
        dom.set_cookie(target, readable).await.unwrap();
        let received = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = vec![0; 16384];
            let length = stream.read(&mut buffer).await.unwrap();
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 13\r\nConnection: close\r\n\r\n<html></html>").await.unwrap();
            String::from_utf8_lossy(&buffer[..length]).to_string()
        });
        let session = dom.attach(target).await.unwrap();
        dom.call(Some(&session), "Page.navigate", json!({"url":url}))
            .await
            .unwrap();
        let request = tokio::time::timeout(std::time::Duration::from_secs(5), received)
            .await
            .unwrap()
            .unwrap();
        assert!(
            request
                .to_lowercase()
                .contains("cookie: proofrun_test=fixture_only")
        );
        let script = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let probe = dom.call(Some(&session), "Runtime.evaluate", json!({"expression":"({url:location.href,ready:document.readyState,cookie:document.cookie})","returnByValue":true})).await.unwrap();
                if probe["result"]["value"]["url"] == url && probe["result"]["value"]["ready"] != "loading" { break probe; }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        }).await.unwrap();
        let visible = script["result"]["value"]["cookie"].as_str().unwrap();
        assert!(visible.contains("readable_test=visible_fixture"));
        assert!(!visible.contains("proofrun_test"));
        chrome.kill().await.unwrap();
        chrome.wait().await.unwrap();
    }
}
