//! Reusable PID-reuse-safe process observation. No account or Host semantics.
use crate::{PlatformError, process_snapshot};

pub fn process_identity(pid: u32) -> Result<Option<String>, PlatformError> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err(PlatformError::Invalid("invalid process ID".into()));
    }
    match process_snapshot(pid) {
        Ok(snapshot) => {
            #[cfg(target_os = "linux")]
            let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?;
            #[cfg(not(target_os = "linux"))]
            let boot = "epoch";
            Ok(Some(format!(
                "{}:{}:{}",
                boot.trim(),
                snapshot.id,
                snapshot.started_at_micros
            )))
        }
        Err(error) => {
            #[cfg(target_os = "windows")]
            if matches!(error, PlatformError::NotFound(_)) {
                return Ok(None);
            }
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            {
                use nix::{errno::Errno, sys::signal::kill, unistd::Pid};
                // Some native snapshot APIs label inspection failures as NotFound.
                // Only ESRCH proves absence; EPERM and every other failure stay unknown.
                if matches!(kill(Pid::from_raw(pid as i32), None), Err(Errno::ESRCH)) {
                    return Ok(None);
                }
            }
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn observes_current_process_without_confusing_invalid_ids_with_absence() {
        let first = process_identity(std::process::id()).unwrap().unwrap();
        assert_eq!(Some(first), process_identity(std::process::id()).unwrap());
        assert!(process_identity(0).is_err());
        assert!(process_identity(u32::MAX).is_err());
    }
}
