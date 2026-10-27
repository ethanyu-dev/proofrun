//! DOM 输入边界使用真实 WebSocket 注入故障；另有显式启用的本机 Chromium 取证验证。
use super::*;
use std::time::Duration;
use tokio::net::TcpListener;

/// 回环 CDP 夹具只模拟一个元素，记录方法调用以核实失败前没有派发输入。
async fn failed_action(action: &str, failure: &str, disconnect: bool) -> (Fault, Vec<Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("ws://{}", listener.local_addr().unwrap());
    let failure = failure.to_owned();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
        let mut calls = Vec::new();
        while let Some(Ok(Message::Text(text))) = socket.next().await {
            let call: Value = serde_json::from_str(&text).unwrap();
            let method = call["method"].as_str().unwrap();
            let script = call["params"]["functionDeclaration"].as_str().unwrap_or("");
            let label = if method == "Input.dispatchMouseEvent" {
                format!("{method}:{}", call["params"]["type"].as_str().unwrap())
            } else if script.contains("this.focus(") {
                "focus".into()
            } else if script.contains("this.options") {
                "select".into()
            } else {
                method.into()
            };
            calls.push(call.clone());
            if failure == "focus-denied" && label == "focus" {
                socket
                    .send(Message::Text(
                        json!({"id":call["id"],"result":{"result":{"value":false}}})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
                return calls;
            }
            if label == failure {
                if disconnect {
                    socket.close(None).await.unwrap();
                } else {
                    socket.send(Message::Text(json!({"id":call["id"],"error":{"code":-32000,"message":"private-page-and-cookie-value"}}).to_string().into())).await.unwrap();
                }
                return calls;
            }
            let result = match method {
                "DOM.resolveNode" => json!({"object":{"objectId":"fixture-node"}}),
                "Runtime.callFunctionOn" if script == INSPECT_CONTROL => {
                    json!({"result":{"value":{"visible":true,"connected":true,"disabled":false,"tag":"select","point":{"x":0.5,"y":0.5}}}})
                }
                "Runtime.callFunctionOn" => json!({"result":{"value":true}}),
                "DOM.getContentQuads" => json!({"quads":[[0,0,100,0,100,100,0,100]]}),
                "DOM.getNodeForLocation" => json!({"backendNodeId":1}),
                "Page.getLayoutMetrics" => json!({"cssLayoutViewport":{"pageX":0,"pageY":0}}),
                _ => json!({}),
            };
            socket
                .send(Message::Text(
                    json!({"id":call["id"],"result":result}).to_string().into(),
                ))
                .await
                .unwrap();
        }
        calls
    });
    let mut dom = Dom::connect(&endpoint).await.unwrap();
    dom.targets.insert(
        "dom-1".into(),
        Target {
            session: "fixture".into(),
            backend: 1,
            context: 1,
        },
    );
    let error = tokio::time::timeout(
        Duration::from_secs(5),
        dom.act("dom-1", action, Some("fixture")),
    )
    .await
    .unwrap()
    .unwrap_err();
    (error, server.await.unwrap())
}

// 范围：真实 CDP 传输中的定位/命中失败不派发输入，诊断不含原始错误；不证明生产页面故障的具体来源。
#[tokio::test]
async fn preparation_failure_keeps_session_without_dispatching_input() {
    for method in [
        "Runtime.callFunctionOn",
        "DOM.getContentQuads",
        "DOM.getNodeForLocation",
        "Page.getLayoutMetrics",
    ] {
        for disconnect in [false, true] {
            let (error, calls) = failed_action("click", method, disconnect).await;
            assert_eq!(error.code, "DOM_ACTION_PRECONDITION_FAILED");
            assert_eq!(error.effect, "NOT_STARTED");
            assert!(!error.requires_session_close(false));
            assert!(error.message.contains(method));
            assert!(!error.message.contains("private-page-and-cookie-value"));
            assert!(
                !calls
                    .iter()
                    .any(|c| c["method"].as_str().unwrap().starts_with("Input."))
            );
        }
    }
}

