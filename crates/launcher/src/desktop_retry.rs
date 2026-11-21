//! Retry only a verified, pre-window exit from the initial AppX attempt.

use std::time::Duration;

const EARLY_EXIT_WINDOW: Duration = Duration::from_secs(3);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
const CLEANUP_INITIAL_DELAY: Duration = Duration::from_millis(25);
const CLEANUP_MAX_DELAY: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LaunchPath {
    Appx,
    Direct,
}

impl LaunchPath {
    pub(super) fn after_exit(self, elapsed: Duration, was_visible: bool) -> Option<Self> {
        (self == Self::Appx && elapsed <= EARLY_EXIT_WINDOW && !was_visible).then_some(Self::Direct)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CleanupObservation {
    Empty,
    Residual,
    Conflict,
}

/// Require two clean observations separated by a quiet interval. A foreign
/// instance or an incomplete observation is not a condition to wait out.
pub(super) fn wait_for_clean_retry<E>(
    mut elapsed: impl FnMut() -> Duration,
    mut observe: impl FnMut() -> Result<CleanupObservation, E>,
    mut sleep: impl FnMut(Duration),
) -> Result<CleanupObservation, E> {
    let mut delay = CLEANUP_INITIAL_DELAY;
    let mut was_empty = false;
    loop {
        let observation = observe()?;
        if observation == CleanupObservation::Conflict {
            return Ok(observation);
        }
        let remaining = CLEANUP_TIMEOUT.saturating_sub(elapsed());
        if remaining.is_zero() {
            return Ok(CleanupObservation::Residual);
        }
        let empty = observation == CleanupObservation::Empty;
        if empty && was_empty {
            return Ok(CleanupObservation::Empty);
        }
        was_empty = empty;
        sleep(delay.min(remaining));
        delay = (delay * 2).min(CLEANUP_MAX_DELAY);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn only_an_initial_appx_exit_before_a_window_can_select_direct() {
        let early = Duration::from_secs(1);
        let direct = LaunchPath::Appx.after_exit(early, false).unwrap();
        assert_eq!(direct, LaunchPath::Direct);
        assert_eq!(direct.after_exit(early, false), None);
        assert_eq!(LaunchPath::Appx.after_exit(early, true), None);
        assert_eq!(
            LaunchPath::Appx.after_exit(Duration::from_secs(4), false),
            None
        );
    }

    #[test]
    fn cleanup_backs_off_and_requires_a_quiet_interval() {
        let now = Cell::new(Duration::ZERO);
        let mut results = [
            CleanupObservation::Residual,
            CleanupObservation::Empty,
            CleanupObservation::Residual,
            CleanupObservation::Empty,
            CleanupObservation::Empty,
        ]
        .into_iter();
        assert_eq!(
            wait_for_clean_retry(
                || now.get(),
                || Ok::<_, ()>(results.next().unwrap()),
                |delay| now.set(now.get() + delay)
            ),
            Ok(CleanupObservation::Empty)
        );
        assert_eq!(now.get(), Duration::from_millis(275));
    }

    #[test]
    fn cleanup_never_retries_through_a_conflict_or_failed_inspection() {
        for second in [Ok(CleanupObservation::Conflict), Err("unobservable")] {
            let mut results = [Ok(CleanupObservation::Empty), second].into_iter();
            assert_eq!(
                wait_for_clean_retry(|| Duration::ZERO, || results.next().unwrap(), |_| {}),
                second
            );
        }
        let now = Cell::new(Duration::ZERO);
        assert_eq!(
            wait_for_clean_retry(
                || now.get(),
                || Ok::<_, ()>(CleanupObservation::Residual),
                |delay| now.set(now.get() + delay)
            ),
            Ok(CleanupObservation::Residual)
        );
        assert_eq!(now.get(), CLEANUP_TIMEOUT);
    }
}
