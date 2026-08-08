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

fn compatibility_choice(selected: i32, allow_continue: bool) -> CompatibilityChoice {
    match selected {
        OPEN_LATEST_RELEASE_BUTTON_ID => CompatibilityChoice::OpenLatestRelease,
        OPEN_STOCK_CODEX_BUTTON_ID => CompatibilityChoice::OpenStockCodex,
        CONTINUE_CODEXHOST_BUTTON_ID if allow_continue => CompatibilityChoice::ContinueCodexhost,
        _ if allow_continue => CompatibilityChoice::ContinueCodexhost,
        _ => CompatibilityChoice::OpenStockCodex,
    }
}

pub fn prompt_compatibility_warning(prompt: &CompatibilityPrompt<'_>) -> CompatibilityChoice {
    let chinese = running_desktop_text_for_locale(&user_locale_name()).instruction
        == CHINESE_RUNNING_DESKTOP_TEXT.instruction;
    let capability = match (prompt.capability, chinese) {
        ("title-isolation", true) => "自动标题隔离",
        ("draft-routing", true) => "草稿路由",
        ("agent-routing", true) => "Agent 路由",
        ("permission-control", true) => "权限控制",
        ("sidebar-decoration", true) => "侧边栏标识",
        ("fork-control", true) => "Fork 控制",
        ("usage-surface", true) => "Usage 显示",
        ("settings-surface", true) => "设置入口",
        ("compatibility-detection", true) => "兼容性检测",
        ("title-isolation", false) => "Automatic title isolation",
        ("draft-routing", false) => "Draft routing",
        ("agent-routing", false) => "Agent routing",
        ("compatibility-detection", false) => "Compatibility detection",
        (capability, _) => capability,
    };
    let update_message = match (prompt.update_availability, prompt.allow_continue, chinese) {
        (CompatibilityUpdateAvailability::Started, true, true) => {
            "codexhost 已开始在后台准备适配更新，你可以继续使用当前版本。"
        }
        (CompatibilityUpdateAvailability::Started, false, true) => {
            "codexhost 已开始在后台准备适配更新，当前受管模式将关闭。"
        }
        (CompatibilityUpdateAvailability::Started, true, false) => {
            "codexhost started preparing an adapted update in the background, and you can continue with the current version."
        }
        (CompatibilityUpdateAvailability::Started, false, false) => {
            "codexhost started preparing an adapted update in the background, and managed mode will close."
        }
        (CompatibilityUpdateAvailability::Current, true, true) => {
            "当前 codexhost 已是最新版。适配更新发布后会提示更新，你可以先继续使用当前版本。"
        }
        (CompatibilityUpdateAvailability::Unavailable, true, true) => {
            "适配更新发布后会提示更新，你可以先继续使用当前版本。"
        }
        (CompatibilityUpdateAvailability::Current, false, true) => {
            "当前 codexhost 已是最新版。请查看发布页面获取后续适配版本，或使用原版 Codex。"
        }
        (CompatibilityUpdateAvailability::Unavailable, false, true) => {
            "请查看发布页面获取适配版本，或使用原版 Codex。"
        }
        (CompatibilityUpdateAvailability::Current, true, false) => {
            "This is the latest codexhost release. You will be notified when an adaptation is published, and you can continue with the current version."
        }
        (CompatibilityUpdateAvailability::Unavailable, true, false) => {
            "You will be notified when an adaptation is published, and you can continue with the current version."
        }
        (CompatibilityUpdateAvailability::Current, false, false) => {
            "This is the latest codexhost release. View releases for a future adaptation, or use stock Codex."
        }
        (CompatibilityUpdateAvailability::Unavailable, false, false) => {
            "View releases for an adapted version, or use stock Codex."
        }
    };
    let summary = if chinese {
        if !prompt.allow_continue {
            "codexhost 无法确认关键兼容边界，因此不能继续受管模式。"
        } else if prompt.degraded {
            "一项非关键增强功能不可用，codexhost 已将其安全禁用。"
        } else {
            "codexhost 已完成核心兼容检查，但此 Codex 版本尚未完成完整验证。"
        }
    } else if !prompt.allow_continue {
        "codexhost cannot verify a critical compatibility boundary, so managed mode cannot continue."
    } else if prompt.degraded {
        "A non-critical enhancement is unavailable and has been safely disabled."
    } else {
        "codexhost completed its core compatibility checks, but this Codex version has not completed full validation."
    };
    let identity = prompt.observed_identity.map_or_else(String::new, |value| {
        if chinese {
            format!("\n内部标识：{value}")
        } else {
            format!("\nInternal identity: {value}")
        }
    });
    let instruction = if chinese {
        if prompt.allow_continue {
            "codexhost 正在适配此 Codex 版本"
        } else {
            "codexhost 与此 Codex 版本不兼容"
        }
    } else if prompt.allow_continue {
        "codexhost is adapting to this Codex version"
    } else {
        "codexhost is incompatible with this Codex version"
    };
    let content = if chinese {
        format!(
            "{summary}{update_message}\n\n检测位置：{capability}\n原因代码：{}{identity}\nCodex Desktop：{}\ncodexhost：{}",
            prompt.reason_code, prompt.desktop_version, prompt.codexhost_version,
        )
    } else {
        format!(
            "{summary} {update_message}\n\nArea: {capability}\nReason: {}{identity}\nCodex Desktop: {}\ncodexhost: {}",
            prompt.reason_code, prompt.desktop_version, prompt.codexhost_version,
        )
    };
    let continue_codexhost = match (prompt.update_availability, prompt.allow_continue, chinese) {
        (CompatibilityUpdateAvailability::Started, true, true) => "继续等待更新",
        (CompatibilityUpdateAvailability::Started, false, true) => "关闭并安装更新",
        (CompatibilityUpdateAvailability::Started, true, false) => "Continue while updating",
        (CompatibilityUpdateAvailability::Started, false, false) => "Close and install update",
        (_, _, true) => "继续使用当前版本",
        (_, _, false) => "Continue with current version",
    };
    let latest_release = if chinese {
        "查看发布页面"
    } else {
        "View releases"
    };
    let stock_codex = if chinese {
        "使用原版 Codex"
    } else {
        "Use stock Codex"
    };
    let buttons = if prompt.update_availability == CompatibilityUpdateAvailability::Started {
        vec![(CONTINUE_CODEXHOST_BUTTON_ID, continue_codexhost)]
    } else if prompt.allow_continue {
        vec![
            (CONTINUE_CODEXHOST_BUTTON_ID, continue_codexhost),
            (OPEN_LATEST_RELEASE_BUTTON_ID, latest_release),
            (OPEN_STOCK_CODEX_BUTTON_ID, stock_codex),
        ]
    } else {
        vec![
            (OPEN_LATEST_RELEASE_BUTTON_ID, latest_release),
            (OPEN_STOCK_CODEX_BUTTON_ID, stock_codex),
        ]
    };
    let default_button = if prompt.update_availability == CompatibilityUpdateAvailability::Started
        || prompt.allow_continue
    {
        CONTINUE_CODEXHOST_BUTTON_ID
    } else {
        OPEN_STOCK_CODEX_BUTTON_ID
    };
    match choice_dialog(instruction, &content, &buttons, default_button) {
        Ok(selected) => compatibility_choice(selected, prompt.allow_continue),
        Err(_) => {
            message_box(&content, MB_OK | MB_ICONINFORMATION);
            compatibility_choice(IDCANCEL, prompt.allow_continue)
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
            compatibility_choice(CONTINUE_CODEXHOST_BUTTON_ID, true),
            crate::CompatibilityChoice::ContinueCodexhost
        );
        assert_eq!(
            compatibility_choice(OPEN_LATEST_RELEASE_BUTTON_ID, true),
            crate::CompatibilityChoice::OpenLatestRelease
        );
        assert_eq!(
            compatibility_choice(OPEN_STOCK_CODEX_BUTTON_ID, true),
            crate::CompatibilityChoice::OpenStockCodex
        );
        assert_eq!(
            compatibility_choice(IDCANCEL, true),
            crate::CompatibilityChoice::ContinueCodexhost
        );
        assert_eq!(
            compatibility_choice(IDCANCEL, false),
            crate::CompatibilityChoice::OpenStockCodex
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