// 范围：鼠标移动、按下、抬起及聚焦/选择事件的回执不明仍须关闭；不自动重发，不模拟实际站点副作用。
#[tokio::test]
async fn dispatched_input_never_becomes_a_preparation_failure() {
    for (action, method) in [
        ("focus", "focus"),
        ("click", "Input.dispatchMouseEvent:mouseMoved"),
        ("click", "Input.dispatchMouseEvent:mousePressed"),
        ("click", "Input.dispatchMouseEvent:mouseReleased"),
        ("fill", "focus"),
        ("select", "select"),
    ] {
        for disconnect in [false, true] {
            let (error, _) = failed_action(action, method, disconnect).await;
            assert_eq!(error.code, "DOM_ENGINE_FAILED");
            assert_eq!(error.effect, "MAY_HAVE_HAPPENED");
            assert!(error.requires_session_close(false));
            assert!(!error.message.contains("private-page-and-cookie-value"));
        }
    }
}

// 范围：聚焦监听器转移焦点的 CDP 结果不能被当作成功；只模拟传输结果，真实焦点由回环 Chrome 场景覆盖。
#[tokio::test]
async fn unconfirmed_focus_stops_before_key_dispatch() {
    let (error, calls) = failed_action("focus", "focus-denied", false).await;
    assert_eq!(error.code, "KEYBOARD_FOCUS_UNCONFIRMED");
    assert!(!error.requires_session_close(false));
    assert_eq!(error.effect, "MAY_HAVE_HAPPENED");
    assert!(
        !calls
            .iter()
            .any(|call| call["method"].as_str().unwrap().starts_with("Input."))
    );
}

// 范围：声明缺失、读取未知与真实值区分；不按正文推断语言，也不覆盖站点自身声明准确性。
#[test]
fn language_is_a_document_declaration() {
    let strings = json!(["#document", "HTML", "lang", "zh-CN"]);
    let strings = strings.as_array().unwrap();
    let mut doc = json!({"nodes":{"nodeName":[0,1],"attributes":[[],[2,3]]}});
    assert_eq!(document_language(&doc, strings).as_deref(), Some("zh-CN"));
    doc["nodes"]["attributes"][1] = json!([]);
    assert_eq!(document_language(&doc, strings).as_deref(), Some(""));
    doc["nodes"]["attributes"][1] = json!([2]);
    assert_eq!(document_language(&doc, strings), None);
    assert_eq!(document_language(&json!({}), strings), None);
}

