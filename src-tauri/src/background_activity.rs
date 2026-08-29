use std::{
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

static PROCESS_STARTED_AT: OnceLock<Instant> = OnceLock::new();
static LAST_FOREGROUND_ACTIVITY_MS: AtomicU64 = AtomicU64::new(0);

fn elapsed_millis() -> u64 {
    let elapsed = PROCESS_STARTED_AT
        .get_or_init(Instant::now)
        .elapsed()
        .as_millis();
    u64::try_from(elapsed).unwrap_or(u64::MAX).saturating_add(1)
}

/// Records an interactive request. Disk-heavy maintenance uses this signal to
/// yield while a gallery page or viewer is actively requesting data.
pub fn note_foreground_activity() {
    LAST_FOREGROUND_ACTIVITY_MS.store(elapsed_millis(), Ordering::Release);
}

pub fn is_foreground_active(quiet_period: Duration) -> bool {
    let last = LAST_FOREGROUND_ACTIVITY_MS.load(Ordering::Acquire);
    last != 0
        && elapsed_millis().saturating_sub(last)
            < u64::try_from(quiet_period.as_millis()).unwrap_or(u64::MAX)
}

/// Sleeps only on a background worker until the foreground has remained quiet
/// for the requested period. New activity extends the wait automatically.
pub fn wait_until_quiet(quiet_period: Duration, poll_interval: Duration) {
    while is_foreground_active(quiet_period) {
        thread::sleep(poll_interval);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foreground_activity_expires_after_the_quiet_period() {
        note_foreground_activity();
        assert!(is_foreground_active(Duration::from_secs(1)));
        assert!(!is_foreground_active(Duration::ZERO));
    }
}
