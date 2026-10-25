//! 直连控制和媒体通道各自保活；静态画面没有新帧也不能被入口当成空闲连接回收。
use anyhow::{Result, ensure};
use std::time::{Duration, Instant};

/// 小于已验证的公网入口 60 秒空闲期限。
const PING_INTERVAL: Duration = Duration::from_secs(15);
/// 超过三个心跳周期仍未应答，释放占用，允许客户端重新申请授权。
const PONG_TIMEOUT: Duration = Duration::from_secs(45);

/// 只接受当前 Ping 的应答，避免无关 Pong 掩盖已经失联的连接。
pub(super) struct Heartbeat {
    /// 下一次保活的最早时刻。
    next_ping: Instant,
    /// 尚未确认的发送时刻及对应载荷，不被其他流量刷新。
    pending: Option<(Instant, [u8; 8])>,
    /// 单连接递增序号，用于匹配应答。
    sequence: u64,
}

impl Heartbeat {
    pub(super) fn new(now: Instant) -> Self {
        Self {
            next_ping: now + PING_INTERVAL,
            pending: None,
            sequence: 0,
        }
    }

    /// 已有 Ping 在途时不覆盖其期限；调度器的频繁授权检查不会延长超时。
    pub(super) fn tick(&mut self, now: Instant) -> Result<Option<[u8; 8]>> {
        if let Some((sent, _)) = self.pending {
            ensure!(now.duration_since(sent) < PONG_TIMEOUT, "直连心跳应答超时");
            return Ok(None);
        }
        if now < self.next_ping {
            return Ok(None);
        }
        self.sequence = self.sequence.wrapping_add(1);
        let payload = self.sequence.to_be_bytes();
        self.pending = Some((now, payload));
        self.next_ping = now + PING_INTERVAL;
        Ok(Some(payload))
    }

    /// 协议级 Pong 不经过业务消息，也不改变认证代次或重复执行输入。
    pub(super) fn pong(&mut self, payload: &[u8]) {
        if self
            .pending
            .as_ref()
            .is_some_and(|(_, expected)| expected == payload)
        {
            self.pending = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 范围：静默时定期保活及应答后的下一轮调度；公网超时由实际部署验证。
    #[test]
    fn idle_connection_gets_periodic_pings() {
        let now = Instant::now();
        let mut heartbeat = Heartbeat::new(now);
        assert!(
            heartbeat
                .tick(now + Duration::from_secs(14))
                .unwrap()
                .is_none()
        );
        let first = heartbeat.tick(now + PING_INTERVAL).unwrap().unwrap();
        heartbeat.pong(&first);
        let second = heartbeat.tick(now + PING_INTERVAL * 2).unwrap().unwrap();
        assert_ne!(first, second);
    }

    // 范围：错误或缺失的 Pong 不能续期；不模拟真实 TCP 半开连接。
    #[test]
    fn missing_or_unrelated_pong_expires() {
        let now = Instant::now();
        let mut heartbeat = Heartbeat::new(now);
        heartbeat.tick(now + PING_INTERVAL).unwrap();
        heartbeat.pong(b"unrelated");
        assert!(
            heartbeat
                .tick(now + Duration::from_secs(59))
                .unwrap()
                .is_none()
        );
        assert!(heartbeat.tick(now + PING_INTERVAL + PONG_TIMEOUT).is_err());
    }
}
