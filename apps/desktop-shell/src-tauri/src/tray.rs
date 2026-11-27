use std::borrow::Cow;
use std::sync::{Mutex, mpsc};
use std::time::Duration;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::launcher::{LaunchPreferences, Launcher, Surface};
use crate::readiness::{self, ShellReady};
use crate::{Shell, launcher_action, reopen_window, show_main, show_onboarding};

const TRAY_ID: &str = "codexhost";
const SYNC_RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(250), Duration::from_millis(1000)];

struct SyncCoordinator {
    generation: u64,
    in_flight: Option<u64>,
    synced: bool,
}

impl SyncCoordinator {
    const fn new() -> Self {
        Self {
            generation: 0,
            in_flight: None,
            synced: false,
        }
    }

    fn begin(&mut self, force: bool) -> Option<u64> {
        if !force && (self.synced || self.in_flight.is_some()) {
            return None;
        }
        self.generation += 1;
        let generation = self.generation;
        self.in_flight = Some(generation);
        self.synced = false;
        Some(generation)
    }

    fn is_current(&self, generation: u64) -> bool {
        self.in_flight == Some(generation)
    }

    fn finish(&mut self, generation: u64, synced: bool) -> bool {
        if !self.is_current(generation) {
            return false;
        }
        self.in_flight = None;
        self.synced = synced;
        true
    }
}

static SYNC_COORDINATOR: Mutex<SyncCoordinator> = Mutex::new(SyncCoordinator::new());

fn run_action(
    app: &AppHandle,
    action: impl FnOnce(&Launcher) -> Result<(), String> + Send + 'static,
) {
    let launcher = app.state::<Shell>().launcher.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(message) = launcher_action(launcher.clone(), action).await
            && !launcher.is_stopping()
        {
            app.dialog()
                .message(message)
                .title("CodexHost")
                .kind(MessageDialogKind::Error)
                .show(|_| {});
        }
    });
}

fn finish_sync(generation: u64, synced: bool) {
    SYNC_COORDINATOR.lock().unwrap().finish(generation, synced);
}

fn apply_sync_result(
    app: &AppHandle,
    generation: u64,
    result: Result<LaunchPreferences, String>,
) -> Result<bool, String> {
    let shell = app.state::<Shell>();
    if shell.launcher.is_stopping() || !SYNC_COORDINATOR.lock().unwrap().is_current(generation) {
        return Ok(false);
    }
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or("CodexHost tray is unavailable")?;
    let menu = build_menu(app, &shell.locale, Some(result?)).map_err(|error| error.to_string())?;
    tray.set_menu(Some(menu))
        .map_err(|error| error.to_string())?;
    Ok(true)
}

fn start_sync(app: &AppHandle, force: bool) {
    let launcher = app.state::<Shell>().launcher.clone();
    if launcher.is_stopping() {
        return;
    }
    let Some(generation) = SYNC_COORDINATOR.lock().unwrap().begin(force) else {
        return;
    };
    let app = app.clone();
    std::thread::spawn(move || {
        for attempt in 0..=SYNC_RETRY_DELAYS.len() {
            if attempt > 0 {
                std::thread::sleep(SYNC_RETRY_DELAYS[attempt - 1]);
            }
            if launcher.is_stopping() || !SYNC_COORDINATOR.lock().unwrap().is_current(generation) {
                return;
            }
            let result = launcher.launch_preferences();
            let on_main = app.clone();
            let (send, receive) = mpsc::channel();
            if let Err(error) = app.run_on_main_thread(move || {
                let _ = send.send(apply_sync_result(&on_main, generation, result));
            }) {
                eprintln!("CodexHost: could not schedule tray launch preferences update: {error}");
                finish_sync(generation, false);
                return;
            }
            let result = receive
                .recv()
                .map_err(|error| format!("Tray update did not return a result: {error}"));
            match result {
                Ok(Ok(true)) => {
                    finish_sync(generation, true);
                    return;
                }
                Ok(Ok(false)) => return,
                Ok(Err(error)) | Err(error) if attempt == SYNC_RETRY_DELAYS.len() => {
                    eprintln!("CodexHost: could not sync tray launch preferences: {error}");
                    finish_sync(generation, false);
                    return;
                }
                Ok(Err(_)) | Err(_) => (),
            }
        }
    });
}

pub(crate) fn sync(app: &AppHandle) {
    start_sync(app, true);
}

pub(crate) fn ensure_synced(app: &AppHandle) {
    start_sync(app, false);
}

fn set_default(app: &AppHandle, surface: Option<Surface>) {
    let on_saved = app.clone();
    run_action(app, move |launcher| {
        match surface {
            Some(surface) => launcher.set_surface(surface, true)?,
            None => launcher.ask_every_time()?,
        }
        sync(&on_saved);
        Ok(())
    });
}

fn update(app: &AppHandle) {
    let shell = app.state::<Shell>();
    if shell.launcher.is_stopping() {
        return;
    }
    let prompt = if shell.locale.starts_with("zh") {
        "检查并安装可用的 CodexHost 更新？"
    } else {
        "Check for and install available CodexHost updates?"
    };
    let launcher = shell.launcher.clone();
    let app = app.clone();
    app.dialog()
        .message(prompt)
        .title("CodexHost")
        .buttons(MessageDialogButtons::OkCancel)
        .show(move |confirmed| {
            if confirmed {
                tauri::async_runtime::spawn(async move {
                    let (message, kind) = match launcher_action(launcher, Launcher::update).await {
                        Ok(message) if message.is_empty() => return,
                        Ok(message) => (message, MessageDialogKind::Info),
                        Err(message) => (message, MessageDialogKind::Error),
                    };
                    app.dialog()
                        .message(message)
                        .title("CodexHost")
                        .kind(kind)
                        .show(|_| {});
                });
            }
        });
}

