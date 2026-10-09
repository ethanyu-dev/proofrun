//! Linux 进程边界。确认 systemd cgroup 已清空或消失后，会话才能转为 CLOSED 并释放容量。
use crate::store::SessionRecord;
use anyhow::{Context, Result, ensure};
use std::{collections::BTreeMap, path::Path, process::Stdio};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    time::{Duration, timeout},
};

/// 单条 CLI/host 输出及网关消息的上限，防止失控进程耗尽节点内存。
pub const OUTPUT_LIMIT: usize = 2 * 1024 * 1024;
/// 单次 CLI 调用保留的 stderr 上限。
const STDERR_LIMIT: usize = 64 * 1024;
/// 查询 systemd unit 状态的最长等待。
const UNIT_QUERY_TIMEOUT: Duration = Duration::from_secs(5);
/// 停止会话 unit 的最长等待；超时后保留隔离占用。
const UNIT_STOP_TIMEOUT: Duration = Duration::from_secs(8);
/// systemd 强制回收会话的时间比业务硬期限多预留 10 秒。
const RUNTIME_GRACE_MS: u64 = 10_000;

/// 持续读取直到 EOF；超限立即失败，由调用方终止并回收子进程。
pub async fn bounded_read<R: AsyncRead + Unpin>(mut input: R, limit: usize) -> Result<Vec<u8>> {
    let mut result = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        let count = input.read(&mut chunk).await?;
        if count == 0 {
            return Ok(result);
        }
        ensure!(result.len() + count <= limit, "OUTPUT_LIMIT");
        result.extend_from_slice(&chunk[..count]);
    }
}
/// 有期限地收集子进程输出；超时或输出超限时显式 kill + wait。
pub async fn capture(mut command: Command, budget: Duration) -> Result<(bool, Vec<u8>, Vec<u8>)> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let result = timeout(budget, async {
        tokio::try_join!(
            async { Ok::<_, anyhow::Error>(child.wait().await?) },
            bounded_read(stdout, OUTPUT_LIMIT),
            bounded_read(stderr, STDERR_LIMIT)
        )
    })
    .await;
    match result {
        Ok(Ok((status, out, err))) => Ok((status.success(), out, err)),
        error => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            match error {
                Ok(Err(error)) => Err(error),
                _ => anyhow::bail!("PROCESS_TIMEOUT"),
            }
        }
    }
}
/// 读取 Linux 启动身份；跨主机重启时旧 cgroup 路径不能作为关闭证据。
pub fn boot_id() -> Result<String> {
    Ok(std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .context("Linux boot identity required")?
        .trim()
        .into())
}
/// 返回系统启动以来的毫秒数，供主服务和 host 共享租约时钟。
pub fn boot_ms() -> u64 {
    #[cfg(target_os = "linux")]
    {
        let mut value = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // CLOCK_BOOTTIME 计入系统休眠时间，主服务与 session-host 使用同一时钟。
        let code = unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut value) };
        assert_eq!(code, 0, "CLOCK_BOOTTIME unavailable");
        value.tv_sec as u64 * 1000 + value.tv_nsec as u64 / 1_000_000
    }
    #[cfg(not(target_os = "linux"))]
    {
        use std::sync::OnceLock;
        static START: OnceLock<std::time::Instant> = OnceLock::new();
        START
            .get_or_init(std::time::Instant::now)
            .elapsed()
            .as_millis() as u64
    }
}
/// 查询 systemd unit 的状态、cgroup 和启动身份以核实会话归属。
pub async fn unit_info(unit: &str) -> Result<BTreeMap<String, String>> {
    let mut cmd = Command::new("systemctl");
    cmd.args([
        "--user",
        "show",
        unit,
        "--property=LoadState,ActiveState,ControlGroup,InvocationID,Description",
    ]);
    let (_, out, _) = capture(cmd, UNIT_QUERY_TIMEOUT).await?;
    let map: BTreeMap<_, _> = String::from_utf8(out)?
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(k, v)| (k.into(), v.into()))
        .collect();
    ensure!(
        map.contains_key("LoadState"),
        "systemd returned no unit identity"
    );
    Ok(map)
}
/// 在独立 systemd 服务和 cgroup 中启动同版本二进制的 session-host。
pub async fn launch(
    record: &SessionRecord,
    session_dir: &Path,
    max_ms: Option<u64>,
) -> Result<Child> {
    ensure!(
        cfg!(target_os = "linux"),
        "production session isolation requires Linux/systemd"
    );
    let mut cmd = Command::new("systemd-run");
    cmd.args([
        "--user",
        "--quiet",
        "--pipe",
        "--property=Type=exec",
        "--property=KillMode=control-group",
        "--property=Restart=no",
        "--property=TimeoutStopSec=3s",
    ]);
    // 人工等待不设固定 systemd 总时长；host 断管道或短租约到期退出后仍清理整个 cgroup。
    if let Some(max_ms) = max_ms {
        cmd.arg(format!(
            "--property=RuntimeMaxSec={}ms",
            max_ms + RUNTIME_GRACE_MS
        ));
    } else {
        cmd.arg("--property=RuntimeMaxSec=infinity");
    }
    cmd.arg(format!("--unit={}", record.unit))
        .arg(format!("--description=proofrun:{}", record.launch_id))
        .arg(std::env::current_exe()?)
        .args(["session-host", "--directory"])
        .arg(session_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    Ok(cmd.spawn()?)
}
/// 核对 unit 描述和启动身份，再把 cgroup 记录到恢复账本。
pub async fn identify(record: &mut SessionRecord) -> Result<()> {
    let info = unit_info(&record.unit).await?;
    ensure!(
        info.get("Description") == Some(&format!("proofrun:{}", record.launch_id)),
        "unit identity mismatch"
    );
    let cgroup = info
        .get("ControlGroup")
        .filter(|v| !v.is_empty())
        .context("missing cgroup")?
        .clone();
    ensure!(
        cgroup.starts_with('/') && !cgroup.split('/').any(|p| p == ".."),
        "invalid cgroup path"
    );
    let invocation = info
        .get("InvocationID")
        .filter(|v| !v.is_empty())
        .context("missing invocation")?
        .clone();
    record.cgroup = Some(cgroup);
    record.invocation = Some(invocation);
    Ok(())
}
/// 停止原 unit 并确认 cgroup 已空或消失；无法核实则不能释放容量。
pub async fn close(record: &SessionRecord) -> Result<()> {
    ensure!(
        boot_id()? == record.boot_id,
        "host reboot requires explicit recovery; cannot attest an old process scope"
    );
    let mut info = unit_info(&record.unit).await?;
    if info.get("LoadState").map(String::as_str) != Some("not-found") {
        ensure!(
            info.get("Description") == Some(&format!("proofrun:{}", record.launch_id)),
            "unit ownership mismatch"
        );
        if let Some(invocation) = &record.invocation {
            let current = info.get("InvocationID").map(String::as_str).unwrap_or("");
            ensure!(
                current.is_empty() || current == invocation,
                "unit invocation changed"
            );
        }
        let mut cmd = Command::new("systemctl");
        cmd.args(["--user", "stop", &record.unit]);
        let _ = capture(cmd, UNIT_STOP_TIMEOUT).await?;
        info = unit_info(&record.unit).await?;
    }
    let cgroup = record
        .cgroup
        .as_ref()
        .context("CLOSURE_UNVERIFIED: no recorded cgroup")?;
    let path = Path::new("/sys/fs/cgroup")
        .join(cgroup.trim_start_matches('/'))
        .join("cgroup.events");
    match std::fs::read_to_string(path) {
        Ok(events) => ensure!(
            events.lines().any(|l| l == "populated 0"),
            "CLOSURE_UNVERIFIED: cgroup still populated"
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    ensure!(
        matches!(
            info.get("ActiveState").map(String::as_str),
            Some("inactive" | "failed")
        ) || info.get("LoadState").map(String::as_str) == Some("not-found"),
        "unit still active"
    );
    Ok(())
}
