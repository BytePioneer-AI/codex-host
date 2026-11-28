use std::collections::VecDeque;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::{NotificationExt, PermissionState};

pub(crate) const NOTIFICATIONS_FILE: &str = "desktop-shell-notifications-v1.json";
#[cfg(target_os = "windows")]
pub(crate) const APP_USER_MODEL_ID: &str = "com.codexhost.shell";

const MAX_TITLE_CHARS: usize = 200;
const MAX_BODY_CHARS: usize = 500;
const MAX_TAG_CHARS: usize = 512;
const MAX_SESSION_ID_CHARS: usize = 512;
const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(5);
const RATE_LIMIT_MAX_SENDS: usize = 10;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum NotificationPermission {
    Granted,
    Denied,
    Prompt,
    #[allow(dead_code)]
    Unsupported,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotificationStatePayload {
    pub enabled: bool,
    pub permission: NotificationPermission,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotificationSendPayload {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub kind: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotificationClickPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct NotificationRecord {
    enabled: bool,
}

#[cfg(target_os = "macos")]
mod macos_app_nap {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_foundation::{NSActivityOptions, NSObjectProtocol, NSProcessInfo, NSString};

    pub(super) struct AppNapGuard(Retained<ProtocolObject<dyn NSObjectProtocol>>);

    // SAFETY: Apple's NSProcessInfo activity tokens are opaque thread-safe objects
    // whose only operation after creation is passing them back to `endActivity:`.
    unsafe impl Send for AppNapGuard {}

    impl AppNapGuard {
        pub(super) fn acquire() -> Self {
            let reason =
                NSString::from_str("Deliver CodexHost desktop notifications while in background");
            let token = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
                NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
                &reason,
            );
            Self(token)
        }
    }

    impl Drop for AppNapGuard {
        fn drop(&mut self) {
            unsafe {
                NSProcessInfo::processInfo().endActivity(&self.0);
            }
        }
    }
}

pub(crate) struct NotificationController {
    enabled: bool,
    recent_sends: VecDeque<Instant>,
    #[cfg(target_os = "macos")]
    app_nap: Option<macos_app_nap::AppNapGuard>,
}

impl NotificationController {
    pub(crate) fn load(data_dir: &Path) -> Self {
        let path = data_dir.join(NOTIFICATIONS_FILE);
        let enabled = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<NotificationRecord>(&bytes).ok())
            .is_some_and(|record| record.enabled);
        Self {
            enabled,
            recent_sends: VecDeque::new(),
            #[cfg(target_os = "macos")]
            app_nap: None,
        }
    }

    pub(crate) fn enabled(&self) -> bool {
        self.enabled
    }

    pub(crate) fn set_enabled(
        &mut self,
        enabled: bool,
        permission: NotificationPermission,
    ) -> bool {
        let changed = self.enabled != enabled;
        self.enabled = enabled;
        self.sync_background_activity(permission);
        changed
    }

    pub(crate) fn sync_background_activity(&mut self, permission: NotificationPermission) {
        #[cfg(target_os = "macos")]
        {
            let should_hold = self.enabled && permission == NotificationPermission::Granted;
            if should_hold {
                if self.app_nap.is_none() {
                    self.app_nap = Some(macos_app_nap::AppNapGuard::acquire());
                }
            } else {
                self.app_nap = None;
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = permission;
    }

    pub(crate) fn release_background_activity(&mut self) {
        #[cfg(target_os = "macos")]
        {
            self.app_nap = None;
        }
    }

    pub(crate) fn try_acquire_send_slot(&mut self, now: Instant) -> bool {
        if !self.enabled {
            return false;
        }
        while let Some(&oldest) = self.recent_sends.front() {
            if now.saturating_duration_since(oldest) >= RATE_LIMIT_WINDOW {
                self.recent_sends.pop_front();
            } else {
                break;
            }
        }
        if self.recent_sends.len() >= RATE_LIMIT_MAX_SENDS {
            return false;
        }
        self.recent_sends.push_back(now);
        true
    }
}

pub(crate) fn persist(data_dir: &Path, enabled: bool) -> Result<PathBuf, std::io::Error> {
    fs::create_dir_all(data_dir)?;
    let path = data_dir.join(NOTIFICATIONS_FILE);
    // NamedTempFile creates the temporary file with 0o600 permissions on Unix.
    let mut file = tempfile::NamedTempFile::new_in(data_dir)?;
    serde_json::to_writer(&mut file, &NotificationRecord { enabled })?;
    writeln!(file)?;
    file.as_file().sync_all()?;
    file.persist(&path).map_err(|error| error.error)?;
    Ok(path)
}

pub(crate) fn truncate_chars(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max_chars {
        trimmed.to_owned()
    } else {
        trimmed.chars().take(max_chars).collect()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SanitizedNotification {
    pub title: String,
    pub body: String,
    pub tag: Option<String>,
    pub session_id: Option<String>,
}

pub(crate) fn sanitize_payload(payload: &NotificationSendPayload) -> Option<SanitizedNotification> {
    let title = truncate_chars(&payload.title, MAX_TITLE_CHARS);
    let body = truncate_chars(&payload.body, MAX_BODY_CHARS);
    if title.is_empty() && body.is_empty() {
        return None;
    }
    let tag = payload
        .tag
        .as_deref()
        .map(|value| truncate_chars(value, MAX_TAG_CHARS))
        .filter(|value| !value.is_empty());
    let session_id = payload
        .session_id
        .as_deref()
        .map(|value| truncate_chars(value, MAX_SESSION_ID_CHARS))
        .filter(|value| !value.is_empty());
    Some(SanitizedNotification {
        title,
        body,
        tag,
        session_id,
    })
}

pub(crate) fn map_permission_state(state: PermissionState) -> NotificationPermission {
    match state {
        PermissionState::Granted => NotificationPermission::Granted,
        PermissionState::Denied => NotificationPermission::Denied,
        PermissionState::Prompt | PermissionState::PromptWithRationale => {
            NotificationPermission::Prompt
        }
    }
}

pub(crate) fn permission_state(app: &AppHandle) -> NotificationPermission {
    app.notification()
        .permission_state()
        .map(map_permission_state)
        .unwrap_or(NotificationPermission::Unsupported)
}

pub(crate) fn request_permission(app: &AppHandle) -> Result<NotificationPermission, String> {
    app.notification()
        .request_permission()
        .map(map_permission_state)
        .map_err(|error| error.to_string())
}

pub(crate) fn show_native(
    app: &AppHandle,
    sanitized: &SanitizedNotification,
) -> Result<(), String> {
    let mut builder = app.notification().builder();
    if !sanitized.title.is_empty() {
        builder = builder.title(sanitized.title.clone());
    }
    if !sanitized.body.is_empty() {
        builder = builder.body(sanitized.body.clone());
    }
    if let Some(tag) = &sanitized.tag {
        builder = builder.group(tag.clone());
    }
    if let Some(session_id) = &sanitized.session_id {
        builder = builder.extra("sessionId", session_id.clone());
    }
    builder.show().map_err(|error| error.to_string())
}

pub(crate) fn click_dispatch_script(payload: &NotificationClickPayload) -> String {
    let json = serde_json::to_string(payload)
        .unwrap_or_else(|_| "{}".to_owned())
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    format!("window.__codexhostDispatchNotificationClick?.({json});")
}

pub(crate) fn install_action_handler(app: &AppHandle) {
    let click_app = app.clone();
    if let Err(error) = app.notification().on_action(move |performed| {
        let session_id = performed
            .notification()
            .and_then(|notification| notification.extra().get("sessionId"))
            .and_then(|value| value.as_str())
            .map(|value| truncate_chars(value, MAX_SESSION_ID_CHARS))
            .filter(|value| !value.is_empty());
        let handle = click_app.clone();
        let payload = NotificationClickPayload { session_id };
        let _ = click_app.run_on_main_thread(move || {
            crate::set_visible(&handle, true);
            if let Some(window) = handle.get_webview_window(crate::MAIN) {
                let _ = window.eval(click_dispatch_script(&payload));
            }
        });
    }) {
        eprintln!("CodexHost: could not register desktop notification click handler: {error}");
    }
}

pub(crate) fn system_settings_url() -> Option<&'static str> {
    #[cfg(target_os = "macos")]
    {
        Some("x-apple.systempreferences:com.apple.Notifications-Settings.extension")
    }
    #[cfg(target_os = "windows")]
    {
        Some("ms-settings:notifications")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn ensure_windows_aumid() {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let subkey = format!("Software\\Classes\\AppUserModelId\\{APP_USER_MODEL_ID}");
    if let Ok((key, _)) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(&subkey) {
        let _ = key.set_value("DisplayName", &"CodexHost");
        if let Some(icon_path) = resolve_windows_icon_path() {
            let _ = key.set_value("IconUri", &icon_path);
        }
    }

    let wide: Vec<u16> = APP_USER_MODEL_ID
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let _ =
            windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(wide.as_ptr());
    }
}

#[cfg(target_os = "windows")]
fn resolve_windows_icon_path() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    for candidate in [
        dir.join("icon.ico"),
        dir.join("codexhost.ico"),
        dir.join("icons").join("icon.ico"),
        dir.join("..").join("icons").join("icon.ico"),
    ] {
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn ensure_windows_aumid() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_and_reloads_enabled_state_atomically() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!NotificationController::load(dir.path()).enabled());

        let saved = persist(dir.path(), true).unwrap();
        assert_eq!(saved, dir.path().join(NOTIFICATIONS_FILE));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&saved).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        assert!(NotificationController::load(dir.path()).enabled());

        fs::write(&saved, "{corrupt json").unwrap();
        assert!(!NotificationController::load(dir.path()).enabled());
    }

    #[test]
    fn truncates_utf8_safely_and_rejects_empty_payloads() {
        let long_title = "你".repeat(250);
        let long_body = "a".repeat(600);
        let sanitized = sanitize_payload(&NotificationSendPayload {
            title: format!("  {long_title}  "),
            body: long_body,
            tag: Some("  thread-1  ".into()),
            session_id: Some("  session-1  ".into()),
            kind: Some("turn".into()),
        })
        .expect("non-empty payload");
        assert_eq!(sanitized.title.chars().count(), MAX_TITLE_CHARS);
        assert_eq!(sanitized.body.chars().count(), MAX_BODY_CHARS);
        assert_eq!(sanitized.tag.as_deref(), Some("thread-1"));
        assert_eq!(sanitized.session_id.as_deref(), Some("session-1"));

        assert!(
            sanitize_payload(&NotificationSendPayload {
                title: "   ".into(),
                body: "\n\t".into(),
                tag: None,
                session_id: None,
                kind: None,
            })
            .is_none()
        );
    }

    #[test]
    fn enforces_enabled_gate_and_sliding_window_rate_limit() {
        let dir = tempfile::tempdir().unwrap();
        let mut ctrl = NotificationController::load(dir.path());
        let start = Instant::now();
        assert!(!ctrl.try_acquire_send_slot(start));

        ctrl.set_enabled(true, NotificationPermission::Granted);
        for offset_ms in 0..RATE_LIMIT_MAX_SENDS {
            assert!(ctrl.try_acquire_send_slot(start + Duration::from_millis(offset_ms as u64)));
        }
        assert!(!ctrl.try_acquire_send_slot(start + Duration::from_secs(1)));
        assert!(ctrl.try_acquire_send_slot(start + RATE_LIMIT_WINDOW + Duration::from_millis(1)));
        ctrl.release_background_activity();
    }

    #[test]
    fn formats_click_dispatch_script_safely() {
        assert_eq!(
            click_dispatch_script(&NotificationClickPayload {
                session_id: Some("web-remote:abc\"def".into()),
            }),
            r#"window.__codexhostDispatchNotificationClick?.({"sessionId":"web-remote:abc\"def"});"#
        );
        assert_eq!(
            click_dispatch_script(&NotificationClickPayload { session_id: None }),
            r#"window.__codexhostDispatchNotificationClick?.({});"#
        );
    }
}
