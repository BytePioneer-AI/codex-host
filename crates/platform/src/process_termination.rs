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
            // A process that is mid-exit is still reported by the process
            // enumeration, yet reading its image path fails with access denied
            // rather than a missing-process error. Treat that like an
            // already-gone process: the instance cannot be confirmed, so it must
            // not be terminated, and the caller's retry loop observes the exit.
            Err(PlatformError::Io(error))
                if error.kind() == std::io::ErrorKind::PermissionDenied =>
            {
                return Ok(());
            }
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

#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    use super::{PlatformError, ProcessSnapshot, process_snapshot, terminate_process_instance};
    use std::path::PathBuf;

    /// The System process: always running, never readable.
    const SYSTEM_PROCESS_ID: u32 = 4;

    #[test]
    fn treats_an_unreadable_process_image_as_an_unconfirmable_instance() {
        // Reading the System process image fails with access denied rather than
        // a missing-process error, which is the same failure a mid-exit process
        // produces while it is still reported by the process enumeration.
        let denied = process_snapshot(SYSTEM_PROCESS_ID).expect_err("System image path is denied");
        assert!(
            matches!(&denied, PlatformError::Io(error)
                if error.kind() == std::io::ErrorKind::PermissionDenied),
            "expected access denied, got {denied:?}"
        );

        // Deliberately mismatched, so no path can confirm - and therefore
        // terminate - this instance even if the image path became readable.
        let unconfirmable = ProcessSnapshot {
            id: SYSTEM_PROCESS_ID,
            parent_id: 0,
            process_group_id: SYSTEM_PROCESS_ID,
            executable: PathBuf::from(r"C:\codexhost-test\never-matches.exe"),
            started_at_micros: 1,
        };
        terminate_process_instance(&unconfirmable, true)
            .expect("tolerate an unreadable process image");

        assert!(
            !matches!(
                process_snapshot(SYSTEM_PROCESS_ID),
                Err(PlatformError::NotFound(_))
            ),
            "System process must still be running"
        );
    }

    #[test]
    fn refuses_to_terminate_a_reused_windows_process_id() {
        let mut recycled = process_snapshot(std::process::id()).expect("current process snapshot");
        recycled.started_at_micros = recycled.started_at_micros.saturating_add(1);
        terminate_process_instance(&recycled, true).expect("reject recycled process instance");
        assert!(process_snapshot(std::process::id()).is_ok());
    }
}
