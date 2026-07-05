//! Connection pool / retry-backoff config (Phase 5 · T21). Pure config + backoff
//! math (không I/O) → unit-test được. Model connection hiện tại là 1-conn-per-
//! profile (giữ đúng hợp đồng cancel T11 + transaction cùng-connection); các giá
//! trị pool ở đây cấu hình acquire/idle/retry và backoff khi CONNECT thất bại.

use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PoolConfig {
    /// Số connection tối đa (đường hướng pooling; hiện dùng cho acquire semantics).
    pub max_size: u32,
    /// Idle timeout (giây) trước khi nhả connection nhàn rỗi.
    pub idle_secs: u64,
    /// Acquire timeout (giây) — chờ tối đa để lấy được connection.
    pub acquire_secs: u64,
    /// Số lần thử lại khi connect thất bại (>=1).
    pub retry_attempts: u32,
    /// Delay cơ sở cho backoff (ms).
    pub retry_base_ms: u64,
    /// Trần delay backoff (ms).
    pub retry_max_ms: u64,
}

impl Default for PoolConfig {
    fn default() -> Self {
        PoolConfig {
            max_size: 5,
            idle_secs: 300,
            acquire_secs: 10,
            retry_attempts: 3,
            retry_base_ms: 200,
            retry_max_ms: 5_000,
        }
    }
}

impl PoolConfig {
    /// Chuẩn hóa giá trị người dùng nhập (đảm bảo hợp lệ, không panic downstream).
    pub fn sanitized(self) -> Self {
        let retry_base_ms = self.retry_base_ms.clamp(10, 60_000);
        PoolConfig {
            max_size: self.max_size.clamp(1, 64),
            idle_secs: self.idle_secs.clamp(1, 86_400),
            acquire_secs: self.acquire_secs.clamp(1, 300),
            retry_attempts: self.retry_attempts.clamp(1, 10),
            retry_base_ms,
            retry_max_ms: self.retry_max_ms.max(retry_base_ms),
        }
    }

    /// Backoff mũ có trần: base * 2^(attempt-1), cap ở retry_max_ms. attempt bắt
    /// đầu từ 1. attempt=0 → 0 (không chờ trước lần thử đầu).
    pub fn backoff_delay(&self, attempt: u32) -> Duration {
        if attempt == 0 {
            return Duration::from_millis(0);
        }
        let shift = (attempt - 1).min(20);
        let ms = self.retry_base_ms.saturating_mul(1u64 << shift).min(self.retry_max_ms);
        Duration::from_millis(ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_sane() {
        let c = PoolConfig::default();
        assert_eq!(c.max_size, 5);
        assert_eq!(c.retry_attempts, 3);
    }

    #[test]
    fn sanitized_clamps_out_of_range() {
        let c = PoolConfig {
            max_size: 0,
            idle_secs: 0,
            acquire_secs: 0,
            retry_attempts: 99,
            retry_base_ms: 1,
            retry_max_ms: 0,
        }
        .sanitized();
        assert_eq!(c.max_size, 1);
        assert_eq!(c.acquire_secs, 1);
        assert_eq!(c.retry_attempts, 10);
        assert_eq!(c.retry_base_ms, 10);
        assert!(c.retry_max_ms >= c.retry_base_ms);
    }

    #[test]
    fn backoff_is_exponential_and_capped() {
        let c = PoolConfig { retry_base_ms: 100, retry_max_ms: 1000, ..PoolConfig::default() };
        assert_eq!(c.backoff_delay(0), Duration::from_millis(0));
        assert_eq!(c.backoff_delay(1), Duration::from_millis(100));
        assert_eq!(c.backoff_delay(2), Duration::from_millis(200));
        assert_eq!(c.backoff_delay(3), Duration::from_millis(400));
        assert_eq!(c.backoff_delay(4), Duration::from_millis(800));
        assert_eq!(c.backoff_delay(5), Duration::from_millis(1000)); // capped
        assert_eq!(c.backoff_delay(20), Duration::from_millis(1000)); // vẫn capped, không overflow
    }
}
