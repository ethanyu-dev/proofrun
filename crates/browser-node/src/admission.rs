//! 本机资源准入：在创建意图落盘前检查真实余量，不维护第二个任务队列。
use crate::{config::NodeConfig, process, store::SessionRecord};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

/// 启动后的短暂稳定窗口，避免采样尚未反映 Chromium 峰值时连续放行。
const STARTUP_SETTLE_MS: u64 = 5_000;
/// 指标最短采样间隔；频繁准入复用 CPU 差值，但重新读取内存。
const SAMPLE_INTERVAL_MS: u64 = 500;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
/// 上报的准入结论只是调度提示，真正创建时仍须在会话锁内重新检查。
pub struct Status {
    /// 此快照是否允许尝试新会话，不是容量承诺。
    pub accepting: bool,
    /// 稳定诊断码，供 API 和 Console 展示。
    pub reason: String,
    /// 宿主利用率和 cgroup 配额利用率中的较高值。
    pub cpu_percent: f64,
    /// 扣除现有会话未使用预算后的有效内存余量。
    pub available_bytes: u64,
    /// 本次新增会话与宿主需要保留的总字节数。
    pub reserve_bytes: u64,
}
#[derive(Default)]
/// CPU 差值与迟滞状态；只在节点内存保留，重启后重新采样。
struct History {
    /// 上次采样的单调时间、宿主总量、空闲量和 cgroup CPU 时间。
    previous: Option<(u64, u64, u64, u64)>,
    /// 最近有效差值计算出的 CPU 利用率。
    cpu: f64,
    /// 至少完成一次有时间间隔的差值采样。
    measured: bool,
    /// 压力停止状态，决定使用恢复还是停止阈值。
    blocked: bool,
    /// 最近创建意图的单调时间，用于启动稳定窗口。
    last_start: Option<u64>,
}
#[derive(Default)]
/// 共享采样器。Sessions 的创建锁保证检查与预留之间不会插入另一次准入。
pub struct Admission {
    /// 心跳与创建请求共享采样历史。
    history: Mutex<History>,
}
impl Admission {
    /// 读取有效 CPU 配额、内存余量和压力；任何必需指标缺失时停止新增会话。
    pub fn status(&self, config: &NodeConfig, records: &[SessionRecord]) -> Status {
        self.evaluate(
            config,
            records,
            sample(records, config.session_reserve_bytes),
        )
    }
    /// 纯准入裁决与 Linux 采样分离，便于验证预留、迟滞和失败保护。
    fn evaluate(
        &self,
        config: &NodeConfig,
        records: &[SessionRecord],
        sample: anyhow::Result<Sample>,
    ) -> Status {
        let mut state = self.history.lock().unwrap();
        let mut status = Status {
            accepting: false,
            reason: "METRICS_UNAVAILABLE".into(),
            cpu_percent: state.cpu,
            available_bytes: 0,
            reserve_bytes: config
                .memory_reserve_bytes
                .saturating_add(config.session_reserve_bytes),
        };
        let Ok(sample) = sample else { return status };
        status.available_bytes = sample.available.saturating_sub(sample.unused_reserves);
        let now = process::boot_ms();
        let Some((at, total, idle, usage)) = state.previous else {
            state.previous = Some((now, sample.total, sample.idle, sample.usage));
            status.reason = "CPU_SAMPLE_PENDING".into();
            return status;
        };
        if now.saturating_sub(at) >= SAMPLE_INTERVAL_MS {
            let dt = sample.total.saturating_sub(total);
            let host = if dt == 0 {
                100.0
            } else {
                100.0 * (dt.saturating_sub(sample.idle.saturating_sub(idle))) as f64 / dt as f64
            };
            let group = sample.usage.saturating_sub(usage) as f64
                / ((now - at) as f64 * 10.0 * sample.cpus);
            state.cpu = host.max(group);
            state.measured = true;
            state.previous = Some((now, sample.total, sample.idle, sample.usage));
        }
        if !state.measured {
            status.reason = "CPU_SAMPLE_PENDING".into();
            return status;
        }
        status.cpu_percent = state.cpu;
        // 高阈值停止，低阈值恢复；压力不是静态会话数量。
        let threshold = if state.blocked {
            config.cpu_resume_percent
        } else {
            config.cpu_stop_percent
        };
        state.blocked = state.cpu >= threshold
            || sample.memory_pressure >= 1.0
            || sample.cpu_pressure >= config.cpu_pressure_percent;
        status.reason = if records.iter().any(|r| r.state == "QUARANTINED") {
            "RECOVERY_REQUIRED"
        } else if records.iter().any(|r| r.state == "STARTING")
            || state
                .last_start
                .is_some_and(|at| now.saturating_sub(at) < STARTUP_SETTLE_MS)
        {
            "STARTUP_SETTLING"
        } else if status.available_bytes < status.reserve_bytes {
            "MEMORY_PRESSURE"
        } else if state.blocked {
            "CPU_OR_MEMORY_PRESSURE"
        } else {
            status.accepting = true;
            "READY"
        }
        .into();
        status
    }
    /// 已持久保存创建意图后开始稳定窗口；不是可用槽位计数。
    pub fn accepted(&self) {
        self.history.lock().unwrap().last_start = Some(process::boot_ms());
    }
}
/// 同一采样中的宿主与 cgroup 指标；会话预留只扣尚未体现为实际占用的部分。
struct Sample {
    total: u64,
    idle: u64,
    usage: u64,
    cpus: f64,
    available: u64,
    unused_reserves: u64,
    memory_pressure: f64,
    cpu_pressure: f64,
}
/// 读取 cgroup 整数指标，解析失败由调用者按保守策略处理。
fn number(path: impl AsRef<Path>) -> anyhow::Result<u64> {
    Ok(std::fs::read_to_string(path)?.trim().parse()?)
}
/// 读取指定 PSI 分量的十秒均值。
fn pressure(path: &Path, kind: &str) -> anyhow::Result<f64> {
    let text = std::fs::read_to_string(path)?;
    Ok(text
        .lines()
        .find(|l| l.starts_with(kind))
        .and_then(|l| l.split_whitespace().find_map(|p| p.strip_prefix("avg10=")))
        .ok_or_else(|| anyhow::anyhow!("压力指标缺失"))?
        .parse()?)
}
/// 会话由 systemd 用户管理器启动，与节点服务同属用户 slice；遍历祖先取更严格的限制。
fn sample(records: &[SessionRecord], reserve: u64) -> anyhow::Result<Sample> {
    let stat = std::fs::read_to_string("/proc/stat")?;
    let cpu: Vec<u64> = stat
        .lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .skip(1)
        .take(8)
        .map(str::parse)
        .collect::<Result<_, _>>()?;
    anyhow::ensure!(cpu.len() >= 5, "CPU 指标缺失");
    let mem = std::fs::read_to_string("/proc/meminfo")?;
    let mut available = mem
        .lines()
        .find(|l| l.starts_with("MemAvailable:"))
        .and_then(|l| l.split_whitespace().nth(1))
        .ok_or_else(|| anyhow::anyhow!("内存指标缺失"))?
        .parse::<u64>()?
        * 1024;
    let path = std::fs::read_to_string("/proc/self/cgroup")?;
    let relative = path
        .lines()
        .find_map(|l| l.strip_prefix("0::"))
        .ok_or_else(|| anyhow::anyhow!("cgroup v2 缺失"))?;
    let root = Path::new("/sys/fs/cgroup");
    // 取用户管理器 slice，覆盖节点与 systemd-run 创建的兄弟会话。
    let mut group = root.to_path_buf();
    for part in relative.trim_start_matches('/').split('/') {
        group.push(part);
        if part.starts_with("user-") && part.ends_with(".slice") {
            break;
        }
    }
    let usage = std::fs::read_to_string(group.join("cpu.stat"))?
        .lines()
        .find_map(|l| l.strip_prefix("usage_usec "))
        .ok_or_else(|| anyhow::anyhow!("CPU 使用量缺失"))?
        .parse()?;
    let mut cpus = std::thread::available_parallelism()?.get() as f64;
    for parent in group.ancestors().take_while(|p| p.starts_with(root)) {
        if let Ok(max) = std::fs::read_to_string(parent.join("memory.max")) {
            if let Ok(limit) = max.trim().parse::<u64>() {
                available =
                    available.min(limit.saturating_sub(number(parent.join("memory.current"))?));
            }
        }
        if let Ok(max) = std::fs::read_to_string(parent.join("cpu.max")) {
            let fields: Vec<_> = max.split_whitespace().collect();
            if fields.len() == 2 {
                if let Ok(quota) = fields[0].parse::<f64>() {
                    cpus = cpus.min(quota / fields[1].parse::<f64>()?);
                }
            }
        }
    }
    anyhow::ensure!(cpus.is_finite() && cpus > 0.0, "CPU 配额无效");
    let mut unused_reserves: u64 = 0;
    for record in records {
        let used = match &record.cgroup {
            Some(path) => number(
                PathBuf::from("/sys/fs/cgroup")
                    .join(path.trim_start_matches('/'))
                    .join("memory.current"),
            )
            .unwrap_or(0),
            None => 0,
        };
        unused_reserves = unused_reserves.saturating_add(reserve.saturating_sub(used));
    }
    Ok(Sample {
        total: cpu.iter().sum(),
        idle: cpu[3] + cpu[4],
        usage,
        cpus,
        available,
        unused_reserves,
        memory_pressure: pressure(&group.join("memory.pressure"), "full")?,
        cpu_pressure: pressure(&group.join("cpu.pressure"), "some")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> Sample {
        Sample {
            total: 100,
            idle: 80,
            usage: 0,
            cpus: 4.0,
            available: 4 * 1024 * 1024 * 1024,
            unused_reserves: 0,
            memory_pressure: 0.0,
            cpu_pressure: 0.0,
        }
    }
    // 范围：资源预留会阻止新准入，未设置固定任务数；数据为采样夹具，不代表生产容量。
    #[test]
    fn memory_reserves_and_missing_metrics_stop_admission() {
        let admission = Admission::default();
        let config = NodeConfig::default();
        admission.history.lock().unwrap().measured = true;
        admission.history.lock().unwrap().previous = Some((process::boot_ms(), 100, 80, 0));
        assert!(admission.evaluate(&config, &[], Ok(sample())).accepting);
        let mut constrained = sample();
        constrained.unused_reserves = 3 * 1024 * 1024 * 1024;
        assert_eq!(
            admission.evaluate(&config, &[], Ok(constrained)).reason,
            "MEMORY_PRESSURE"
        );
        assert!(
            !admission
                .evaluate(&config, &[], Err(anyhow::anyhow!("missing")))
                .accepting
        );
        admission.accepted();
        assert_eq!(
            admission.evaluate(&config, &[], Ok(sample())).reason,
            "STARTUP_SETTLING"
        );
    }
    // 范围：进程刚启动时两次紧邻采样仍不能接单；数据为夹具，不测量宿主真实资源。
    #[test]
    fn first_sample_does_not_assume_idle_cpu() {
        let admission = Admission::default();
        let config = NodeConfig::default();
        assert_eq!(
            admission.evaluate(&config, &[], Ok(sample())).reason,
            "CPU_SAMPLE_PENDING"
        );
        assert_eq!(
            admission.evaluate(&config, &[], Ok(sample())).reason,
            "CPU_SAMPLE_PENDING"
        );
    }
    // 范围：CPU 恢复必须低于低阈值，避免在停止边界振荡；不测量真实 CPU 时间。
    #[test]
    fn cpu_hysteresis_requires_recovery_threshold() {
        let admission = Admission::default();
        let config = NodeConfig::default();
        {
            let mut h = admission.history.lock().unwrap();
            h.previous = Some((process::boot_ms(), 100, 80, 0));
            h.cpu = 85.0;
            h.measured = true;
        }
        assert!(!admission.evaluate(&config, &[], Ok(sample())).accepting);
        admission.history.lock().unwrap().cpu = 70.0;
        assert!(!admission.evaluate(&config, &[], Ok(sample())).accepting);
        admission.history.lock().unwrap().cpu = 50.0;
        assert!(admission.evaluate(&config, &[], Ok(sample())).accepting);
    }
}
