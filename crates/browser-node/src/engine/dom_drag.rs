//! 同一个 CDP 会话内按人工时间顺序派发左键拖动，失败仍尝试释放，不重放轨迹。
use super::*;
use tokio::time::{Duration, Instant, sleep_until, timeout};

/// 预留松手时间和外层 host 返回回执的时间，不能占满命令的硬期限。
const RELEASE_RESERVE: Duration = Duration::from_millis(500);
const REPLY_RESERVE: Duration = Duration::from_millis(200);

impl Dom {
    /// 调用方已经验证轨迹；整段操作绑定开始时的标签页，失败按未知副作用关闭会话。
    pub async fn drag(&mut self, target: &str, points: &[Value], budget: Duration) -> Result<()> {
        let deadline = Instant::now() + budget;
        let session = self.attach(target).await?;
        let available = deadline.saturating_duration_since(Instant::now());
        let duration = Duration::from_millis(points.last().unwrap()["atMs"].as_u64().unwrap());
        let reserve = RELEASE_RESERVE + REPLY_RESERVE;
        if available <= duration + reserve {
            return Err(Fault::rejected(
                "DRAG_BUDGET",
                "拖动剩余执行时间不足，未派发输入",
            ));
        }
        let mut position = &points[0];
        let execution = timeout(available - reserve, async {
            self.call(Some(&session), "Input.dispatchMouseEvent", json!({"type":"mouseMoved","x":position["x"],"y":position["y"],"buttons":0})).await?;
            self.call(Some(&session), "Input.dispatchMouseEvent", json!({"type":"mousePressed","x":position["x"],"y":position["y"],"button":"left","buttons":1,"clickCount":1})).await?;
            let started = Instant::now();
            for point in &points[1..] {
                sleep_until(started + Duration::from_millis(point["atMs"].as_u64().unwrap())).await;
                position = point;
                self.call(Some(&session), "Input.dispatchMouseEvent", json!({"type":"mouseMoved","x":point["x"],"y":point["y"],"button":"left","buttons":1})).await?;
            }
            Ok(())
        }).await.unwrap_or_else(|_| Err(Fault::unknown("DRAG_TIMEOUT", "拖动结果未确认")));
        // 即使按下或移动回执失败也释放；清理成功不能把原始失败改成成功。
        let released = timeout(RELEASE_RESERVE, self.call(Some(&session), "Input.dispatchMouseEvent", json!({"type":"mouseReleased","x":position["x"],"y":position["y"],"button":"left","buttons":0,"clickCount":1}))).await;
        execution?;
        released.map_err(|_| Fault::unknown("DRAG_RELEASE_TIMEOUT", "松开鼠标结果未确认"))??;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    // 范围：回环 CDP 夹具确认顺序、按键位及失败清理；不声称页面接受拖动或验证码成功。
    #[tokio::test]
    async fn drag_preserves_buttons_and_releases_after_failure() {
        for fail_move in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("ws://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                let mut events = Vec::new();
                while let Some(Ok(Message::Text(text))) = socket.next().await {
                    let call: Value = serde_json::from_str(&text).unwrap();
                    let params = &call["params"];
                    let mouse = call["method"] == "Input.dispatchMouseEvent";
                    if mouse {
                        events.push(params.clone());
                    }
                    let response = if mouse
                        && fail_move
                        && params["type"] == "mouseMoved"
                        && params["buttons"] == 1
                    {
                        json!({"id":call["id"],"error":{"code":-32000}})
                    } else {
                        json!({"id":call["id"],"result":{"sessionId":"fixture"}})
                    };
                    socket
                        .send(Message::Text(response.to_string().into()))
                        .await
                        .unwrap();
                    if mouse && params["type"] == "mouseReleased" {
                        return events;
                    }
                }
                events
            });
            let mut dom = Dom::connect(&endpoint).await.unwrap();
            let points = vec![
                json!({"x":10.5,"y":20,"atMs":0}),
                json!({"x":80.5,"y":20,"atMs":10}),
                json!({"x":150,"y":20,"atMs":20}),
            ];
            let result = dom.drag("fixture", &points, Duration::from_secs(2)).await;
            assert_eq!(result.is_err(), fail_move);
            if let Err(error) = result {
                assert_eq!(error.effect, "MAY_HAVE_HAPPENED");
            }
            let events = server.await.unwrap();
            assert_eq!(events[0]["type"], "mouseMoved");
            assert_eq!(events[1]["type"], "mousePressed");
            assert_eq!(events[1]["buttons"], 1);
            assert_eq!(events[2]["buttons"], 1);
            assert_eq!(events.last().unwrap()["type"], "mouseReleased");
            assert_eq!(events.last().unwrap()["buttons"], 0);
            assert_eq!(events.len(), if fail_move { 4 } else { 5 });
            assert_eq!(
                events.last().unwrap()["x"],
                if fail_move { json!(80.5) } else { json!(150) }
            );
        }
    }
}
