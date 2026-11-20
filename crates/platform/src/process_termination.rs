use super::process::ProcessSnapshot;
use super::{PlatformError, ProcessIdentity};

#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::process::{
    ObservedProcessTree, process_snapshot, process_snapshots, same_process_instance,
};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::process_identity;
#[cfg(target_os = "windows")]
use super::windows_process;

pub fn terminate_process_instance(
    expected: &ProcessSnapshot,
    _force: bool,
) -> Result<(), PlatformError> {
    terminate_process_identity(&expected.into(), _force)
}

pub fn terminate_process_identity(
    expected: &ProcessIdentity,
    _force: bool,
) -> Result<(), PlatformError> {
    #[cfg(target_os = "windows")]
    {
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
        signal_process_identity(expected, signal)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = (expected, _force);
        Err(PlatformError::Unsupported(
            "exact process termination requires Windows, macOS, or Linux",
        ))
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn signal_process_identity(
    expected: &ProcessIdentity,
    signal: nix::sys::signal::Signal,
) -> Result<(), PlatformError> {
    #[cfg(target_os = "linux")]
    let descriptor = {
        use rustix::process::{Pid, PidfdFlags, pidfd_open};
        let process_id = Pid::from_raw(expected.id as i32)
            .ok_or_else(|| PlatformError::Invalid(format!("PID {} is invalid", expected.id)))?;
        match pidfd_open(process_id, PidfdFlags::empty()) {
            Ok(descriptor) => descriptor,
            Err(error) if error == rustix::io::Errno::SRCH => return Ok(()),
            Err(error) => return Err(PlatformError::Io(error.into())),
        }
    };
    let current = match process_identity(expected.id) {
        Ok(current) => current,
        Err(PlatformError::NotFound(_)) => return Ok(()),
        Err(error) => return Err(error),
    };
    if current.started_at_micros != expected.started_at_micros {
        return Err(PlatformError::Invalid(format!(
            "PID {} was reused before signal delivery",
            expected.id
        )));
    }
    #[cfg(target_os = "linux")]
    {
        use rustix::process::{Signal, pidfd_send_signal};
        let signal = Signal::from_named_raw(signal as i32)
            .ok_or_else(|| PlatformError::Invalid(format!("unsupported Unix signal {signal}")))?;
        if let Err(error) = pidfd_send_signal(descriptor, signal)
            && error != rustix::io::Errno::SRCH
        {
            return Err(PlatformError::Io(error.into()));
        }
    }
    #[cfg(target_os = "macos")]
    {
        use nix::{errno::Errno, sys::signal::kill, unistd::Pid};
        let process_id = i32::try_from(expected.id)
            .map_err(|_| PlatformError::Invalid(format!("PID {} exceeds i32::MAX", expected.id)))?;
        if let Err(error) = kill(Pid::from_raw(process_id), signal)
            && error != Errno::ESRCH
        {
            return Err(PlatformError::Io(std::io::Error::from_raw_os_error(
                error as i32,
            )));
        }
    }
    Ok(())
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
    use super::terminate_process_instance;
    use crate::process_snapshot;

    #[test]
    fn refuses_to_terminate_a_reused_windows_process_id() {
        let mut recycled = process_snapshot(std::process::id()).expect("current process snapshot");
        recycled.started_at_micros = recycled.started_at_micros.saturating_add(1);
        terminate_process_instance(&recycled, true).expect("reject recycled process instance");
        assert!(process_snapshot(std::process::id()).is_ok());
    }
}
