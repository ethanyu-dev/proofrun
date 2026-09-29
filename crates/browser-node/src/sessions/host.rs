use crate::{
    engine::{Engine, EngineConfig},
    error::Fault,
    process,
    protocol::BrowserCommand,
};
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::PathBuf;
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
    } = serde_json::from_str(&initial)?
    else {
        anyhow::bail!("expected init")
    };
    anyhow::ensure!(config.directory == directory, "host directory mismatch");
    let mut engine = Engine::new(config)?;
    let opened = engine
        .open(deadline_ms.saturating_sub(process::boot_ms()).min(15000))
        .await;
    send(&mut writer, json!({"type":"host.opened","result":opened})).await?;
    if opened.is_err() {
        engine.close().await;
        return Ok(());
    }
    // 读取下一条操作时仍受本地租约期限约束；断管道也会结束会话。
    'session: loop {
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
                deadline_ms = new;
            }
            Input::Close => break,
            Input::Run {
                command,
                timeout_ms,
            } => {
                let expires = process::boot_ms() + timeout_ms;
                let execution = engine.execute(command, timeout_ms);
                tokio::pin!(execution);
                let result = loop {
                    tokio::select! {
                        result = &mut execution => break result,
                        _ = tokio::time::sleep(std::time::Duration::from_millis(
                            deadline_ms.min(expires).saturating_sub(process::boot_ms())
                        )) => break Err(Fault::unknown("DEADLINE_EXCEEDED", "operation deadline expired")),
                        input = reader.next() => {
                            match input {
                                Some(Ok(line)) => match serde_json::from_str::<Input>(&line)? {
                                    Input::Renew { deadline_ms: new } if process::boot_ms() < deadline_ms => deadline_ms = new,
                                    // 关闭请求直接中断当前浏览器操作，不等待操作队列。
                                    Input::Close => break 'session,
                                    _ => break 'session,
                                },
                                _ => break 'session,
                            }
                        }
                    }
                };
                let failed = result
                    .as_ref()
                    .is_err_and(|fault| fault.effect != "NOT_STARTED");
                send(&mut writer, json!({"type":"host.result","result":result})).await?;
                // 引擎结果不确定时结束会话，避免后续动作与潜在副作用并发。
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
