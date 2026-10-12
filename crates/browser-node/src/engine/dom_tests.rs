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
            } else if script.contains("this.focus()") {
                "focus".into()
            } else if script.contains("this.options") {
                "select".into()
            } else {
                method.into()
            };
            calls.push(call.clone());
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
    chrome.kill().await.unwrap();
    chrome.wait().await.unwrap();
}
