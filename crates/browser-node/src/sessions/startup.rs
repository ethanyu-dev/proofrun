//! 启动阶段的独立看门狗：续租只推进短租约，不能重新执行初始化或延长固定启动期限。
use crate::{error::Fault, process};
use std::{future::Future, time::Duration};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

/// 保持同一个初始化 future，任何撤权、断开续租通知或期限耗尽都中止等待。
pub(super) async fn wait<T>(
    operation: impl Future<Output = anyhow::Result<T>>,
    mut renew: watch::Receiver<u64>,
    cancel: &CancellationToken,
    startup_deadline: u64,
) -> anyhow::Result<T> {
    tokio::pin!(operation);
    loop {
        let lease_deadline = *renew.borrow_and_update();
        let deadline = lease_deadline.min(startup_deadline);
        if process::boot_ms() >= deadline {
            let code = if lease_deadline <= startup_deadline {
                "SESSION_LEASE_EXPIRED"
            } else {
                "SESSION_START_TIMEOUT"
            };
            return Err(Fault::unknown(code, "browser startup deadline expired").into());
        }
        tokio::select! {
            biased;
            _ = cancel.cancelled() => anyhow::bail!("startup cancelled"),
            _ = tokio::time::sleep(Duration::from_millis(deadline.saturating_sub(process::boot_ms()))) => {
                let code = if lease_deadline <= startup_deadline { "SESSION_LEASE_EXPIRED" } else { "SESSION_START_TIMEOUT" };
                return Err(Fault::unknown(code, "browser startup deadline expired").into());
            },
            changed = renew.changed() => changed.map_err(|_| anyhow::anyhow!("startup renewal channel closed"))?,
            result = &mut operation => return result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 范围：真实异步等待跨越初始租约仍只初始化一次；不运行 Chrome 或 systemd。
    #[tokio::test]
    async fn slow_start_survives_renewal_without_restarting() {
        let now = process::boot_ms();
        let (tx, rx) = watch::channel(now + 300);
        let cancel = CancellationToken::new();
        let operation = async {
            tokio::time::sleep(Duration::from_millis(500)).await;
            Ok(42)
        };
        let result = wait(operation, rx, &cancel, now + 2000);
        let renewal = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            tx.send_replace(now + 1500);
        };
        let (result, _) = tokio::join!(result, renewal);
        assert_eq!(result.unwrap(), 42);
    }

    // 范围：短租约丢失与固定启动超时分别生效；不证明真实进程组已经回收。
    #[tokio::test]
    async fn startup_stops_at_lease_or_fixed_deadline() {
        for (lease, startup, code) in [
            (100, 1000, "SESSION_LEASE_EXPIRED"),
            (1000, 100, "SESSION_START_TIMEOUT"),
        ] {
            let now = process::boot_ms();
            let (_tx, rx) = watch::channel(now + lease);
            let error = wait(
                std::future::pending::<anyhow::Result<()>>(),
                rx,
                &CancellationToken::new(),
                now + startup,
            )
            .await
            .unwrap_err();
            assert_eq!(error.downcast_ref::<Fault>().unwrap().code, code);
        }
    }

    // 范围：启动未完成时显式关闭立即撤销等待；不验证 systemd 的关闭证据。
    #[tokio::test]
    async fn startup_can_be_cancelled() {
        let now = process::boot_ms();
        let (_tx, rx) = watch::channel(now + 1000);
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(
            wait(
                std::future::pending::<anyhow::Result<()>>(),
                rx,
                &cancel,
                now + 1000
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("cancelled")
        );
    }
}
