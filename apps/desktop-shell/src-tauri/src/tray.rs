use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::launcher::{Launcher, Surface};
use crate::readiness::ShellReady;
use crate::{Shell, launcher_action, show_main};

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

pub(crate) fn install(app: &AppHandle, locale: &str) -> tauri::Result<()> {
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
    let native_default = item("native-default", label("自有桌面窗口", "CodexHost Window"))?;
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
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app, None),
            "official" => run_action(app, Launcher::open_codex),
            "connect" => show_main(app, Some("connect-devices")),
            "native-default" => {
                run_action(app, |launcher| launcher.set_surface(Surface::NativeShell))
            }
            "official-default" => {
                run_action(app, |launcher| launcher.set_surface(Surface::CodexDesktop))
            }
            "console" => run_action(app, |launcher| launcher.run(&["console"])),
            "update" => update(app),
            "quit" => quit(app),
            _ => (),
        })
        .build(app)?;
    Ok(())
}