// 范围：真实隔离 Chromium 的文档语言、动态变化和部分可见点击；仅 data 页面，不包含生产登录、Linux 网关或模型推理。
#[tokio::test]
#[ignore = "需要显式提供独立测试用 Chromium 路径"]
async fn native_dom_preserves_language_and_clicks_visible_portion() {
    let profile = tempfile::tempdir().unwrap();
    let mut chrome = tokio::process::Command::new(std::env::var("PROOFRUN_TEST_CHROME").unwrap())
        .args([
            "--headless=new",
            // 仅此隔离 data 页面测试不依赖 Docker 宿主机的用户命名空间沙箱。
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
            tokio::time::sleep(Duration::from_millis(50)).await;
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
    let session = dom.attach(target).await.unwrap();
    dom.call(Some(&session), "Page.navigate", json!({"url":"data:text/html,<html lang='zh-CN'><button style='position:fixed;left:-150px;top:20px;width:200px;height:40px' onclick='window.clicks=(window.clicks||0)+1'>partial</button><iframe srcdoc=\"<html lang='en'><button>frame</button></html>\"></iframe></html>"})).await.unwrap();
    let captured = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let snapshot = dom.snapshot(target, None).await.unwrap();
            if snapshot["documents"]
                .as_array()
                .is_some_and(|docs| docs.iter().any(|d| d["lang"] == "en"))
            {
                break snapshot;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    let docs = captured["documents"].as_array().unwrap();
    assert_eq!(docs.len(), 2);
    assert_eq!(docs[0]["lang"], "zh-CN");
    assert_eq!(docs[0]["isMainFrame"], true);
    assert_eq!(docs[1]["lang"], "en");
    assert_eq!(docs[1]["isMainFrame"], false);
    assert_ne!(docs[0]["frameId"], docs[1]["frameId"]);
    let button = captured["targets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"].as_str().unwrap_or("").trim() == "partial")
        .unwrap()["target"]
        .as_str()
        .unwrap();
    dom.act(button, "click", None).await.unwrap();
    let result = dom
        .call(
            Some(&session),
            "Runtime.evaluate",
            json!({"expression":"({clicks:window.clicks,y:scrollY})","returnByValue":true}),
        )
        .await
        .unwrap();
    assert_eq!(result["result"]["value"]["clicks"], 1);
    assert_eq!(result["result"]["value"]["y"], 0);
    dom.call(
        Some(&session),
        "Runtime.evaluate",
        json!({"expression":"document.documentElement.lang='fr'"}),
    )
    .await
    .unwrap();
    let changed = dom.snapshot(target, None).await.unwrap();
    assert_eq!(changed["documents"][0]["lang"], "fr");
    dom.call(
        Some(&session),
        "Runtime.evaluate",
        json!({"expression":"document.documentElement.removeAttribute('lang')"}),
    )
    .await
    .unwrap();
    assert_eq!(
        dom.snapshot(target, None).await.unwrap()["documents"][0]["lang"],
        ""
    );
    // 范围：长页面滚动后的 FAQ 点击必须命中当前视口；不依赖生产页面或远端模型。
    dom.call(Some(&session), "Page.navigate", json!({"url":"data:text/html,<html><body style='margin:0;width:2000px'><div style='height:2200px'></div><div style='margin-left:1200px;width:200px;padding:24px;border:10px solid black' onclick='this.textContent=\"FAQ opened\"'>FAQ closed</div><div style='height:1000px'></div></body></html>"})).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    dom.call(
        Some(&session),
        "Runtime.evaluate",
        json!({"expression":"scrollTo(1000,2000)"}),
    )
    .await
    .unwrap();
    let snapshot = dom.snapshot(target, None).await.unwrap();
    let faq = snapshot["targets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "FAQ closed")
        .unwrap()["target"]
        .as_str()
        .unwrap();
    dom.act(faq, "click", None).await.unwrap();
    assert!(
        dom.snapshot(target, None).await.unwrap()["text"]
            .as_str()
            .unwrap()
            .contains("FAQ opened")
    );
    // 范围：滚动后固定元素命中与遮挡保护；不能把前置失败误判成已执行输入。
    dom.call(Some(&session), "Runtime.evaluate", json!({"expression":"document.body.insertAdjacentHTML('beforeend', `<button id='fixed' style='position:fixed;left:10px;top:10px' onclick='window.fixedClicks=(window.fixedClicks||0)+1'>fixed button</button>`);"})).await.unwrap();
    let snapshot = dom.snapshot(target, None).await.unwrap();
    let fixed = snapshot["targets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "fixed button")
        .unwrap()["target"]
        .as_str()
        .unwrap();
    dom.act(fixed, "click", None).await.unwrap();
    dom.call(Some(&session), "Runtime.evaluate", json!({"expression":"document.body.insertAdjacentHTML('beforeend', `<div style='position:fixed;inset:0;z-index:999;background:white'>cover</div>`);"})).await.unwrap();
    assert_eq!(
        dom.act(fixed, "click", None).await.unwrap_err().code,
        "TARGET_OBSCURED"
    );
    let clicks = dom
        .call(
            Some(&session),
            "Runtime.evaluate",
            json!({"expression":"window.fixedClicks","returnByValue":true}),
        )
        .await
        .unwrap();
    assert_eq!(clicks["result"]["value"], 1);
    // 范围：真实 Chromium 区分 FAQ 与固定浮窗，关联答案只在展开后提供，隐藏子内容不能成为引文；不覆盖生产框架变体。
    dom.call(Some(&session), "Page.navigate", json!({"url":"data:text/html,<main><section><h2>FAQ</h2><div><button aria-controls='answer' aria-expanded='false' onclick='this.setAttribute(\"aria-expanded\",\"true\");document.getElementById(\"answer\").hidden=false'>Question one</button><div id='answer' hidden>Visible answer<span hidden>Secret hidden answer</span></div></div></section><aside style='position:fixed;right:0;top:0'><button>Contact toggle</button></aside><details open><summary>Question two</summary><p>Details answer<span hidden>Hidden details</span></p><p hidden>Invisible block</p></details></main>"})).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let snapshot = dom.snapshot(target, None).await.unwrap();
    let targets = snapshot["targets"].as_array().unwrap();
    let faq = targets
        .iter()
        .find(|t| t["name"] == "Question one")
        .unwrap();
    assert_eq!(faq["context"]["heading"], "FAQ");
    assert_eq!(faq["disclosure"]["visible"], false);
    assert_eq!(faq["disclosure"]["text"], "");
    // 可见矩形随观察交付，供 Agent 比较滚动恢复条件，不代表命中检查已通过。
    assert!(faq["clip"]["bottom"].as_f64().unwrap() > faq["clip"]["top"].as_f64().unwrap());
    assert!(faq["clip"]["right"].as_f64().unwrap() > faq["clip"]["left"].as_f64().unwrap());
    let floating = targets
        .iter()
        .find(|t| t["name"] == "Contact toggle")
        .unwrap();
    assert_eq!(floating["context"]["heading"], "");
    assert_eq!(floating["context"]["fixed"], true);
    let details = targets
        .iter()
        .find(|t| t["name"] == "Question two")
        .unwrap();
    assert_eq!(details["disclosure"]["text"], "Details answer");
    dom.act(faq["target"].as_str().unwrap(), "click", None)
        .await
        .unwrap();
    let snapshot = dom.snapshot(target, None).await.unwrap();
    let answer = snapshot["targets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "Question one")
        .unwrap();
    assert_eq!(answer["disclosure"]["visible"], true);
    assert_eq!(answer["disclosure"]["text"], "Visible answer");
    // 范围：真实 Cookie 存储只清除精确站点和名字的全部路径，保留其他名字和子域；不证明生产注销效果。
    for (name, domain, path) in [
        ("locale", ".fixture.test", "/"),
        ("locale", "fixture.test", "/nested"),
        ("session", "fixture.test", "/"),
        ("locale", "child.fixture.test", "/"),
    ] {
        dom.set_cookie(
            target,
            json!({"name":name,"value":"private-fixture-value","domain":domain,"path":path}),
        )
        .await
        .unwrap();
    }
    dom.clear_cookies(target, &json!({"host":"fixture.test","names":["locale"]}))
        .await
        .unwrap();
    let remaining = dom
        .call(Some(&session), "Storage.getCookies", json!({}))
        .await
        .unwrap();
    let retained: Vec<_> = remaining["cookies"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["name"].as_str().unwrap(), c["domain"].as_str().unwrap()))
        .collect();
    assert_eq!(retained.len(), 2);
    assert!(retained.contains(&("session", "fixture.test")));
    assert!(retained.contains(&("locale", "child.fixture.test")));
    dom.clear_cookies(target, &json!({"host":"fixture.test","names":["locale"]}))
        .await
        .unwrap();
    // 范围：真实 Chromium 原生滑块收到按住移动与释放，事件可信；不访问或通过真实验证码。
    dom.call(Some(&session), "Runtime.evaluate", json!({"expression": "document.body.innerHTML='<input id=slider type=range min=0 max=100 value=0 style=\"position:fixed;left:0;top:0;width:300px;height:40px;margin:0\">';window.dragEvents=[];for(const type of ['mousedown','mousemove','mouseup'])document.addEventListener(type,e=>window.dragEvents.push({type:e.type,buttons:e.buttons,trusted:e.isTrusted}));"})).await.unwrap();
    let points = vec![
        json!({"x":10,"y":20,"atMs":0}),
        json!({"x":100,"y":20,"atMs":80}),
        json!({"x":250,"y":20,"atMs":160}),
    ];
    dom.drag(target, &points, Duration::from_secs(3))
        .await
        .unwrap();
    let slider = dom.call(Some(&session), "Runtime.evaluate", json!({"expression":"({value:Number(document.querySelector('#slider').value),events:window.dragEvents})","returnByValue":true})).await.unwrap();
    let slider = &slider["result"]["value"];
    assert!(slider["value"].as_u64().unwrap() > 70, "{slider}");
    let events = slider["events"].as_array().unwrap();
    assert_eq!(
        events.iter().filter(|e| e["type"] == "mousedown").count(),
        1
    );
    assert_eq!(events.iter().filter(|e| e["type"] == "mouseup").count(), 1);
    assert_eq!(
        events
            .iter()
            .filter(|e| e["type"] == "mousemove" && e["buttons"] == 1)
            .count(),
        2
    );
    assert_eq!(events.last().unwrap()["buttons"], 0);
    assert!(events.iter().all(|e| e["trusted"] == true));
    chrome.kill().await.unwrap();
    chrome.wait().await.unwrap();
}
