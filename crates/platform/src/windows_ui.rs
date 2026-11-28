use std::ffi::c_void;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr::null_mut;

use windows::Win32::System::Com::{
    COINIT_APARTMENTTHREADED, CoInitializeEx, CoTaskMemFree, CoUninitialize,
};
use windows::Win32::UI::Shell::{SHOpenFolderAndSelectItems, SHParseDisplayName, ShellExecuteW};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::core::PCWSTR;

const SW_HIDE: i32 = 0;
const MB_OK: u32 = 0;
const MB_ICONERROR: u32 = 0x0000_0010;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetConsoleWindow() -> *mut c_void;
}

#[link(name = "user32")]
unsafe extern "system" {
    fn ShowWindow(window: *mut c_void, command: i32) -> i32;
    fn MessageBoxW(owner: *mut c_void, text: *const u16, caption: *const u16, kind: u32) -> i32;
}

pub(super) fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}

fn shell_execute_result(code: usize) -> io::Result<()> {
    if code > 32 {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "ShellExecuteW failed with code {code}"
        )))
    }
}

pub fn open_external_url(url: &str) -> io::Result<()> {
    let operation = wide_null("open");
    let url = wide_null(url);
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(operation.as_ptr()),
            PCWSTR(url.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    shell_execute_result(result.0 as usize)
}

pub(super) fn reveal_file(path: &Path) -> io::Result<()> {
    let path: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(io::Error::other)?;
        let mut item = null_mut();
        // With no child array, Explorer opens the item's parent and selects the item itself.
        let result = SHParseDisplayName(PCWSTR(path.as_ptr()), None, &mut item, 0, None)
            .and_then(|()| SHOpenFolderAndSelectItems(item, None, 0));
        CoTaskMemFree(Some(item.cast()));
        CoUninitialize();
        result.map_err(io::Error::other)
    }
}

pub(super) fn message_box(message: &str, kind: u32) -> i32 {
    let message = wide_null(message);
    let caption = wide_null("codexhost");
    unsafe { MessageBoxW(null_mut(), message.as_ptr(), caption.as_ptr(), kind) }
}

pub fn hide_console_window() {
    unsafe {
        let window = GetConsoleWindow();
        if !window.is_null() {
            ShowWindow(window, SW_HIDE);
        }
    }
}

pub fn show_error_dialog(message: &str) {
    message_box(message, MB_OK | MB_ICONERROR);
}

#[cfg(test)]
mod tests {
    use super::shell_execute_result;

    #[test]
    fn shell_execute_requires_a_result_above_the_documented_error_range() {
        assert!(shell_execute_result(32).is_err());
        assert!(shell_execute_result(33).is_ok());
    }
}
