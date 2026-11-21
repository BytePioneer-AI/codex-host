//! Process observation for a single Windows Desktop startup attempt.

use std::collections::HashMap;
use std::io;

use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, WaitForSingleObject,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowThreadProcessId, IsWindowVisible,
};
use windows::core::{BOOL, Owned};

use crate::process::windows_executable_key;
use crate::windows_process::{
    process_entries, process_image_path, process_started_at_micros_from_handle,
};
use crate::{DesktopIdentity, DesktopInstallation, PlatformError, ProcessSnapshot};

/// Don't treat an unreadable potential Desktop as absence. Other applications
/// with the same basename only conflict if they resolve to the target or a
/// registered Codex package (including another version during a Store update).
fn is_desktop_candidate(
    entry: &crate::windows_process::ProcessEntry,
    installation: &DesktopInstallation,
    expected: &str,
) -> Result<bool, PlatformError> {
    if !installation
        .desktop_executable
        .file_name()
        .is_some_and(|name| entry.has_executable_name(name))
    {
        return Ok(false);
    }
    let path = process_image_path(entry.id).map_err(|source| PlatformError::ProcessInspection {
        process_id: entry.id,
        operation: "inspect potential Desktop executable",
        source,
    })?;
    let key = windows_executable_key(&path);
    Ok(key == expected
        || (matches!(
            &installation.identity,
            DesktopIdentity::WindowsPackage {
                appx_activation: Some(_),
                ..
            }
        ) && key.contains("\\windowsapps\\openai.codex_")
            && key.ends_with("\\app\\chatgpt.exe")))
}

pub fn require_no_windows_desktop(installation: &DesktopInstallation) -> Result<(), PlatformError> {
    let expected = windows_executable_key(&installation.desktop_executable);
    for entry in process_entries()? {
        if is_desktop_candidate(&entry, installation, &expected)? {
            return Err(PlatformError::UnmanagedDesktopConflict);
        }
    }
    Ok(())
}

struct Member {
    handle: Owned<HANDLE>,
    started_at_micros: u64,
}

/// Retain handles even after exit so each observed child remains attributable
/// after its parent disappears and can't be mistaken for a recycled PID.
pub struct WindowsDesktopWatch {
    root: ProcessSnapshot,
    descendants: HashMap<u32, Member>,
}

impl WindowsDesktopWatch {
    pub fn new(root: ProcessSnapshot) -> Self {
        Self {
            root,
            descendants: HashMap::new(),
        }
    }

    /// Report whether a known descendant is still live. An external Desktop
    /// or incomplete observation is an error, never proof of clean shutdown.
    pub fn observe(&mut self, installation: &DesktopInstallation) -> Result<bool, PlatformError> {
        let entries = process_entries()?;
        loop {
            let before = self.descendants.len();
            for entry in &entries {
                if entry.id == self.root.id || self.descendants.contains_key(&entry.id) {
                    continue;
                }
                let parent_started_at = if entry.parent_id == self.root.id {
                    self.root.started_at_micros
                } else if let Some(parent) = self.descendants.get(&entry.parent_id) {
                    parent.started_at_micros
                } else {
                    continue;
                };
                let handle = unsafe {
                    OpenProcess(
                        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                        false,
                        entry.id,
                    )
                }
                .map_err(|error| {
                    PlatformError::Invalid(format!(
                        "cannot supervise a Desktop descendant: {error}"
                    ))
                })?;
                let handle = unsafe { Owned::new(handle) };
                let started_at_micros = process_started_at_micros_from_handle(handle.0)?;
                if started_at_micros >= parent_started_at {
                    self.descendants.insert(
                        entry.id,
                        Member {
                            handle,
                            started_at_micros,
                        },
                    );
                }
            }
            if before == self.descendants.len() {
                break;
            }
        }
        let expected = windows_executable_key(&installation.desktop_executable);
        for entry in &entries {
            if entry.id != self.root.id
                && !self.descendants.contains_key(&entry.id)
                && is_desktop_candidate(entry, installation, &expected)?
            {
                return Err(PlatformError::UnmanagedDesktopConflict);
            }
        }
        let mut residual = false;
        for member in self.descendants.values() {
            match unsafe { WaitForSingleObject(*member.handle, 0) } {
                WAIT_OBJECT_0 => {}
                WAIT_TIMEOUT => residual = true,
                _ => return Err(io::Error::last_os_error().into()),
            }
        }
        Ok(residual)
    }

    pub fn has_visible_window(&self) -> Result<bool, PlatformError> {
        struct VisibleWindow {
            pid: u32,
            found: bool,
        }
        unsafe extern "system" fn visit(window: HWND, context: LPARAM) -> BOOL {
            let state = unsafe { &mut *(context.0 as *mut VisibleWindow) };
            let mut pid = 0;
            unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };
            if pid == state.pid && unsafe { IsWindowVisible(window) }.as_bool() {
                state.found = true;
            }
            true.into()
        }
        let mut state = VisibleWindow {
            pid: self.root.id,
            found: false,
        };
        unsafe { EnumWindows(Some(visit), LPARAM((&raw mut state) as isize)) }.map_err(
            |error| PlatformError::Invalid(format!("cannot inspect Desktop windows: {error}")),
        )?;
        Ok(state.found)
    }
}
