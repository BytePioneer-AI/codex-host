use std::ffi::c_void;
use std::io;
use std::mem::{size_of, transmute};
use std::ptr::null_mut;

use windows::Win32::UI::Controls::{
    TASKDIALOG_BUTTON, TASKDIALOGCONFIG, TASKDIALOGCONFIG_0, TD_INFORMATION_ICON,
    TDF_ALLOW_DIALOG_CANCELLATION, TDF_SIZE_TO_CONTENT,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::core::PCWSTR;

const LOCALE_NAME_MAX_LENGTH: usize = 85;
const SW_HIDE: i32 = 0;
const MB_OK: u32 = 0;
const MB_YESNO: u32 = 4;
const MB_ICONERROR: u32 = 0x0000_0010;
const MB_ICONINFORMATION: u32 = 0x0000_0040;
const IDCANCEL: i32 = 2;
const IDYES: i32 = 6;
const IDNO: i32 = 7;
const RESTART_BUTTON_ID: i32 = 1001;
const RETRY_BUTTON_ID: i32 = 1002;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunningDesktopChoice {
    Restart,
    Retry,
    Cancel,
}

#[derive(Clone, Copy)]
struct RunningDesktopText {
    instruction: &'static str,
    content: &'static str,
    restart: &'static str,
    retry: &'static str,
    fallback: &'static str,
}

const ENGLISH_RUNNING_DESKTOP_TEXT: RunningDesktopText = RunningDesktopText {
    instruction: "Codex is already running",
    content: "The current Codex was not started by codexhost. To use codexhost, Codex must be restarted.",
    restart: "Exit and restart automatically (Recommended)",
    retry: "I've quit Codex, try again",
    fallback: "The current Codex was not started by codexhost. To use codexhost, Codex must be restarted.\n\nYes: exit and restart automatically.\nNo: try again after you quit Codex.",
};

const CHINESE_RUNNING_DESKTOP_TEXT: RunningDesktopText = RunningDesktopText {
    instruction: "Codex 已在运行",
    content: "当前 Codex 不是由 codexhost 启动的。要使用 codexhost，需要重新启动 Codex。",
    restart: "自动退出并重新启动（推荐）",
    retry: "我已退出，重试",
    fallback: "当前 Codex 不是由 codexhost 启动的。要使用 codexhost，需要重新启动 Codex。\n\n是：自动退出并重新启动。\n否：退出后重试。",
};

#[link(name = "kernel32")]
unsafe extern "system" {
    fn FreeLibrary(module: *mut c_void) -> i32;
    fn GetConsoleWindow() -> *mut c_void;
    fn GetUserDefaultLocaleName(locale_name: *mut u16, locale_name_length: i32) -> i32;
    fn GetProcAddress(module: *mut c_void, name: *const u8) -> *const c_void;
    fn LoadLibraryW(name: *const u16) -> *mut c_void;
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

fn user_locale_name() -> String {
    let mut locale = [0_u16; LOCALE_NAME_MAX_LENGTH];
    let length = unsafe {
        GetUserDefaultLocaleName(
            locale.as_mut_ptr(),
            i32::try_from(locale.len()).expect("locale buffer length fits i32"),
        )
    };
    if length <= 1 {
        return String::new();
    }
    String::from_utf16_lossy(
        &locale[..usize::try_from(length - 1).expect("positive locale length")],
    )
}

fn running_desktop_text_for_locale(locale: &str) -> RunningDesktopText {
    let locale = locale.to_ascii_lowercase();
    if locale == "zh-cn" || locale == "zh-sg" || locale.starts_with("zh-hans") {
        CHINESE_RUNNING_DESKTOP_TEXT
    } else {
        ENGLISH_RUNNING_DESKTOP_TEXT
    }
}

fn message_box(message: &str, kind: u32) -> i32 {
    let message = wide_null(message);
    let caption = wide_null("codexhost");
    unsafe { MessageBoxW(null_mut(), message.as_ptr(), caption.as_ptr(), kind) }
}

type TaskDialogIndirectFn =
    unsafe extern "system" fn(*const TASKDIALOGCONFIG, *mut i32, *mut i32, *mut i32) -> i32;

fn task_dialog_indirect(config: &TASKDIALOGCONFIG, selected: &mut i32) -> io::Result<()> {
    let library_name = wide_null("comctl32.dll");
    unsafe {
        let library = LoadLibraryW(library_name.as_ptr());
        if library.is_null() {
            return Err(io::Error::last_os_error());
        }
        let address = GetProcAddress(library, c"TaskDialogIndirect".as_ptr().cast());
        if address.is_null() {
            FreeLibrary(library);
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "TaskDialogIndirect is unavailable",
            ));
        }
        let task_dialog: TaskDialogIndirectFn = transmute(address);
        let result = task_dialog(config, selected, null_mut(), null_mut());
        FreeLibrary(library);
        if result < 0 {
            return Err(io::Error::other(format!(
                "TaskDialogIndirect failed with HRESULT 0x{:08x}",
                result as u32
            )));
        }
    }
    Ok(())
}

