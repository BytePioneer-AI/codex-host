use std::error::Error;
#[cfg(target_os = "windows")]
use std::thread;
#[cfg(target_os = "windows")]
use std::time::Duration;

#[cfg(not(target_os = "windows"))]
use codexhost_platform::process_exists;
#[cfg(target_os = "windows")]
use codexhost_platform::process_started_at_micros;
use codexhost_platform::{PlatformError, ProcessSnapshot, process_snapshot};

#[cfg(target_os = "windows")]
// Four waits plus the initial observation cap transient exit-state retries at 80 ms.
const WINDOWS_SNAPSHOT_ATTEMPTS: usize = 5;
#[cfg(target_os = "windows")]
const WINDOWS_SNAPSHOT_RETRY_INTERVAL: Duration = Duration::from_millis(20);

#[cfg(any(target_os = "windows", test))]
const ERROR_ACCESS_DENIED: i32 = 5;
#[cfg(any(target_os = "windows", test))]
const ERROR_GEN_FAILURE: i32 = 31;
#[cfg(any(target_os = "windows", test))]
const ERROR_INVALID_PARAMETER: i32 = 87;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RecordedProcessObservation {
    Matching(ProcessSnapshot),
    Missing,
    Reused,
}

#[cfg(any(target_os = "windows", test))]
fn process_query_raw_os_error(error: &PlatformError) -> Option<i32> {
    match error {
        PlatformError::ProcessInspection { source, .. } | PlatformError::Io(source) => {
            source.raw_os_error()
        }
        _ => None,
    }
}

#[cfg(any(target_os = "windows", test))]
fn is_transient_windows_process_query_error(error: &PlatformError) -> bool {
    // Windows can report either code while a process observed by Toolhelp is exiting before
    // OpenProcess or QueryFullProcessImageNameW completes. Retry only these evidenced codes.
    matches!(
        process_query_raw_os_error(error),
        Some(ERROR_ACCESS_DENIED | ERROR_GEN_FAILURE)
    )
}

#[cfg(any(target_os = "windows", test))]
fn is_missing_windows_process_error(error: &PlatformError) -> bool {
    // OpenProcess reports ERROR_INVALID_PARAMETER when a previously observed non-zero PID has
    // exited before the identity query begins.
    process_query_raw_os_error(error) == Some(ERROR_INVALID_PARAMETER)
}