fn quit(app: &AppHandle) {
    let launcher = app.state::<Shell>().launcher.clone();
    if !launcher.begin_stop() {
        return;
    }
    // `stop` can terminate a registered shell. Unpublish before invoking it
    // so it can shut the other processes down and return its result here.
    app.state::<ShellReady>().remove_if_owned();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match launcher_action(launcher, |launcher| launcher.run(&["stop"])).await {
            Ok(()) => app.exit(0),
            Err(message) => {
                let exit = app.clone();
                app.dialog()
                    .message(message)
                    .title("CodexHost")
                    .kind(MessageDialogKind::Error)
                    .show(move |_| exit.exit(1));
            }
        }
    });
}

fn build_menu(
    app: &AppHandle,
    locale: &str,
    prefs: Option<LaunchPreferences>,
) -> tauri::Result<Menu<tauri::Wry>> {
    let label = |zh, en| if locale.starts_with("zh") { zh } else { en };
    let item = |id, text| MenuItem::with_id(app, id, text, true, None::<&str>);
    let show = item(
        "show",
        label("打开 CodexHost 窗口", "Open CodexHost Window"),
    )?;
    let official = item(
        "official",
        label("打开官方 Codex Desktop", "Open Official Codex Desktop"),
    )?;
    let web = item("web", label("打开 Web 端", "Open Web"))?;
    let onboarding = item("onboarding", label("打开启动引导页", "Open Launch Chooser"))?;
    let connect = item("connect", label("手机与远程连接", "Phone & Remote Access"))?;
    let remembered = prefs
        .as_ref()
        .and_then(LaunchPreferences::remembered_surface);
    let preference_item = |id, text: &str, checked, enabled| {
        let text = if checked {
            Cow::Owned(format!("✓ {text}"))
        } else {
            Cow::Borrowed(text)
        };
        MenuItem::with_id(app, id, text, enabled, None::<&str>)
    };
    let native_default = preference_item(
        "native-default",
        label("CodexHost 窗口", "CodexHost Window"),
        remembered == Some(Surface::NativeShell),
        prefs.is_some(),
    )?;
    let official_default = preference_item(
        "official-default",
        label("官方 Codex Desktop", "Official Codex Desktop"),
        remembered == Some(Surface::CodexDesktop),
        prefs
            .as_ref()
            .is_some_and(|prefs| prefs.codex_desktop_installed),
    )?;
    let ask_every_time = preference_item(
        "ask-every-time",
        label("每次询问", "Ask Every Time"),
        prefs.is_some() && remembered.is_none(),
        prefs.is_some(),
    )?;
    let preferences = Submenu::with_items(
        app,
        label("默认启动方式", "Default Launch Surface"),
        true,
        &[&native_default, &official_default, &ask_every_time],
    )?;
    let console = item("console", label("诊断与日志", "Diagnostics & Logs"))?;
    let update_item = item("update", label("检查更新", "Check for Updates"))?;
    let quit_item = item(
        "quit",
        label("完全退出 CodexHost", "Quit CodexHost & Stop Services"),
    )?;
    let first_separator = PredefinedMenuItem::separator(app)?;
    let second_separator = PredefinedMenuItem::separator(app)?;
    Menu::with_items(
        app,
        &[
            &show,
            &official,
            &web,
            &first_separator,
            &onboarding,
            &connect,
            &preferences,
            &second_separator,
            &console,
            &update_item,
            &quit_item,
        ],
    )
}

pub(crate) fn install(app: &AppHandle, locale: &str) -> tauri::Result<()> {
    let menu = build_menu(app, locale, None)?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .tooltip("CodexHost")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reopen_window(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app, None),
            "official" => run_action(app, Launcher::open_codex),
            "web" => run_action(app, |launcher| {
                let ready = readiness::ensure_web_ready(launcher)?;
                codexhost_platform::open_external_url(ready.login_url.as_str())
                    .map_err(|error| format!("Could not open the system browser: {error}"))
            }),
            "onboarding" => show_onboarding(app),
            "connect" => show_main(app, Some("/#connect-devices")),
            "native-default" => set_default(app, Some(Surface::NativeShell)),
            "official-default" => set_default(app, Some(Surface::CodexDesktop)),
            "ask-every-time" => set_default(app, None),
            "console" => run_action(app, |launcher| launcher.run(&["console"])),
            "update" => update(app),
            "quit" => quit(app),
            _ => (),
        })
        .build(app)?;
    sync(app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{SYNC_RETRY_DELAYS, SyncCoordinator};

    #[test]
    fn coordinates_bounded_single_flight_sync_and_forced_refreshes() {
        assert_eq!(
            SYNC_RETRY_DELAYS.map(|delay| delay.as_millis()),
            [250, 1000]
        );
        let mut coordinator = SyncCoordinator::new();
        let first = coordinator.begin(false).unwrap();
        assert_eq!(coordinator.begin(false), None);
        assert!(!coordinator.finish(first + 1, true));
        assert!(coordinator.finish(first, false));
        let second = coordinator.begin(false).unwrap();
        assert_ne!(first, second);
        assert!(coordinator.finish(second, true));
        assert_eq!(coordinator.begin(false), None);

        let forced = coordinator.begin(true).unwrap();
        assert_eq!(coordinator.begin(false), None);
        let superseding = coordinator.begin(true).unwrap();
        assert!(!coordinator.finish(forced, true));
        assert_eq!(coordinator.begin(false), None);
        assert!(coordinator.finish(superseding, true));
        assert_eq!(coordinator.begin(false), None);
    }
}
