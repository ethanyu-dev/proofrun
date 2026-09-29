use anyhow::Result;
use clap::{Parser, Subcommand};
use proofrun_node::{config::NodeConfig, engine, gateway, node::Node, pairing, process, sessions};
use serde_json::json;
use std::{path::PathBuf, time::Duration};
use tokio_util::sync::CancellationToken;

#[derive(Parser)]
#[command(version, about = "ProofRun remote browser node")]
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
    /// 节点停止时导入已有浏览器存储状态，内容不会上传控制面。
    AuthImport {
        #[arg(long)]
        state_id: String,
        #[arg(long)]
        file: PathBuf,
    },
    /// 节点停止时删除指定本地登录状态。
    AuthForget {
        #[arg(long)]
        state_id: String,
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
    if let Action::SessionHost { directory } = cli.command {
        return sessions::host::run(directory).await;
    }
    let mut config = NodeConfig::load(cli.config.as_deref())?;
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
        Action::AuthImport { state_id, file } => {
            std::fs::create_dir_all(&config.home)?;
            let _lock = proofrun_node::artifacts::lock_home(&config.home)?;
            proofrun_node::auth::import(&config.home, state_id, file)?;
            println!("{}", json!({"imported":true,"stateId":state_id}));
            return Ok(());
        }
        Action::AuthForget { state_id } => {
            let _lock = proofrun_node::artifacts::lock_home(&config.home)?;
            let path = proofrun_node::auth::state_path(&config.home, state_id)?;
            if path.exists() {
                std::fs::remove_file(path)?;
            }
            println!("{}", json!({"forgotten":true,"stateId":state_id}));
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
                &json!({"service":"proofrun-node","version":env!("CARGO_PKG_VERSION"),"dependencyChecksPassed":errors.is_empty(),"productionReady":false,"engineWritesVerified":false,"systemdLifecycleTested":false,"engineVersion":version,"errors":errors})
            )?
        );
        return Ok(());
    }
    let node = Node::start(config).await?;
    let stop = CancellationToken::new();
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
        Action::Serve { stdio: true } => gateway::serve_stdio(node.clone(), stop).await,
        Action::Serve { stdio: false } => gateway::serve(node.clone(), stop).await,
        _ => unreachable!(),
    };
    node.shutdown().await;
    result
}
