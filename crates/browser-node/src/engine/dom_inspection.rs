//! 原生节点先按有界窗口解析，再在隔离世界批量读取，避免每个控件串行等待两次渲染进程。
use super::*;

/// 限制同时在途的 CDP 请求和一次脚本的节点数，避免大页面形成无界队列。
const INSPECTION_BATCH: usize = 64;
/// 批量包装仍调用原有隔离探针，不另写一套可见性规则。
const INSPECT_CONTROLS: &str = include_str!("inspect-controls.js");

/// 从同一份原生快照提取的候选信息；动作身份仍绑定 backendNodeId。
pub(super) struct Control {
    /// 快照中的属性，不重新按选择器寻找节点。
    pub attrs: HashMap<String, String>,
    /// 原生语义或显式 ARIA 角色。
    pub role: String,
    /// 是否属于原生交互元素。
    pub native_control: bool,
    /// 是否具有明确角色或实际监听器提供的点击证据。
    pub clickable: bool,
}

/// 候选筛选与可见性检查分离；布局存在不代表控件处于视口或可被点击。
pub(super) fn candidates(
    nodes: &Value,
    strings: &[Value],
    visible: &HashSet<usize>,
    clicks: &HashSet<usize>,
    scroll: &HashSet<usize>,
) -> HashMap<usize, Control> {
    let string = |v: &Value| {
        v.as_u64()
            .and_then(|i| strings.get(i as usize))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    nodes["nodeName"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(i, name)| {
            let tag = string(name).to_lowercase();
            if !visible.contains(&i)
                || tag.starts_with('#')
                || tag.starts_with("::")
                || ["script", "style", "head"].contains(&tag.as_str())
            {
                return None;
            }
            let attrs: HashMap<String, String> = nodes["attributes"][i]
                .as_array()
                .map(|items| {
                    items
                        .chunks(2)
                        .filter(|p| p.len() == 2)
                        .map(|p| (string(&p[0]), string(&p[1])))
                        .collect()
                })
                .unwrap_or_default();
            let role = attrs
                .get("role")
                .cloned()
                .unwrap_or_else(|| match tag.as_str() {
                    "input" => match attrs.get("type").map(String::as_str).unwrap_or("text") {
                        "checkbox" => "checkbox",
                        "radio" => "radio",
                        "button" | "submit" => "button",
                        _ => "textbox",
                    }
                    .into(),
                    "textarea" => "textbox".into(),
                    "select" => "combobox".into(),
                    "a" => "link".into(),
                    "iframe" => "iframe".into(),
                    "button" | "option" => tag.clone(),
                    _ => "element".into(),
                });
            let native_control = [
                "input", "textarea", "select", "button", "a", "option", "summary", "iframe",
            ]
            .contains(&tag.as_str());
            let clickable = CONTROL_ROLES.contains(&role.as_str())
                || (clicks.contains(&i)
                    && !["html", "body", "svg", "path"].contains(&tag.as_str()));
            let interactive = native_control
                || clickable
                || scroll.contains(&i)
                || attrs.get("contenteditable").is_some_and(|v| v != "false");
            (interactive
                && !attrs
                    .get("type")
                    .is_some_and(|t| ["file", "hidden"].contains(&t.as_str())))
            .then_some((
                i,
                Control {
                    attrs,
                    role,
                    native_control,
                    clickable,
                },
            ))
        })
        .collect()
}

impl Dom {
    /// 只流水发送只读节点解析，回复按 id 归位；通知照常处理，失败不重发或换节点。
    async fn resolve_controls(
        &mut self,
        session: &str,
        context: i64,
        backends: &[Value],
    ) -> Result<Vec<Value>> {
        let mut pending = HashMap::new();
        for (index, backend) in backends.iter().enumerate() {
            self.next += 1;
            pending.insert(self.next, index);
            self.socket
                .feed(Message::Text(
                    json!({"id":self.next,"sessionId":session,"method":"DOM.resolveNode",
                "params":{"backendNodeId":backend,"executionContextId":context}})
                    .to_string()
                    .into(),
                ))
                .await
                .map_err(|_| cdp_fault("DOM.resolveNode", "send", None))?;
        }
        self.socket
            .flush()
            .await
            .map_err(|_| cdp_fault("DOM.resolveNode", "send", None))?;
        let mut results = vec![Value::Null; backends.len()];
        while !pending.is_empty() {
            let message = self
                .socket
                .next()
                .await
                .ok_or_else(|| cdp_fault("DOM.resolveNode", "closed", None))?
                .map_err(|_| cdp_fault("DOM.resolveNode", "receive", None))?;
            let Message::Text(text) = message else {
                continue;
            };
            let value: Value = serde_json::from_str(&text)
                .map_err(|_| cdp_fault("DOM.resolveNode", "decode", None))?;
            if let Some(network) = &mut self.network {
                network.event(&value);
            }
            if value["method"] == "Tracing.tracingComplete" {
                self.trace_complete = Some(value["params"].clone());
            }
            if let Some(index) = value["id"].as_u64().and_then(|id| pending.remove(&id)) {
                if value.get("error").is_some() {
                    return Err(cdp_fault(
                        "DOM.resolveNode",
                        "protocol",
                        value["error"]["code"].as_i64(),
                    ));
                }
                results[index] = value["result"]["object"]["objectId"].clone();
                if !results[index].is_string() {
                    return Err(fault());
                }
            }
        }
        Ok(results)
    }

    /// 同一批仅一次布局探针；异常逐节点报告，wheel 特例继续核验主世界监听器。
    pub(super) async fn inspect_controls(
        &mut self,
        session: &str,
        context: i64,
        nodes: &Value,
        controls: &HashMap<usize, Control>,
    ) -> Result<HashMap<usize, (Value, Value)>> {
        let mut indices: Vec<_> = controls.keys().copied().collect();
        indices.sort_unstable();
        let function = INSPECT_CONTROLS.replace("__PROOFRUN_INSPECT_CONTROL__", INSPECT_CONTROL);
        let mut inspections = HashMap::new();
        for batch in indices.chunks(INSPECTION_BATCH) {
            let backends: Vec<_> = batch
                .iter()
                .map(|i| nodes["backendNodeId"][*i].clone())
                .collect();
            let objects = self.resolve_controls(session, context, &backends).await?;
            let result = self.call(Some(session), "Runtime.callFunctionOn", json!({"objectId":objects[0],
                "functionDeclaration":function,"arguments":objects.iter().map(|object|json!({"objectId":object})).collect::<Vec<_>>(),"returnByValue":true})).await?;
            let facts = result["result"]["value"]
                .as_array()
                .filter(|v| v.len() == batch.len())
                .ok_or_else(fault)?;
            for ((index, object), inspected) in batch.iter().zip(objects).zip(facts) {
                let inspected = if inspected_facts(inspected)
                    .is_some_and(|v| v["visible"] == true && v["wheelCandidate"] == true)
                {
                    self.inspect(session, &object).await?
                } else {
                    inspected.clone()
                };
                inspections.insert(*index, (object, inspected));
            }
        }
        Ok(inspections)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    // 范围：回环 CDP 延迟且乱序回复，跨批节点不得串位；不模拟真实 Chromium 布局或公网性能。
    #[tokio::test]
    async fn delayed_replies_preserve_node_identity_across_bounded_batches() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}", listener.local_addr().unwrap());
        let count = INSPECTION_BATCH * 2 + 1;
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
            let mut batch_sizes = Vec::new();
            for start in (0..count).step_by(INSPECTION_BATCH) {
                let size = (count - start).min(INSPECTION_BATCH);
                let mut pending = Vec::new();
                // 收齐窗口才返回，串行等待每个节点会在外层测试期限内失败。
                for _ in 0..size {
                    let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
                        panic!()
                    };
                    let call: Value = serde_json::from_str(&text).unwrap();
                    assert_eq!(call["method"], "DOM.resolveNode");
                    assert_eq!(call["params"]["executionContextId"], 42);
                    pending.push(call);
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                socket
                    .send(Message::Text(
                        json!({"method":"Tracing.tracingComplete","params":{"stream":"trace"}})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
                for call in pending.iter().rev() {
                    socket.send(Message::Text(json!({"id":call["id"],"result":{"object":{"objectId":format!("node-{}", call["params"]["backendNodeId"])}}}).to_string().into())).await.unwrap();
                }
                let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
                    panic!()
                };
                let call: Value = serde_json::from_str(&text).unwrap();
                assert_eq!(call["method"], "Runtime.callFunctionOn");
                let args = call["params"]["arguments"].as_array().unwrap();
                assert_eq!(args.len(), size);
                batch_sizes.push(size);
                socket.send(Message::Text(json!({"id":call["id"],"result":{"result":{"value":args.iter().map(|arg| json!({"result":{"value":{"visible":true,"marker":arg["objectId"]}}})).collect::<Vec<_>>()}}}).to_string().into())).await.unwrap();
            }
            batch_sizes
        });
        let mut dom = Dom::connect(&endpoint).await.unwrap();
        let controls = (0..count)
            .map(|i| {
                (
                    i,
                    Control {
                        attrs: HashMap::new(),
                        role: "button".into(),
                        native_control: true,
                        clickable: true,
                    },
                )
            })
            .collect();
        let nodes = json!({"backendNodeId":(0..count).collect::<Vec<_>>()});
        let inspected = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            dom.inspect_controls("session", 42, &nodes, &controls),
        )
        .await
        .unwrap()
        .unwrap();
        for i in 0..count {
            assert_eq!(inspected[&i].0, format!("node-{i}"));
            assert_eq!(
                inspected[&i].1["result"]["value"]["marker"],
                format!("node-{i}")
            );
        }
        assert_eq!(dom.trace_complete.unwrap()["stream"], "trace");
        assert_eq!(server.await.unwrap(), vec![64, 64, 1]);
    }
}
