use std::ptr::null_mut;

const SW_HIDE: i32 = 0;
const MB_OK: u32 = 0;
const MB_ICONERROR: u32 = 0x0000_0010;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetConsoleWindow() -> *mut std::ffi::c_void;
}

#[link(name = "user32")]
unsafe extern "system" {
    fn ShowWindow(window: *mut std::ffi::c_void, command: i32) -> i32;
    fn MessageBoxW(
        owner: *mut std::ffi::c_void,
        text: *const u16,
        caption: *const u16,
        kind: u32,
    ) -> i32;
}

fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
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
    let message = wide_null(message);
    let caption = wide_null("codexhost");
    unsafe {
        MessageBoxW(
            null_mut(),
            message.as_ptr(),
            caption.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}
