//! Deterministic exponential backoff for the redial loop.
//!
//! Mirrors the reference TUI client: 250 ms base, doubling per attempt,
//! capped at 5 s. No jitter — reconnects are per-user, not thundering-herd.

use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Backoff {
    base: Duration,
    max: Duration,
    attempt: u32,
}

impl Backoff {
    pub fn new(base: Duration, max: Duration) -> Self {
        Self {
            base,
            max,
            attempt: 0,
        }
    }

    /// Delay to sleep before the next redial; each call advances the schedule.
    pub fn next_delay(&mut self) -> Duration {
        let exp = self.base.saturating_mul(2u32.saturating_pow(self.attempt));
        self.attempt = self.attempt.saturating_add(1);
        exp.min(self.max)
    }

    /// A settled (joined) connection resets the schedule.
    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    /// How many redials have been scheduled since the last reset.
    pub fn attempt(&self) -> u32 {
        self.attempt
    }
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new(Duration::from_millis(250), Duration::from_secs(5))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doubles_from_base_and_caps_at_max() {
        let mut b = Backoff::default();
        let delays: Vec<u64> = (0..7).map(|_| b.next_delay().as_millis() as u64).collect();
        assert_eq!(delays, vec![250, 500, 1000, 2000, 4000, 5000, 5000]);
    }

    #[test]
    fn reset_restarts_the_schedule() {
        let mut b = Backoff::default();
        b.next_delay();
        b.next_delay();
        b.reset();
        assert_eq!(b.attempt(), 0);
        assert_eq!(b.next_delay(), Duration::from_millis(250));
    }

    #[test]
    fn never_overflows_on_many_attempts() {
        let mut b = Backoff::default();
        for _ in 0..100 {
            assert!(b.next_delay() <= Duration::from_secs(5));
        }
    }
}