#[cfg(any(target_os = "windows", test))]
fn observe_process_snapshot_with<I, W>(
    process_id: u32,
    expected_started_at_micros: Option<u64>,
    attempts: usize,
    mut inspect: I,
    mut wait: W,
) -> Result<Option<ProcessSnapshot>, PlatformError>
where
    I: FnMut(u32) -> Result<ProcessSnapshot, PlatformError>,
    W: FnMut(),
{
    assert!(attempts > 0, "process snapshot attempts must be positive");
    for attempt in 0..attempts {
        match inspect(process_id) {
            Ok(snapshot)
                if expected_started_at_micros
                    .is_none_or(|expected| snapshot.started_at_micros == expected) =>
            {
                return Ok(Some(snapshot));
            }
            Ok(_) | Err(PlatformError::NotFound(_)) => return Ok(None),
            Err(error) if process_id != 0 && is_missing_windows_process_error(&error) => {
                return Ok(None);
            }
            Err(error)
                if is_transient_windows_process_query_error(&error) && attempt + 1 < attempts =>
            {
                wait();
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("positive process snapshot attempts always return")
}

#[cfg(any(target_os = "windows", test))]
fn observe_recorded_process_with<S, I, W>(
    process_id: u32,
    expected_started_at_micros: u64,
    attempts: usize,
    mut inspect_started_at: S,
    mut inspect: I,
    mut wait: W,
) -> Result<RecordedProcessObservation, PlatformError>
where
    S: FnMut(u32) -> Result<u64, PlatformError>,
    I: FnMut(u32) -> Result<ProcessSnapshot, PlatformError>,
    W: FnMut(),
{
    assert!(attempts > 0, "recorded process attempts must be positive");
    for attempt in 0..attempts {
        match inspect_started_at(process_id) {
            Ok(started_at_micros) if started_at_micros != expected_started_at_micros => {
                return Ok(RecordedProcessObservation::Reused);
            }
            Ok(_) => {}
            Err(PlatformError::NotFound(_)) => return Ok(RecordedProcessObservation::Missing),
            Err(error) if process_id != 0 && is_missing_windows_process_error(&error) => {
                return Ok(RecordedProcessObservation::Missing);
            }
            Err(error)
                if is_transient_windows_process_query_error(&error) && attempt + 1 < attempts =>
            {
                wait();
                continue;
            }
            Err(error) => return Err(error),
        }
        match inspect(process_id) {
            Ok(snapshot) if snapshot.started_at_micros == expected_started_at_micros => {
                return Ok(RecordedProcessObservation::Matching(snapshot));
            }
            Ok(_) => return Ok(RecordedProcessObservation::Reused),
            Err(PlatformError::NotFound(_)) => return Ok(RecordedProcessObservation::Missing),
            Err(error) if process_id != 0 && is_missing_windows_process_error(&error) => {
                return Ok(RecordedProcessObservation::Missing);
            }
            Err(error)
                if is_transient_windows_process_query_error(&error) && attempt + 1 < attempts =>
            {
                wait();
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("positive recorded process attempts always return")
}

#[cfg(target_os = "windows")]
pub(crate) fn current_process_snapshot(
    process_id: u32,
) -> Result<Option<ProcessSnapshot>, Box<dyn Error>> {
    observe_process_snapshot_with(
        process_id,
        None,
        WINDOWS_SNAPSHOT_ATTEMPTS,
        process_snapshot,
        || thread::sleep(WINDOWS_SNAPSHOT_RETRY_INTERVAL),
    )
    .map_err(Into::into)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn current_process_snapshot(
    process_id: u32,
) -> Result<Option<ProcessSnapshot>, Box<dyn Error>> {
    match process_snapshot(process_id) {
        Ok(snapshot) => Ok(Some(snapshot)),
        Err(PlatformError::NotFound(_)) => Ok(None),
        Err(_) if !process_exists(process_id) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn recorded_process_identity(
    process_id: u32,
    started_at_micros: u64,
) -> Result<RecordedProcessObservation, Box<dyn Error>> {
    observe_recorded_process_with(
        process_id,
        started_at_micros,
        WINDOWS_SNAPSHOT_ATTEMPTS,
        process_started_at_micros,
        process_snapshot,
        || thread::sleep(WINDOWS_SNAPSHOT_RETRY_INTERVAL),
    )
    .map_err(Into::into)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn recorded_process_identity(
    process_id: u32,
    started_at_micros: u64,
) -> Result<RecordedProcessObservation, Box<dyn Error>> {
    Ok(match current_process_snapshot(process_id)? {
        Some(snapshot) if snapshot.started_at_micros == started_at_micros => {
            RecordedProcessObservation::Matching(snapshot)
        }
        Some(_) => RecordedProcessObservation::Reused,
        None => RecordedProcessObservation::Missing,
    })
}

pub(crate) fn recorded_process_snapshot(
    process_id: u32,
    started_at_micros: u64,
) -> Result<Option<ProcessSnapshot>, Box<dyn Error>> {
    Ok(
        match recorded_process_identity(process_id, started_at_micros)? {
            RecordedProcessObservation::Matching(snapshot) => Some(snapshot),
            RecordedProcessObservation::Missing | RecordedProcessObservation::Reused => None,
        },
    )
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::io;
    use std::path::PathBuf;

    use super::*;

    fn snapshot(started_at_micros: u64) -> ProcessSnapshot {
        ProcessSnapshot {
            id: 42,
            parent_id: 7,
            process_group_id: 42,
            executable: PathBuf::from("codexhost-shim.exe"),
            started_at_micros,
        }
    }

    fn access_denied() -> PlatformError {
        process_inspection_error(ERROR_ACCESS_DENIED)
    }

    fn general_failure() -> PlatformError {
        process_inspection_error(ERROR_GEN_FAILURE)
    }

    fn invalid_parameter() -> PlatformError {
        process_inspection_error(ERROR_INVALID_PARAMETER)
    }

    fn process_inspection_error(code: i32) -> PlatformError {
        PlatformError::ProcessInspection {
            process_id: 42,
            operation: "fixture process query",
            source: io::Error::from_raw_os_error(code),
        }
    }

    #[test]
    fn retries_permission_denied_until_the_recorded_process_identity_is_observable() {
        let mut observations = VecDeque::from([
            Err(access_denied()),
            Err(access_denied()),
            Ok(snapshot(101)),
        ]);
        let mut waits = 0;

        let observed = observe_process_snapshot_with(
            42,
            Some(101),
            3,
            |_| observations.pop_front().expect("snapshot observation"),
            || waits += 1,
        )
        .expect("transient access denial should recover");

        assert_eq!(observed, Some(snapshot(101)));
        assert_eq!(waits, 2);
        assert!(observations.is_empty());
    }

    #[test]
    fn retries_general_failure_from_an_exiting_windows_process() {
        let mut observations = VecDeque::from([Err(general_failure()), Ok(snapshot(101))]);
        let mut waits = 0;

        let observed = observe_process_snapshot_with(
            42,
            Some(101),
            3,
            |_| observations.pop_front().expect("snapshot observation"),
            || waits += 1,
        )
        .expect("an exiting process query should recover");

        assert_eq!(observed, Some(snapshot(101)));
        assert_eq!(waits, 1);
        assert!(observations.is_empty());
    }

    #[test]
    fn treats_not_found_after_permission_denied_as_an_exited_process() {
        let mut observations = VecDeque::from([
            Err(access_denied()),
            Err(PlatformError::NotFound("process exited".to_owned())),
        ]);
        let mut waits = 0;

        let observed = observe_process_snapshot_with(
            42,
            Some(101),
            3,
            |_| observations.pop_front().expect("snapshot observation"),
            || waits += 1,
        )
        .expect("an explicitly missing process should be absent");

        assert_eq!(observed, None);
        assert_eq!(waits, 1);
        assert!(observations.is_empty());
    }

    #[test]
    fn treats_invalid_process_parameter_as_an_exited_process() {
        let mut waits = 0;

        let observed = observe_process_snapshot_with(
            42,
            Some(101),
            3,
            |_| Err(invalid_parameter()),
            || waits += 1,
        )
        .expect("an invalid recorded PID should be absent");

        assert_eq!(observed, None);
        assert_eq!(waits, 0);
    }

    #[test]
    fn does_not_treat_invalid_parameter_for_pid_zero_as_an_exited_process() {
        let error = observe_process_snapshot_with(
            0,
            None,
            3,
            |_| Err(invalid_parameter()),
            || panic!("PID zero must fail without retrying"),
        )
        .expect_err("PID zero is an invalid caller input, not an exited observed process");

        assert_eq!(
            process_query_raw_os_error(&error),
            Some(ERROR_INVALID_PARAMETER)
        );
    }

    #[test]
    fn keeps_persistent_permission_denied_as_an_indeterminate_identity() {
        let mut observations = VecDeque::from([
            Err(access_denied()),
            Err(access_denied()),
            Err(access_denied()),
            Err(access_denied()),
            Err(access_denied()),
        ]);
        let mut waits = 0;

        let error = observe_process_snapshot_with(
            42,
            Some(101),
            5,
            |_| observations.pop_front().expect("snapshot observation"),
            || waits += 1,
        )
        .expect_err("persistent access denial must remain fail-safe");

        assert_eq!(
            process_query_raw_os_error(&error),
            Some(ERROR_ACCESS_DENIED)
        );
        assert!(matches!(error, PlatformError::ProcessInspection { .. }));
        assert_eq!(waits, 4);
        assert!(observations.is_empty());
    }

    #[test]
    fn rejects_a_reused_pid_after_transient_permission_denied() {
        let mut observations = VecDeque::from([Err(access_denied()), Ok(snapshot(202))]);
        let mut waits = 0;

        let observed = observe_process_snapshot_with(
            42,
            Some(101),
            3,
            |_| observations.pop_front().expect("snapshot observation"),
            || waits += 1,
        )
        .expect("a reused PID should be an observable identity mismatch");

        assert_eq!(observed, None);
        assert_eq!(waits, 1);
        assert!(observations.is_empty());
    }

    #[test]
    fn rejects_a_reused_pid_before_reading_its_executable() {
        let mut full_snapshot_reads = 0;
        let mut waits = 0;

        let observed = observe_recorded_process_with(
            42,
            101,
            5,
            |_| Ok(202),
            |_| {
                full_snapshot_reads += 1;
                Ok(snapshot(202))
            },
            || waits += 1,
        )
        .expect("a readable start-time mismatch should prove PID reuse");

        assert_eq!(observed, RecordedProcessObservation::Reused);
        assert_eq!(full_snapshot_reads, 0);
        assert_eq!(waits, 0);
    }

    #[test]
    fn does_not_retry_a_permission_error_without_windows_access_denied_code() {
        let mut inspections = 0;
        let mut waits = 0;

        let error = observe_process_snapshot_with(
            42,
            Some(101),
            5,
            |_| {
                inspections += 1;
                Err(PlatformError::Io(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "not Windows ERROR_ACCESS_DENIED",
                )))
            },
            || waits += 1,
        )
        .expect_err("non-Windows access errors must not be retried");

        assert!(matches!(
            error,
            PlatformError::Io(ref source)
                if source.kind() == io::ErrorKind::PermissionDenied
                    && source.raw_os_error().is_none()
        ));
        assert_eq!(inspections, 1);
        assert_eq!(waits, 0);
    }
}
