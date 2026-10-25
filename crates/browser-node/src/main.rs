use anyhow::Result;
use clap::{Parser, Subcommand};
use proofrun_node::{config::NodeConfig, engine, gateway, node::Node, pairing, process, sessions};
use serde_json::json;
use std::{path::PathBuf, time::Duration};
use tokio_util::sync::CancellationToken;

#[derive(Parser)]
#[command(version = proofrun_node::version::VERSION, about = "ProofRun remote browser node")]
/// 节点二进制的外部命令行入口。
struct Cli {
    /// 可选 TOML 配置；未指定时使用 NodeConfig 默认值。
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    #[command(subcommand)]
    command: Action,
}
#[derive(Subcommand)]
/// serve 与 doctor 为外部入口；session-host 仅由主服务内部启动。
enum Action {
    /// 输出当前二进制的编译身份，不读取配置、启动服务或探测浏览器。
    BuildInfo,
    /// 管理节点拥有者批准的控制面绑定。
    Bindings {
        #[command(subcommand)]
        action: proofrun_node::bindings::Action,
    },
    /// 使用一次性配对码文件注册机器身份，不将密钥放进命令行参数。
    Pair {
        #[arg(long)]
        pairing_token_file: PathBuf,
        /// 显式允许轮换机器凭据，仍保留原节点身份与恢复账本。
        #[arg(long)]
        replace_credential: bool,
    },
    /// 主动连接控制面；stdio 仅供本地集成测试夹具使用。
    Serve {
        #[arg(long)]
        stdio: bool,
    },
    /// 探测已配置依赖，不创建浏览器会话。
    Doctor,
    /// 确认主机确实重启后清理旧会话占用，不重放任何命令。
    RecoverReboot,
    /// 清理已关闭且结果已确认的旧会话目录，默认只预览。
    Retain {
        #[arg(long, default_value_t = 30)]
        days: u64,
        #[arg(long)]
        apply: bool,
    },
    /// 内部单会话进程，不向不可信调用方开放其管道。
    #[command(hide = true)]
    SessionHost {
        #[arg(long)]
        directory: PathBuf,
    },
}
#[tokio::main]
/// 初始化日志、配置和运行模式，并在退出时回收受监管会话。
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_writer(std::io::stderr)
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let cli = Cli::parse();
    if let Action::BuildInfo = cli.command {
        println!(
            "{}",
            serde_json::to_string(&proofrun_node::version::current())?
        );
        return Ok(());
    }
    if let Action::SessionHost { directory } = cli.command {
        return sessions::host::run(directory).await;
    }
    let mut config = NodeConfig::load(cli.config.as_deref())?;
    if let Action::Bindings { action } = cli.command {
        println!("{}", proofrun_node::bindings::run(&config, action).await?);
        return Ok(());
    }
    if let Action::Pair {
        pairing_token_file,
        replace_credential,
    } = cli.command
    {
        println!(
            "{}",
            pairing::pair(&config, &pairing_token_file, replace_credential).await?
        );
        return Ok(());
    }
    match &cli.command {
        Action::RecoverReboot => {
            println!(
                "{}",
                proofrun_node::maintenance::recover_reboot(&config).await?
            );
            return Ok(());
        }
        Action::Retain { days, apply } => {
            println!(
                "{}",
                proofrun_node::maintenance::retain(&config, *days, *apply).await?
            );
            return Ok(());
        }
        _ => {}
    }
    if let Action::Doctor = cli.command {
        let prepared = config.prepare();
        let mut errors = Vec::new();
        if let Err(error) = prepared {
            errors.push(error.to_string());
        }
        let mut cmd = tokio::process::Command::new(&config.agent_browser_bin);
        cmd.arg("--version");
        let version = match process::capture(cmd, Duration::from_secs(5)).await {
            Ok((true, out, _)) => String::from_utf8_lossy(&out).trim().to_owned(),
            _ => {
                errors.push("agent-browser version probe failed".into());
                String::new()
            }
        };
        if !version
            .split_whitespace()
            .any(|v| v == engine::PINNED_AGENT_BROWSER_VERSION)
        {
            errors.push("agent-browser version differs from pinned baseline".into());
        }
        if !cfg!(target_os = "linux") {
            errors.push("Linux/systemd is required for supervised sessions".into());
        } else {
            let mut cmd = tokio::process::Command::new("systemctl");
            cmd.args(["--user", "show-environment"]);
            if !matches!(
                process::capture(cmd, Duration::from_secs(5)).await,
                Ok((true, _, _))
            ) {
                errors.push("systemd user manager unavailable".into());
            }
        }
        println!(
            "{}",
            serde_json::to_string_pretty(
                &json!({"service":"proofrun-node","version":proofrun_node::version::VERSION,"sourceCommit":proofrun_node::version::SOURCE_COMMIT,"dependencyChecksPassed":errors.is_empty(),"productionReady":false,"engineWritesVerified":false,"systemdLifecycleTested":false,"engineVersion":version,"errors":errors})
            )?
        );
        return Ok(());
    }
    if matches!(cli.command, Action::Serve { stdio: false }) {
        let stop = CancellationToken::new();
        let signal = stop.clone();
        tokio::spawn(async move {
            #[cfg(unix)]
            {
                let mut term =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                        .expect("install SIGTERM");
                tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
            }
            #[cfg(not(unix))]
            {
                let _ = tokio::signal::ctrl_c().await;
            }
            signal.cancel();
        });
        return proofrun_node::runtime::serve(config, stop).await;
    }
    let node = Node::start(config).await?;
    let stop = CancellationToken::new();
    let direct = if node.config.public_url.is_some() {
        let listener = tokio::net::TcpListener::bind(&node.config.listen).await?;
        let direct_node = node.clone();
        let direct_stop = stop.clone();
        Some(tokio::spawn(async move {
            let result =
                proofrun_node::direct::serve(direct_node, listener, direct_stop.clone()).await;
            if result.is_err() {
                direct_stop.cancel();
            }
            result
        }))
    } else {
        None
    };
    let signal = stop.clone();
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("install SIGTERM handler");
            tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        signal.cancel();
    });
    let result = match cli.command {
        Action::Serve { stdio: true } => gateway::serve_stdio(node.clone(), stop.clone()).await,
        Action::Serve { stdio: false } => gateway::serve(node.clone(), stop.clone()).await,
        _ => unreachable!(),
    };
    stop.cancel();
    node.shutdown().await;
    if let Some(direct) = direct {
        direct.await??;
    }
    result
}
