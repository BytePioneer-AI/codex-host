//! A caller-held Job established before the AppX initial thread is resumed.
#[cfg(test)]
#[path = "windows_activation_job_tests.rs"]
mod tests;

use crate::{PlatformError, activation_binding, windows_process::ChildJob};
use std::{
    ffi::{OsString, c_void},
    mem::size_of,
    os::windows::ffi::OsStringExt,
    time::{Duration, Instant},
};
use windows::{
    Win32::{
        Foundation::HANDLE,
        System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    },
    core::Owned,
};

unsafe extern "system" {
    fn SuspendThread(thread: *mut c_void) -> u32;
    fn ResumeThread(thread: *mut c_void) -> u32;
    fn TerminateProcess(process: *mut c_void, code: u32) -> i32;
}
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtQueryInformationProcess(
        process: *mut c_void,
        class: u32,
        buffer: *mut c_void,
        size: u32,
        needed: *mut u32,
    ) -> i32;
}

#[link(name = "bcrypt")]
unsafe extern "system" {
    fn BCryptGenRandom(algorithm: *mut c_void, buffer: *mut u8, length: u32, flags: u32) -> i32;
}

fn name(key: &str) -> Result<String, PlatformError> {
    if !activation_binding::valid_key(key) {
        return Err(PlatformError::Invalid("invalid activation Job key".into()));
    }
    Ok(format!("Local\\codexhost-activation-{key}"))
}
pub struct WindowsLaunchJob {
    pub(crate) job: ChildJob,
    key: String,
}
impl WindowsLaunchJob {
    pub fn create_unique() -> Result<Self, PlatformError> {
        let mut bytes = [0u8; 16];
        if unsafe { BCryptGenRandom(std::ptr::null_mut(), bytes.as_mut_ptr(), 16, 2) } < 0 {
            return Err(PlatformError::Invalid(
                "activation entropy unavailable".into(),
            ));
        }
        Self::create(
            &bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
        )
    }
    pub fn create(key: &str) -> Result<Self, PlatformError> {
        Ok(Self {
            job: ChildJob::create_named(&name(key)?)?,
            key: key.into(),
        })
    }
    pub fn open(key: &str) -> Result<Self, PlatformError> {
        Ok(Self {
            job: ChildJob::open_named(&name(key)?)?,
            key: key.into(),
        })
    }
    pub fn key(&self) -> &str {
        &self.key
    }
    pub fn argument(&self) -> OsString {
        activation_binding::marker(&self.key).expect("validated Job key")
    }
    pub fn contains_pid(&self, pid: u32) -> Result<bool, PlatformError> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
            .map_err(|e| PlatformError::Invalid(format!("query activation PID: {e}")))?;
        let handle = unsafe { Owned::new(handle) };
        self.job.contains(handle.0).map_err(PlatformError::Io)
    }
    pub fn terminate_and_wait(&self, timeout: Duration) -> Result<(), PlatformError> {
        self.job.seal()?;
        self.job.terminate(1)?;
        self.wait_empty(timeout)
    }
    pub fn wait_empty(&self, timeout: Duration) -> Result<(), PlatformError> {
        let deadline = Instant::now() + timeout;
        loop {
            if !self.job.has_live_processes()? {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(PlatformError::Invalid(
                    "activation Job still holds installation resources".into(),
                ));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    pub fn ensure_no_images_under(root: &std::path::Path) -> Result<(), PlatformError> {
        let prefix = crate::node_entrypoint_path(&root.canonicalize()?)
            .to_string_lossy()
            .replace('/', "\\")
            .to_lowercase()
            + "\\";
        for entry in crate::windows_process::process_entries()? {
            let Ok(image) = crate::windows_process::process_image_path(entry.id) else {
                continue;
            };
            let image = crate::node_entrypoint_path(&image)
                .to_string_lossy()
                .replace('/', "\\")
                .to_lowercase();
            if image.starts_with(&prefix) {
                return Err(PlatformError::Invalid(format!(
                    "installation still held by PID {}; instance preserved",
                    entry.id
                )));
            }
        }
        Ok(())
    }
    pub fn had_bound_processes(&self) -> Result<bool, PlatformError> {
        Ok(self.job.had_processes()?)
    }
    pub fn is_empty(&self) -> Result<bool, PlatformError> {
        Ok(!self.job.has_live_processes()?)
    }
}

/// Query the suspended process's own command line, not its inherited environment
/// or a caller-supplied string. The returned UNICODE_STRING must stay in-buffer.
pub(crate) fn command_arguments(process: HANDLE) -> Result<Vec<OsString>, PlatformError> {
    #[repr(C)]
    struct Unicode {
        length: u16,
        maximum: u16,
        buffer: *const u16,
    }
    let mut needed = 0;
    unsafe {
        NtQueryInformationProcess(process.0, 60, std::ptr::null_mut(), 0, &mut needed);
    }
    if needed < (size_of::<Unicode>() as u32) || needed > 128 * 1024 {
        return Err(PlatformError::Invalid(
            "suspended command line size is invalid".into(),
        ));
    }
    let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
    let status = unsafe {
        NtQueryInformationProcess(
            process.0,
            60,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    };
    if status < 0 {
        return Err(PlatformError::Invalid(format!(
            "cannot read suspended command line: {status:#x}"
        )));
    }
    let value = unsafe { &*buffer.as_ptr().cast::<Unicode>() };
    let start = buffer.as_ptr() as usize;
    let end = start + buffer.len() * 8;
    let pointer = value.buffer as usize;
    if value.length % 2 != 0
        || pointer < start
        || pointer
            .checked_add(value.length as usize)
            .is_none_or(|limit| limit > end)
    {
        return Err(PlatformError::Invalid(
            "suspended command line pointer is invalid".into(),
        ));
    }
    let text = OsString::from_wide(unsafe {
        std::slice::from_raw_parts(value.buffer, value.length as usize / 2)
    });
    let text = text
        .into_string()
        .map_err(|_| PlatformError::Invalid("suspended command line is not UTF-16 text".into()))?;
    crate::windows_process_arguments::arguments(&text)
}

/// Foreign activations must be resumed normally, even if package debugging
/// supplied this launcher's environment. No argument binding means no Job action.
pub(crate) fn bind_before_resume(process: HANDLE, thread: HANDLE) -> Result<(), PlatformError> {
    let key = command_arguments(process)
        .ok()
        .and_then(|args| activation_binding::binding(&args).ok().flatten());
    let Some(key) = key else {
        return Ok(());
    };
    let Ok(job) = WindowsLaunchJob::open(&key) else {
        return Ok(());
    };
    let previous = unsafe { SuspendThread(thread.0) };
    if previous == u32::MAX {
        return Err(std::io::Error::last_os_error().into());
    }
    if previous == 0 {
        unsafe {
            ResumeThread(thread.0);
        }
        return Err(PlatformError::Invalid(
            "activation initial thread already ran; no ownership claimed".into(),
        ));
    }
    // Initial execution remains suspended throughout assignment. This is not a
    // snapshot of an already-running tree; no late descendants are enumerated.
    if let Err(error) = job.job.assign(process.0) {
        unsafe {
            TerminateProcess(process.0, 1);
        } // exact marked, still-suspended instance
        return Err(error.into());
    }
    if unsafe { ResumeThread(thread.0) } == u32::MAX {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(()) // caller consumes the original AppX suspension only after this returns
}
