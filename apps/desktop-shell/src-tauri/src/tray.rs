use std::borrow::Cow;
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::launcher::{LaunchPreferences, Launcher, Surface};
use crate::readiness::{self, ShellReady};
use crate::{Shell, launcher_action, show_main, show_onboarding};

const TRAY_ID: &str = "codexhost";
static SYNC_GENERATION: AtomicU64 = AtomicU64::new(0);

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

pub(crate) fn sync(app: &AppHandle) {
    let launcher = app.state::<Shell>().launcher.clone();
    if launcher.is_stopping() {
        return;
    }
    let generation = SYNC_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = launcher_action(launcher, Launcher::launch_preferences).await;
        let on_main = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            let shell = on_main.state::<Shell>();
            if shell.launcher.is_stopping() || generation != SYNC_GENERATION.load(Ordering::Relaxed)
            {
                return;
            }
            let Some(tray) = on_main.tray_by_id(TRAY_ID) else {
                return;
            };
            let result = result.and_then(|prefs| {
                let menu = build_menu(&on_main, &shell.locale, Some(prefs))
                    .map_err(|error| error.to_string())?;
                tray.set_menu(Some(menu)).map_err(|error| error.to_string())
            });
            if let Err(error) = result {
                eprintln!("CodexHost: could not sync tray launch preferences: {error}");
            }
        }) {
            eprintln!("CodexHost: could not schedule tray launch preferences update: {error}");
        }
    });
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
                show_main(tray.app_handle(), None);
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
