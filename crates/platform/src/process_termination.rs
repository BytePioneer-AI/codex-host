use super::PlatformError;
use super::process::{ProcessSnapshot, process_snapshot, same_process_instance};

#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::process::{ObservedProcessTree, process_snapshots};
#[cfg(target_os = "windows")]
use super::windows_process;

pub fn terminate_process_instance(
    expected: &ProcessSnapshot,
    _force: bool,
) -> Result<(), PlatformError> {
    #[cfg(target_os = "windows")]
    {
        let current = match process_snapshot(expected.id) {
            Ok(current) => current,
            Err(PlatformError::NotFound(_)) => return Ok(()),
            Err(error) => return Err(error),
        };
        if !same_process_instance(expected, &current) {
            return Ok(());
        }
        let _ = windows_process::terminate_process_instance(
            expected.id,
            expected.started_at_micros,
            1,
        )?;
        Ok(())
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let signal = if _force {
            nix::sys::signal::Signal::SIGKILL
        } else {
            nix::sys::signal::Signal::SIGTERM
        };
        ObservedProcessTree::new(expected.clone())
            .signal_processes(std::slice::from_ref(expected), signal)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = (expected, _force);
        Err(PlatformError::Unsupported(
            "exact process termination requires Windows, macOS, or Linux",
        ))
    }
}

pub fn terminate_process_group_instance(
    expected_root: &ProcessSnapshot,
    force: bool,
) -> Result<(), PlatformError> {
    #[cfg(target_os = "windows")]
    {
        terminate_process_instance(expected_root, force)
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let current = match process_snapshot(expected_root.id) {
            Ok(current) => current,
            Err(PlatformError::NotFound(_)) => return Ok(()),
            Err(error) => return Err(error),
        };
        if !same_process_instance(expected_root, &current) {
            return Ok(());
        }
        let group_members = process_snapshots()?
            .into_iter()
            .filter(|process| {
                process.process_group_id == current.process_group_id
                    && process.started_at_micros >= current.started_at_micros
            })
            .collect::<Vec<_>>();
        let signal = if force {
            nix::sys::signal::Signal::SIGKILL
        } else {
            nix::sys::signal::Signal::SIGTERM
        };
        ObservedProcessTree::new_with_process_group(
            current.clone(),
            Some(current.process_group_id),
            Some(current.started_at_micros),
        )
        .signal_processes(&group_members, signal)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = (expected_root, force);
        Err(PlatformError::Unsupported(
            "exact process-group termination requires Windows, macOS, or Linux",
        ))
    }
}

/// Stop a single inventory of exact executable names. Newly started instances are
/// deliberately not added: callers may permit external applications to respawn.
/// Only the observed instances are signalled, never editors or process groups.
pub fn stop_processes_by_executable_names(names: &[String]) -> Result<usize, PlatformError> {
    use std::collections::BTreeMap;

    if names.is_empty() || names.len() > 8 {
        return Err(PlatformError::Invalid("invalid process name count".into()));
    }
    let mut observed = BTreeMap::new();
    for name in names {
        for id in super::process_inventory::process_ids_by_executable_name(name)? {
            if id == std::process::id() {
                return Err(PlatformError::Invalid(
                    "cannot stop the inventory helper".into(),
                ));
            }
            let Some(snapshot) = snapshot_or_confirmed_exit(id)? else {
                continue;
            };
            // Recheck the executable after inventory, before pinning its identity.
            let actual = snapshot
                .executable
                .file_name()
                .and_then(|value| value.to_str());
            let matches = actual.is_some_and(|actual| {
                if cfg!(windows) {
                    actual.eq_ignore_ascii_case(name)
                } else {
                    actual == name
                }
            });
            if matches {
                observed.insert(id, snapshot);
            }
            if observed.len() > 256 {
                return Err(PlatformError::Invalid("too many processes to stop".into()));
            }
        }
    }
    let observed: Vec<_> = observed.into_values().collect();
    stop_observed_processes(&observed)?;
    Ok(observed.len())
}

fn snapshot_or_confirmed_exit(id: u32) -> Result<Option<ProcessSnapshot>, PlatformError> {
    match process_snapshot(id) {
        Ok(snapshot) => Ok(Some(snapshot)),
        Err(error) => {
            // Native snapshot failures may mean permission denied, not exit.
            if super::process_identity::process_identity(id)?.is_none() {
                Ok(None)
            } else {
                Err(error)
            }
        }
    }
}

fn stop_observed_processes(observed: &[ProcessSnapshot]) -> Result<(), PlatformError> {
    use std::time::{Duration, Instant};

    for force in [false, true] {
        for process in observed {
            if let Some(current) = snapshot_or_confirmed_exit(process.id)?
                && same_process_instance(process, &current)
            {
                terminate_process_instance(process, force)?;
            }
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let mut active = false;
            for expected in observed {
                match snapshot_or_confirmed_exit(expected.id) {
                    Ok(Some(current)) => active |= same_process_instance(expected, &current),
                    Ok(None) => {}
                    // Allow a dying process to be reaped, but never treat an
                    // inspection error as proof of exit.
                    Err(_) => active = true,
                }
            }
            if !active {
                return Ok(());
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    Err(PlatformError::Invalid(
        "process exit could not be confirmed".into(),
    ))
}

#[cfg(all(test, unix))]
mod batch_tests {
    use super::*;

    #[test]
    fn stops_only_observed_instances() {
        let mut target = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let mut unrelated = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let snapshot = process_snapshot(target.id()).unwrap();
        let reaper = std::thread::spawn(move || target.wait().unwrap());
        let result = stop_observed_processes(&[snapshot]);
        let unrelated_alive = unrelated.try_wait().unwrap().is_none();
        let _ = unrelated.kill();
        let _ = unrelated.wait();
        assert!(result.is_ok());
        assert!(!reaper.join().unwrap().success());
        assert!(unrelated_alive);
    }

    #[test]
    fn escalates_when_observed_process_ignores_term() {
        use std::io::{BufRead, BufReader};
        use std::process::Stdio;
        let mut child = std::process::Command::new("sh")
            .args(["-c", "trap '' TERM; echo ready; read line"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert_eq!(line.trim(), "ready");
        let input = child.stdin.take().unwrap();
        let snapshot = process_snapshot(child.id()).unwrap();
        let reaper = std::thread::spawn(move || child.wait().unwrap());
        let result = stop_observed_processes(&[snapshot]);
        drop(input);
        assert!(result.is_ok());
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(reaper.join().unwrap().signal(), Some(9));
    }

    #[test]
    fn ignores_reused_process_ids() {
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let mut stale = process_snapshot(child.id()).unwrap();
        stale.started_at_micros += 1;
        let result = stop_observed_processes(&[stale]);
        let alive = child.try_wait().unwrap().is_none();
        let _ = child.kill();
        let _ = child.wait();
        assert!(result.is_ok());
        assert!(alive);
    }
}

#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    use super::{process_snapshot, terminate_process_instance};

    #[test]
    fn refuses_to_terminate_a_reused_windows_process_id() {
        let mut recycled = process_snapshot(std::process::id()).expect("current process snapshot");
        recycled.started_at_micros = recycled.started_at_micros.saturating_add(1);
        terminate_process_instance(&recycled, true).expect("reject recycled process instance");
        assert!(process_snapshot(std::process::id()).is_ok());
    }
}