fn choice_dialog(
    instruction: &str,
    content: &str,
    buttons: &[(i32, &str)],
    default_button: i32,
) -> io::Result<i32> {
    let title = wide_null("codexhost");
    let instruction = wide_null(instruction);
    let content = wide_null(content);
    let button_text = buttons
        .iter()
        .map(|(_, text)| wide_null(text))
        .collect::<Vec<_>>();
    let native_buttons = buttons
        .iter()
        .zip(&button_text)
        .map(|((id, _), text)| TASKDIALOG_BUTTON {
            nButtonID: *id,
            pszButtonText: PCWSTR(text.as_ptr()),
        })
        .collect::<Vec<_>>();
    let config = TASKDIALOGCONFIG {
        cbSize: u32::try_from(size_of::<TASKDIALOGCONFIG>()).expect("Task Dialog size fits u32"),
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION | TDF_SIZE_TO_CONTENT,
        dwCommonButtons: Default::default(),
        pszWindowTitle: PCWSTR(title.as_ptr()),
        Anonymous1: TASKDIALOGCONFIG_0 {
            pszMainIcon: TD_INFORMATION_ICON,
        },
        pszMainInstruction: PCWSTR(instruction.as_ptr()),
        pszContent: PCWSTR(content.as_ptr()),
        cButtons: u32::try_from(native_buttons.len()).expect("Task Dialog button count fits u32"),
        pButtons: native_buttons.as_ptr(),
        nDefaultButton: default_button,
        ..Default::default()
    };
    let mut selected = IDCANCEL;
    task_dialog_indirect(&config, &mut selected)?;
    Ok(selected)
}

pub fn prompt_running_desktop() -> RunningDesktopChoice {
    let text = running_desktop_text_for_locale(&user_locale_name());
    let result = choice_dialog(
        text.instruction,
        text.content,
        &[
            (RESTART_BUTTON_ID, text.restart),
            (RETRY_BUTTON_ID, text.retry),
        ],
        RETRY_BUTTON_ID,
    );
    match result {
        Ok(RESTART_BUTTON_ID) => RunningDesktopChoice::Restart,
        Ok(RETRY_BUTTON_ID) => RunningDesktopChoice::Retry,
        Ok(_) => RunningDesktopChoice::Cancel,
        Err(_) => match message_box(text.fallback, MB_YESNO | MB_ICONINFORMATION) {
            IDYES => RunningDesktopChoice::Restart,
            IDNO => RunningDesktopChoice::Retry,
            _ => RunningDesktopChoice::Cancel,
        },
    }
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
    use super::{
        IDCANCEL, RESTART_BUTTON_ID, RETRY_BUTTON_ID, running_desktop_text_for_locale,
        shell_execute_result,
    };

    #[test]
    fn shell_execute_requires_a_result_above_the_documented_error_range() {
        assert!(shell_execute_result(32).is_err());
        assert!(shell_execute_result(33).is_ok());
    }

    #[test]
    fn running_desktop_actions_use_distinct_button_ids() {
        assert_ne!(RESTART_BUTTON_ID, RETRY_BUTTON_ID);
        assert_ne!(RESTART_BUTTON_ID, IDCANCEL);
        assert_ne!(RETRY_BUTTON_ID, IDCANCEL);
    }

    #[test]
    fn running_desktop_text_supports_simplified_chinese_and_english() {
        assert_eq!(
            running_desktop_text_for_locale("zh-CN").instruction,
            "Codex 已在运行"
        );
        assert_eq!(
            running_desktop_text_for_locale("zh-Hans-SG").instruction,
            "Codex 已在运行"
        );
        assert_eq!(
            running_desktop_text_for_locale("en-US").instruction,
            "Codex is already running"
        );
        assert_eq!(
            running_desktop_text_for_locale("zh-TW").instruction,
            "Codex is already running"
        );
    }
}
