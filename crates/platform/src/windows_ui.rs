use std::ffi::c_void;
use std::io;
use std::mem::{size_of, transmute};
use std::ptr::null_mut;

use windows::Win32::UI::Controls::{
    TASKDIALOG_BUTTON, TASKDIALOGCONFIG, TASKDIALOGCONFIG_0, TD_INFORMATION_ICON,
    TDF_ALLOW_DIALOG_CANCELLATION, TDF_SIZE_TO_CONTENT,
};
use windows::core::PCWSTR;

use super::{CompatibilityChoice, CompatibilityPrompt, CompatibilityUpdateAvailability};

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
const CONTINUE_CODEXHOST_BUTTON_ID: i32 = 1101;
const OPEN_LATEST_RELEASE_BUTTON_ID: i32 = 1102;
const OPEN_STOCK_CODEX_BUTTON_ID: i32 = 1103;

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

fn compatibility_choice(selected: i32) -> CompatibilityChoice {
    match selected {
        OPEN_LATEST_RELEASE_BUTTON_ID => CompatibilityChoice::OpenLatestRelease,
        OPEN_STOCK_CODEX_BUTTON_ID => CompatibilityChoice::OpenStockCodex,
        _ => CompatibilityChoice::ContinueCodexhost,
    }
}

pub fn prompt_compatibility_warning(prompt: &CompatibilityPrompt<'_>) -> CompatibilityChoice {
    let chinese = running_desktop_text_for_locale(&user_locale_name()).instruction
        == CHINESE_RUNNING_DESKTOP_TEXT.instruction;
    let capability = match (prompt.capability, chinese) {
        ("title-isolation", true) => "自动标题隔离",
        ("title-isolation", false) => "Automatic title isolation",
        (capability, _) => capability,
    };
    let update_message = match (prompt.update_availability, chinese) {
        (CompatibilityUpdateAvailability::Current, true) => {
            "当前 codexhost 已是最新版。兼容性更新即将发布，发布后 codexhost 会提示更新。你可以先继续使用当前版本。"
        }
        (CompatibilityUpdateAvailability::Unavailable, true) => {
            "兼容性更新发布后 codexhost 会提示更新；你可以先继续使用当前版本。"
        }
        (CompatibilityUpdateAvailability::Current, false) => {
            "This is the latest codexhost release. A compatibility update is coming and codexhost will notify you when it is available. You can continue with the current version for now."
        }
        (CompatibilityUpdateAvailability::Unavailable, false) => {
            "codexhost will notify you when a compatibility update is available; you can continue with the current version for now."
        }
    };
    let (instruction, content, continue_codexhost, latest_release, stock_codex) = if chinese {
        (
            "codexhost 正在适配此 Codex 版本",
            format!(
                "codexhost 已完成核心兼容检查，但此 Codex 版本尚未完成完整验证，部分增强功能可能存在兼容问题。{}\n\n检测位置：{}\n原因代码：{}\n内部标识：{}\nCodex Desktop：{}\ncodexhost：{}",
                update_message,
                capability,
                prompt.reason_code,
                prompt.observed_identity,
                prompt.desktop_version,
                prompt.codexhost_version,
            ),
            "继续使用当前版本",
            "查看发布页面",
            "使用原版 Codex",
        )
    } else {
        (
            "codexhost is adapting to this Codex version",
            format!(
                "codexhost completed its core compatibility checks, but this Codex version has not completed full validation and some enhanced features may be incompatible. {}\n\nArea: {}\nReason: {}\nInternal identity: {}\nCodex Desktop: {}\ncodexhost: {}",
                update_message,
                capability,
                prompt.reason_code,
                prompt.observed_identity,
                prompt.desktop_version,
                prompt.codexhost_version,
            ),
            "Continue with current version",
            "View releases",
            "Use stock Codex",
        )
    };
    match choice_dialog(
        instruction,
        &content,
        &[
            (CONTINUE_CODEXHOST_BUTTON_ID, continue_codexhost),
            (OPEN_LATEST_RELEASE_BUTTON_ID, latest_release),
            (OPEN_STOCK_CODEX_BUTTON_ID, stock_codex),
        ],
        CONTINUE_CODEXHOST_BUTTON_ID,
    ) {
        Ok(selected) => compatibility_choice(selected),
        Err(_) => {
            message_box(&content, MB_OK | MB_ICONINFORMATION);
            CompatibilityChoice::ContinueCodexhost
        }
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
        CONTINUE_CODEXHOST_BUTTON_ID, IDCANCEL, OPEN_LATEST_RELEASE_BUTTON_ID,
        OPEN_STOCK_CODEX_BUTTON_ID, RESTART_BUTTON_ID, RETRY_BUTTON_ID, compatibility_choice,
        running_desktop_text_for_locale,
    };

    #[test]
    fn running_desktop_actions_use_distinct_button_ids() {
        assert_ne!(RESTART_BUTTON_ID, RETRY_BUTTON_ID);
        assert_ne!(RESTART_BUTTON_ID, IDCANCEL);
        assert_ne!(RETRY_BUTTON_ID, IDCANCEL);
        assert_ne!(CONTINUE_CODEXHOST_BUTTON_ID, OPEN_LATEST_RELEASE_BUTTON_ID);
        assert_ne!(CONTINUE_CODEXHOST_BUTTON_ID, OPEN_STOCK_CODEX_BUTTON_ID);
        assert_ne!(OPEN_LATEST_RELEASE_BUTTON_ID, OPEN_STOCK_CODEX_BUTTON_ID);
    }

    #[test]
    fn maps_all_three_fixed_compatibility_choices() {
        assert_eq!(
            compatibility_choice(CONTINUE_CODEXHOST_BUTTON_ID),
            crate::CompatibilityChoice::ContinueCodexhost
        );
        assert_eq!(
            compatibility_choice(OPEN_LATEST_RELEASE_BUTTON_ID),
            crate::CompatibilityChoice::OpenLatestRelease
        );
        assert_eq!(
            compatibility_choice(OPEN_STOCK_CODEX_BUTTON_ID),
            crate::CompatibilityChoice::OpenStockCodex
        );
        assert_eq!(
            compatibility_choice(IDCANCEL),
            crate::CompatibilityChoice::ContinueCodexhost
        );
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
