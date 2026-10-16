use crate::{
    engine::{Engine, EngineConfig},
    error::Fault,
    process,
    protocol::BrowserCommand,
};
use anyhow::{Context, Result};
use futures_util::{SinkExt, Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{future::Future, path::PathBuf, time::Duration};
use tokio::io;
use tokio_util::codec::{FramedRead, FramedWrite, LinesCodec};

/// 仅供主服务与同版本 session-host 通信的内部管道协议。
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Input {
    /// 传入引擎配置和初始租约期限，启动独立浏览器。
    Init {
        config: EngineConfig,
        deadline_ms: u64,
        /// 启动的固定截止时间；正常续租不能延长此期限。
        startup_deadline_ms: u64,
    },
    /// 在当前会话内执行一条已经过外部校验的操作。
    Run {
        command: BrowserCommand,
        timeout_ms: u64,
    },
    /// 延长仍有效的会话租约；可在 Run 等待期间处理。
    Renew { deadline_ms: u64 },
    /// 中断当前操作并结束 host；物理关闭仍由主服务核实。
    Close,
}
/// 向主服务发送一条 JSONL 结果消息。
async fn send(writer: &mut FramedWrite<io::Stdout, LinesCodec>, value: Value) -> Result<()> {
    writer.send(value.to_string()).await?;
    Ok(())
}
/// 启动内部 host，并串行执行浏览器操作，同时保持续租和关闭可响应。
pub async fn run(directory: PathBuf) -> Result<()> {
    let mut reader = FramedRead::new(
        io::stdin(),
        LinesCodec::new_with_max_length(process::OUTPUT_LIMIT),
    );
    let mut writer = FramedWrite::new(
        io::stdout(),
        LinesCodec::new_with_max_length(process::OUTPUT_LIMIT),
    );
    send(&mut writer, json!({"type":"host.ready"})).await?;
    let initial = reader.next().await.context("missing init")??;
    let Input::Init {
        config,
        mut deadline_ms,
        startup_deadline_ms,
    } = serde_json::from_str(&initial)?
    else {
        anyhow::bail!("expected init")
    };
    anyhow::ensure!(config.directory == directory, "host directory mismatch");
    let mut engine = Engine::new(config)?;
    let opened = with_lease(
        engine.open(startup_deadline_ms.saturating_sub(process::boot_ms())),
        &mut reader,
        &mut deadline_ms,
        startup_deadline_ms,
    )
    .await;
    send(&mut writer, json!({"type":"host.opened","result":opened})).await?;
    if opened.is_err() {
        engine.close().await;
        return Ok(());
    }
    // 读取下一条操作时仍受本地租约期限约束；断管道也会结束会话。
    loop {
        let line = tokio::select! {
            line = reader.next() => match line {
                Some(Ok(line)) => line,
                _ => break,
            },
            _ = tokio::time::sleep(std::time::Duration::from_millis(
                deadline_ms.saturating_sub(process::boot_ms())
            )) => break,
        };
        match serde_json::from_str::<Input>(&line)? {
            Input::Renew { deadline_ms: new } => {
                if process::boot_ms() >= deadline_ms {
                    break;
                }
                deadline_ms = deadline_ms.max(new);
            }
            Input::Close => break,
            Input::Run {
                command,
                timeout_ms,
            } => {
                let expires = process::boot_ms() + timeout_ms;
                let read_only_observation =
                    matches!(&command, BrowserCommand::BrowserObserve { .. });
                let result = with_lease(
                    engine.execute(command, timeout_ms),
                    &mut reader,
                    &mut deadline_ms,
                    expires,
                )
                .await;
                let failed = result
                    .as_ref()
                    .is_err_and(|fault| fault.requires_session_close(read_only_observation));
                send(&mut writer, json!({"type":"host.result","result":result})).await?;
                // DOM 采集失败保留会话供有界补采；其他未知结果仍关闭，避免潜在副作用并发。
                if failed {
                    break;
                }
            }
            Input::Init { .. } => break,
        }
    }
    engine.close().await;
    Ok(())
}

/// 初始化与普通操作共用宿主侧租约守卫；父进程断管道、关闭或租约过期都中止操作。
async fn with_lease<F, S, E>(
    operation: F,
    reader: &mut S,
    deadline_ms: &mut u64,
    operation_deadline: u64,
) -> crate::error::Result<Value>
where
    F: Future<Output = crate::error::Result<Value>>,
    S: Stream<Item = std::result::Result<String, E>> + Unpin,
{
    tokio::pin!(operation);
    loop {
        // 已过期时先撤权，不能让已缓冲的续租消息或立即完成的 future 抢先被处理。
        if process::boot_ms() >= (*deadline_ms).min(operation_deadline) {
            return Err(Fault::unknown(
                "DEADLINE_EXCEEDED",
                "operation or lease deadline expired",
            ));
        }
        tokio::select! {
            biased;
            _ = tokio::time::sleep(Duration::from_millis(
                (*deadline_ms).min(operation_deadline).saturating_sub(process::boot_ms())
            )) => return Err(Fault::unknown("DEADLINE_EXCEEDED", "operation or lease deadline expired")),
            input = reader.next() => match input {
                Some(Ok(line)) => match serde_json::from_str::<Input>(&line) {
                    Ok(Input::Renew { deadline_ms: new }) if process::boot_ms() < *deadline_ms => *deadline_ms = (*deadline_ms).max(new),
                    Ok(Input::Close) => return Err(Fault::unknown("CANCELLED", "host operation cancelled")),
                    _ => return Err(Fault::unknown("HOST_PROTOCOL", "invalid input during host operation")),
                },
                _ => return Err(Fault::unknown("HOST_IO", "host input closed during operation")),
            },
            result = &mut operation => return result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    // 范围：真实 JSONL 管道在初始化等待中处理续租，跨过原租约；引擎为延迟 future，不运行 Chrome。
    #[tokio::test]
    async fn startup_reads_renewal_while_engine_is_opening() {
        let (mut writer, pipe) = tokio::io::duplex(4096);
        let mut reader = FramedRead::new(pipe, LinesCodec::new());
        let now = process::boot_ms();
        let mut deadline = now + 300;
        let operation = async {
            tokio::time::sleep(Duration::from_millis(500)).await;
            Ok(json!({"opened": true}))
        };
        let result = with_lease(operation, &mut reader, &mut deadline, now + 2000);
        let renewal = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            writer
                .write_all(
                    format!("{{\"type\":\"renew\",\"deadline_ms\":{}}}\n", now + 1500).as_bytes(),
                )
                .await
                .unwrap();
            // 管道保持打开，不能把测试结束后的 EOF 混入初始化结果。
            tokio::time::sleep(Duration::from_millis(600)).await;
        };
        let (result, _) = tokio::join!(result, renewal);
        assert_eq!(result.unwrap(), json!({"opened": true}));
        assert_eq!(deadline, now + 1500);
    }

    // 范围：宿主守卫在续租后仍遵守固定操作期限，无续租时遵守短租约；不核实物理进程关闭。
    #[tokio::test]
    async fn renewal_cannot_extend_operation_deadline_or_revive_expired_lease() {
        for (lease, hard, renewal) in [(300, 100, true), (100, 1000, false), (0, 1000, true)] {
            let (mut writer, pipe) = tokio::io::duplex(4096);
            let mut reader = FramedRead::new(pipe, LinesCodec::new());
            let now = process::boot_ms();
            let mut deadline = now + lease;
            if renewal {
                writer
                    .write_all(
                        format!("{{\"type\":\"renew\",\"deadline_ms\":{}}}\n", now + 2000)
                            .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
            let error = with_lease(
                std::future::pending(),
                &mut reader,
                &mut deadline,
                now + hard,
            )
            .await
            .unwrap_err();
            assert_eq!(error.code, "DEADLINE_EXCEEDED");
            if lease == 0 {
                assert_eq!(deadline, now);
            }
        }
    }

    // 范围：初始化期间显式关闭与父进程 EOF 都立即终止等待；不依赖真实浏览器行为。
    #[tokio::test]
    async fn opening_stops_on_close_or_parent_eof() {
        for close in [true, false] {
            let (mut writer, pipe) = tokio::io::duplex(4096);
            let mut reader = FramedRead::new(pipe, LinesCodec::new());
            let mut deadline = process::boot_ms() + 2000;
            if close {
                writer.write_all(b"{\"type\":\"close\"}\n").await.unwrap();
            }
            drop(writer);
            let hard = deadline;
            let error = with_lease(std::future::pending(), &mut reader, &mut deadline, hard)
                .await
                .unwrap_err();
            assert_eq!(error.code, if close { "CANCELLED" } else { "HOST_IO" });
        }
    }
}
