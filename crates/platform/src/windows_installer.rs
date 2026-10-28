//! Installation-time shutdown scoped to exact executable paths, not image names.

use std::io;
use std::path::{Path, PathBuf};

use windows::Win32::Foundation::{
    ERROR_FAIL_NOACTION_REBOOT, ERROR_FAIL_SHUTDOWN, FILETIME, HANDLE, WAIT_OBJECT_0, WIN32_ERROR,
};
use windows::Win32::System::RestartManager::{
    CCH_RM_SESSION_KEY, RM_UNIQUE_PROCESS, RmEndSession, RmForceShutdown, RmRegisterResources,
    RmShutdown, RmStartSession,
};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, QueryFullProcessImageNameW, WaitForSingleObject,
};
use windows::core::{Owned, PWSTR};

use crate::{PlatformError, node_entrypoint_path, windows_process};

struct RestartSession(u32);

impl Drop for RestartSession {
    fn drop(&mut self) {
        unsafe {
            let _ = RmEndSession(self.0);
        }
    }
}

struct Application {
    handle: Owned<HANDLE>,
    identity: RM_UNIQUE_PROCESS,
}

fn executable_key(path: &Path) -> String {
    node_entrypoint_path(path)
        .to_string_lossy()
        .replace('/', "\\")
        .to_lowercase()
}

fn restart_result(operation: &str, result: WIN32_ERROR) -> Result<(), PlatformError> {
    if result.0 == 0 {
        Ok(())
    } else {
        Err(PlatformError::Invalid(format!(
            "{operation}: {}",
            io::Error::from_raw_os_error(result.0 as i32)
        )))
    }
}

fn applications(executable_keys: &[String]) -> Result<Vec<Application>, PlatformError> {
    let mut applications = Vec::new();
    for entry in windows_process::process_entries()? {
        // Protected system processes are not ours. Inspect accessible processes without
        // requesting termination rights; Restart Manager enforces shutdown permissions.
        let Ok(handle) = (unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                false,
                entry.id,
            )
        }) else {
            continue;
        };
        let handle = unsafe { Owned::new(handle) };
        let mut image = vec![0_u16; 32_768];
        let mut length = image.len() as u32;
        if unsafe {
            QueryFullProcessImageNameW(
                *handle,
                PROCESS_NAME_WIN32,
                PWSTR(image.as_mut_ptr()),
                &mut length,
            )
        }
        .is_err()
        {
            continue;
        }
        let image = PathBuf::from(String::from_utf16_lossy(&image[..length as usize]));
        if !executable_keys.contains(&executable_key(&image)) {
            continue;
        }
        if entry.id == std::process::id() {
            return Err(PlatformError::Invalid(
                "the installer shutdown helper must run outside the installation".into(),
            ));
        }
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        // Read path and creation time through the same handle. Restart Manager uses
        // PID + creation time, so a recycled PID cannot select an unrelated process.
        unsafe { GetProcessTimes(*handle, &mut created, &mut exited, &mut kernel, &mut user) }
            .map_err(|error| {
                PlatformError::Invalid(format!("inspect installer target: {error}"))
            })?;
        applications.push(Application {
            handle,
            identity: RM_UNIQUE_PROCESS {
                dwProcessId: entry.id,
                ProcessStartTime: created,
            },
        });
    }
    Ok(applications)
}

/// Requests Windows shutdown, with a forced fallback for unresponsive applications.
/// Only processes whose executable matches one of the supplied absolute files are
/// registered; other users of files in the installation are left to the installer's
/// normal file-in-use checks. Applications are not automatically restarted.
pub fn shutdown_processes_for_executables(executables: &[PathBuf]) -> Result<(), PlatformError> {
    let keys = executables
        .iter()
        .map(|executable| {
            if !executable.is_absolute() {
                return Err(PlatformError::Invalid(
                    "installer executable paths must be absolute".into(),
                ));
            }
            Ok(executable_key(&executable.canonicalize()?))
        })
        .collect::<Result<Vec<_>, PlatformError>>()?;
    if keys.is_empty() {
        return Ok(());
    }

    // A shutting-down Launcher can briefly start a diagnostic console. Reinspect
    // exact images after shutdown, but do not chase an indefinitely restarting app.
    for _ in 0..3 {
        let applications = applications(&keys)?;
        if applications.is_empty() {
            return Ok(());
        }
        let identities = applications
            .iter()
            .map(|app| app.identity)
            .collect::<Vec<_>>();
        let mut session = 0;
        let mut key = [0_u16; CCH_RM_SESSION_KEY as usize + 1];
        restart_result("start installer shutdown", unsafe {
            RmStartSession(&mut session, None, PWSTR(key.as_mut_ptr()))
        })?;
        let session = RestartSession(session);
        restart_result("register installer processes", unsafe {
            RmRegisterResources(session.0, None, Some(&identities), None)
        })?;
        let result = unsafe { RmShutdown(session.0, RmForceShutdown.0 as u32, None) };
        // Headless processes may have no Restart Manager shutdown mechanism. They
        // can still be terminated by exact instance; never fall back to image names.
        let force_remaining = result == ERROR_FAIL_SHUTDOWN || result == ERROR_FAIL_NOACTION_REBOOT;
        if !force_remaining {
            restart_result("close installer processes", result)?;
        }
        for application in &applications {
            if force_remaining
                && unsafe { WaitForSingleObject(*application.handle, 0) } != WAIT_OBJECT_0
            {
                let created = application.identity.ProcessStartTime;
                let started_at_micros = ((u64::from(created.dwHighDateTime) << 32)
                    | u64::from(created.dwLowDateTime))
                    / 10;
                if let Err(error) = windows_process::terminate_process_instance(
                    application.identity.dwProcessId,
                    started_at_micros,
                    1,
                ) && unsafe { WaitForSingleObject(*application.handle, 0) } != WAIT_OBJECT_0
                {
                    return Err(error.into());
                }
            }
            if unsafe { WaitForSingleObject(*application.handle, 5_000) } != WAIT_OBJECT_0 {
                return Err(PlatformError::Invalid(format!(
                    "installer target PID {} did not exit",
                    application.identity.dwProcessId
                )));
            }
        }
    }
    if applications(&keys)?.is_empty() {
        Ok(())
    } else {
        Err(PlatformError::Invalid(
            "codexhost processes kept restarting during installation".into(),
        ))
    }
}

#[cfg(test)]
#[path = "windows_installer_tests.rs"]
mod tests;
