//! Process-instance identity is independent of the executable's on-disk lifetime.
use crate::{PlatformError, ProcessSnapshot};

#[derive(Debug, Clone, Copy)]
pub struct ProcessIdentity {
    pub id: u32,
    pub parent_id: u32,
    pub started_at_micros: u64,
}

pub fn process_instance(process_id: u32, started_at_micros: u64) -> Option<ProcessIdentity> {
    process_identity(process_id)
        .ok()
        .filter(|live| live.started_at_micros == started_at_micros)
}

/// Distinguishes a confirmed absent PID from a process that could not be inspected.
/// This does not pin a PID for signal delivery.
#[cfg(target_os = "linux")]
pub fn observe_process_identity(process_id: u32) -> Result<Option<ProcessIdentity>, PlatformError> {
    match process_identity(process_id) {
        Ok(identity) => Ok(Some(identity)),
        Err(PlatformError::NotFound(_)) => Ok(None),
        Err(error) => Err(error),
    }
}

/// Windows process_identity maps a PID that exited after enumeration (or was
/// never valid) to NotFound, which establishes absence; any other inspection
/// failure stays an error.
#[cfg(target_os = "windows")]
pub fn observe_process_identity(process_id: u32) -> Result<Option<ProcessIdentity>, PlatformError> {
    match process_identity(process_id) {
        Ok(identity) => Ok(Some(identity)),
        Err(PlatformError::NotFound(_)) => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn observe_process_identity(
    _process_id: u32,
) -> Result<Option<ProcessIdentity>, PlatformError> {
    Err(PlatformError::Unsupported(
        "process identities require Windows, macOS, or Linux",
    ))
}

impl From<&ProcessSnapshot> for ProcessIdentity {
    fn from(process: &ProcessSnapshot) -> Self {
        Self {
            id: process.id,
            parent_id: process.parent_id,
            started_at_micros: process.started_at_micros,
        }
    }
}

#[cfg(target_os = "macos")]
pub fn process_identity(process_id: u32) -> Result<ProcessIdentity, PlatformError> {
    let native_id = i32::try_from(process_id)
        .map_err(|_| PlatformError::Invalid(format!("PID {process_id} exceeds i32::MAX")))?;
    macos_identity(native_id)
        .map(|(identity, _)| identity)
        .map_err(|error| {
            PlatformError::NotFound(format!("cannot inspect PID {process_id}: {error}"))
        })
}

/// BSDInfo errors do not establish absence; ESRCH or a zombie state do.
#[cfg(target_os = "macos")]
pub fn observe_process_identity(process_id: u32) -> Result<Option<ProcessIdentity>, PlatformError> {
    use nix::{errno::Errno, sys::signal::kill, unistd::Pid};

    let native_id = i32::try_from(process_id)
        .ok()
        .filter(|id| *id > 0)
        .ok_or_else(|| PlatformError::Invalid(format!("PID {process_id} is invalid")))?;
    match macos_identity(native_id) {
        Ok((identity, zombie)) => Ok((!zombie).then_some(identity)),
        Err(error) => match kill(Pid::from_raw(native_id), None) {
            Err(Errno::ESRCH) => Ok(None),
            _ => Err(PlatformError::Invalid(format!(
                "process presence is unconfirmed for PID {process_id}: {error}"
            ))),
        },
    }
}

#[cfg(target_os = "macos")]
fn macos_identity(process_id: i32) -> Result<(ProcessIdentity, bool), String> {
    use libproc::libproc::bsd_info::BSDInfo;
    use libproc::libproc::proc_pid::pidinfo;
    let info = pidinfo::<BSDInfo>(process_id, 0)?;
    Ok((
        ProcessIdentity {
            id: info.pbi_pid,
            parent_id: info.pbi_ppid,
            started_at_micros: info
                .pbi_start_tvsec
                .saturating_mul(1_000_000)
                .saturating_add(info.pbi_start_tvusec),
        },
        info.pbi_status == nix::libc::SZOMB,
    ))
}

#[cfg(target_os = "linux")]
pub fn process_identity(process_id: u32) -> Result<ProcessIdentity, PlatformError> {
    let (parent_id, _, started_at_micros) = super::process::linux_stat_fields(process_id)?;
    Ok(ProcessIdentity {
        id: process_id,
        parent_id,
        started_at_micros,
    })
}

#[cfg(target_os = "windows")]
pub fn process_identity(process_id: u32) -> Result<ProcessIdentity, PlatformError> {
    const ERROR_INVALID_PARAMETER: i32 = 87;

    let parent_id = super::process::parent_process_id(process_id)?
        .ok_or_else(|| PlatformError::NotFound(format!("cannot inspect PID {process_id}")))?;
    // OpenProcess reports ERROR_INVALID_PARAMETER when a non-zero PID exits after enumeration.
    let started_at_micros =
        super::process::process_started_at_micros(process_id).map_err(|error| match &error {
            PlatformError::ProcessInspection { source, .. }
                if process_id != 0 && source.raw_os_error() == Some(ERROR_INVALID_PARAMETER) =>
            {
                PlatformError::NotFound(format!("cannot inspect PID {process_id}: {source}"))
            }
            _ => error,
        })?;
    Ok(ProcessIdentity {
        id: process_id,
        parent_id,
        started_at_micros,
    })
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn process_identity(_process_id: u32) -> Result<ProcessIdentity, PlatformError> {
    Err(PlatformError::Unsupported(
        "process identities require Windows, macOS, or Linux",
    ))
}

#[cfg(test)]
#[path = "process_identity_tests.rs"]
mod tests;
