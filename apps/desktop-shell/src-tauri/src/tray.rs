#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::launcher::{Launcher, Surface};
use crate::readiness::ShellReady;
use crate::{Shell, launcher_action, show_main};

#[cfg(target_os = "windows")]
static SYNC_GENERATION: AtomicU64 = AtomicU64::new(0);

fn run_action(
    app: &AppHandle,
    action: impl FnOnce(&Launcher) -> Result<(), String> + Send + 'static,
) {
    let launcher = app.state::<Shell>().launcher.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(message) = launcher_action(launcher.clone(), action).await {
            if !launcher.is_stopping() {
                app.dialog()
                    .message(message)
                    .title("CodexHost")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
        }
    });
}

#[cfg(target_os = "windows")]
pub(crate) fn sync(app: &AppHandle) {
    let generation = SYNC_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let launcher = app.state::<Shell>().launcher.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = launcher_action(launcher, Launcher::default_menu_state).await;
        let app_for_main = app.clone();
        let _ = app.run_on_main_thread(move || {
            if generation != SYNC_GENERATION.load(Ordering::Relaxed) {
                return;
            }
            let Some(tray) = app_for_main.tray_by_id("codexhost") else {
                return;
            };
            let locale = app_for_main.state::<Shell>().locale.clone();
            let result = state.and_then(|state| {
                let menu = build_menu(&app_for_main, &locale, Some(state))
                    .map_err(|error| error.to_string())?;
                tray.set_menu(Some(menu)).map_err(|error| error.to_string())
            });
            if let Err(error) = result {
                let message = if locale.starts_with("zh") {
                    format!("无法同步默认启动方式：{error}")
                } else {
                    format!("Could not synchronize the default launch surface: {error}")
                };
                app_for_main
                    .dialog()
                    .message(message)
                    .title("CodexHost")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
        });
    });
}

#[cfg(target_os = "windows")]
fn set_default(app: &AppHandle, surface: Surface) {
    let launcher = app.state::<Shell>().launcher.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = launcher_action(launcher, move |launcher| {
            launcher.toggle_default(surface)
        })
        .await;
        sync(&app);
        if let Err(message) = result {
            app.dialog()
                .message(message)
                .title("CodexHost")
                .kind(MessageDialogKind::Error)
                .show(|_| {});
        }
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
    #[cfg(target_os = "windows")] state: Option<(Option<Surface>, bool)>,
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
    let connect = item("connect", label("手机与远程连接", "Phone & Remote Access"))?;
    #[cfg(target_os = "windows")]
    let (default_surface, codex_installed) = state.unwrap_or((None, true));
    #[cfg(target_os = "windows")]
    let loading = state.is_none();
    #[cfg(target_os = "windows")]
    let native_default = MenuItem::with_id(
        app,
        "native-default",
        if matches!(default_surface, Some(Surface::NativeShell | Surface::Both)) {
            label("✓ 自有桌面窗口", "✓ CodexHost Window")
        } else {
            label("自有桌面窗口", "CodexHost Window")
        },
        !loading,
        None::<&str>,
    )?;
    #[cfg(not(target_os = "windows"))]
    let native_default = item("native-default", label("自有桌面窗口", "CodexHost Window"))?;
    #[cfg(target_os = "windows")]
    let official_default = MenuItem::with_id(
        app,
        "official-default",
        if matches!(default_surface, Some(Surface::CodexDesktop | Surface::Both)) {
            label("✓ 官方 Codex Desktop", "✓ Official Codex Desktop")
        } else {
            label("官方 Codex Desktop", "Official Codex Desktop")
        },
        !loading && codex_installed,
        None::<&str>,
    )?;
    #[cfg(not(target_os = "windows"))]
    let official_default = item(
        "official-default",
        label("官方 Codex Desktop", "Official Codex Desktop"),
    )?;
    let preferences = Submenu::with_items(
        app,
        label("默认启动方式", "Default Launch Surface"),
        true,
        &[&native_default, &official_default],
    )?;
    let console = item("console", label("诊断与日志", "Diagnostics & Logs"))?;
    let update_item = item("update", label("检查更新", "Check for Updates"))?;
    let quit_item = item(
        "quit",
        label("完全退出 CodexHost", "Quit CodexHost & Stop Services"),
    )?;
    let first_separator = PredefinedMenuItem::separator(app)?;
    let second_separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &official,
            &first_separator,
            &connect,
            &preferences,
            &second_separator,
            &console,
            &update_item,
            &quit_item,
        ],
    )?;
    Ok(menu)
}

pub(crate) fn install(app: &AppHandle, locale: &str) -> tauri::Result<()> {
    #[cfg(target_os = "windows")]
    let menu = build_menu(app, locale, None)?;
    #[cfg(not(target_os = "windows"))]
    let menu = build_menu(app, locale)?;
    TrayIconBuilder::with_id("codexhost")
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
                show_main(tray.app_handle(), None);
            }
        })
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => show_main(app, None),
            "official" => run_action(app, Launcher::open_codex),
            "connect" => show_main(app, Some("connect-devices")),
            #[cfg(target_os = "windows")]
            "native-default" => set_default(app, Surface::NativeShell),
            #[cfg(not(target_os = "windows"))]
            "native-default" => {
                run_action(app, |launcher| launcher.set_surface(Surface::NativeShell))
            }
            #[cfg(target_os = "windows")]
            "official-default" => set_default(app, Surface::CodexDesktop),
            #[cfg(not(target_os = "windows"))]
            "official-default" => {
                run_action(app, |launcher| launcher.set_surface(Surface::CodexDesktop))
            }
            "console" => run_action(app, |launcher| launcher.run(&["console"])),
            "update" => update(app),
            "quit" => quit(app),
            _ => (),
        })
        .build(app)?;
    #[cfg(target_os = "windows")]
    sync(app);
    Ok(())
}
