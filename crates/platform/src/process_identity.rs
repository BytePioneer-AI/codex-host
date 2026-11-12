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
    use libproc::libproc::bsd_info::BSDInfo;
    use libproc::libproc::proc_pid::pidinfo;

    let native_id = i32::try_from(process_id)
        .map_err(|_| PlatformError::Invalid(format!("PID {process_id} exceeds i32::MAX")))?;
    let info = pidinfo::<BSDInfo>(native_id, 0).map_err(|error| {
        PlatformError::NotFound(format!("cannot inspect PID {process_id}: {error}"))
    })?;
    Ok(ProcessIdentity {
        id: info.pbi_pid,
        parent_id: info.pbi_ppid,
        started_at_micros: info
            .pbi_start_tvsec
            .saturating_mul(1_000_000)
            .saturating_add(info.pbi_start_tvusec),
    })
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
    let parent_id = super::process::parent_process_id(process_id)?
        .ok_or_else(|| PlatformError::NotFound(format!("cannot inspect PID {process_id}")))?;
    Ok(ProcessIdentity {
        id: process_id,
        parent_id,
        started_at_micros: super::process::process_started_at_micros(process_id)?,
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
