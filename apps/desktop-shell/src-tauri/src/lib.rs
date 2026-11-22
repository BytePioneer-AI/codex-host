mod launcher;
mod navigation;
mod readiness;
mod tray;

use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use url::Url;

use launcher::{Launcher, Options, Surface};
use navigation::{LOADING, Navigation, ONBOARDING, classify, embedded, open_browser};
use readiness::{ShellReady, WebEvent};

const MAIN: &str = "main";

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    Starting,
    Reconnecting,
    Error,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageState {
    codex_desktop_installed: bool,
    locale: String,
    status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

enum Page {
    Onboarding,
    Dormant,
    Loading(Status, Option<String>),
    Web,
}

struct View {
    page: Page,
    last_login: Option<Url>,
    pending_route: Option<&'static str>,
}

struct Shell {
    launcher: Arc<Launcher>,
    view: Mutex<View>,
    ensure_web: Sender<()>,
    locale: String,
}

fn navigation_for(app: &AppHandle, url: &Url) -> Navigation {
    let shell = app.state::<Shell>();
    let view = shell.view.lock().unwrap();
    match classify(url, view.last_login.as_ref()) {
        // A queued redirect from the previous service must not open a browser
        // while the window is switching back to the embedded loading page.
        Navigation::Web if !matches!(view.page, Page::Web) => Navigation::Block,
        decision => decision,
    }
}

fn navigate(app: &AppHandle, url: Url) {
    if let Some(window) = app.get_webview_window(MAIN) {
        if window.navigate(url).is_err() {
            eprintln!("CodexHost: could not navigate the desktop window");
        }
    }
}

fn navigate_loading(app: &AppHandle, status: Status) {
    let mut url = embedded(LOADING);
    url.set_query(Some(match status {
        Status::Starting => "status=starting",
        Status::Reconnecting => "status=reconnecting",
        Status::Error => "status=error",
    }));
    // Reload the bundled page on state changes, so getState works without polling.
    navigate(app, url);
}

fn begin_web(app: &AppHandle, replace_page: bool) {
    let shell = app.state::<Shell>();
    if shell.launcher.is_stopping() {
        return;
    }
    shell.view.lock().unwrap().page = Page::Loading(Status::Starting, None);
    if replace_page {
        navigate_loading(app, Status::Starting);
    }
    if shell.ensure_web.send(()).is_err() {
        web_event(
            app,
            WebEvent::Error("The desktop Web service watcher stopped.".into()),
        );
    }
}

fn web_event(app: &AppHandle, event: WebEvent) {
    let shell = app.state::<Shell>();
    if shell.launcher.is_stopping() {
        return;
    }
    let mut view = shell.view.lock().unwrap();
    let status = match event {
        WebEvent::Connected(ready) => {
            view.page = Page::Web;
            view.last_login = Some(ready.login_url.clone());
            let mut url = ready.login_url;
            url.set_fragment(view.pending_route.take());
            drop(view);
            navigate(app, url);
            return;
        }
        WebEvent::Reconnecting => {
            view.page = Page::Loading(Status::Reconnecting, None);
            Status::Reconnecting
        }
        WebEvent::Error(message) => {
            view.page = Page::Loading(Status::Error, Some(message));
            Status::Error
        }
    };
    drop(view);
    navigate_loading(app, status);
}

fn set_visible(app: &AppHandle, visible: bool) {
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    if visible {
        #[cfg(target_os = "macos")]
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    } else {
        let _ = window.hide();
        #[cfg(target_os = "macos")]
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
}

pub(crate) fn show_main(app: &AppHandle, route: Option<&'static str>) {
    let shell = app.state::<Shell>();
    if shell.launcher.is_stopping() {
        return;
    }
    let mut view = shell.view.lock().unwrap();
    let begin = matches!(view.page, Page::Dormant)
        || (matches!(view.page, Page::Onboarding) && route.is_some());
    let mut target = None;
    if let Some(route) = route {
        if matches!(view.page, Page::Web) {
            target = view.last_login.clone().map(|mut url| {
                // The login redirect forces a fresh document load. The Web UI
                // reads the section hash on mount, not on hashchange.
                url.set_fragment(Some(route));
                url
            });
        } else {
            view.pending_route = Some(route);
        }
    }
    drop(view);
    if begin {
        begin_web(app, true);
    } else if let Some(url) = target {
        navigate(app, url);
    }
    set_visible(app, true);
}

async fn launcher_action<T: Send + 'static>(
    launcher: Arc<Launcher>,
    action: impl FnOnce(&Launcher) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || action(&launcher))
        .await
        .map_err(|error| format!("CodexHost launcher task failed: {error}"))?
}

#[tauri::command]
async fn get_state(shell: State<'_, Shell>) -> Result<PageState, String> {
    let onboarding = matches!(shell.view.lock().unwrap().page, Page::Onboarding);
    let codex_desktop_installed = if onboarding {
        launcher_action(shell.launcher.clone(), Launcher::codex_installed)
            .await
            .unwrap_or(false)
    } else {
        false
    };
    let (status, message) = match &shell.view.lock().unwrap().page {
        Page::Loading(status, message) => (*status, message.clone()),
        _ => (Status::Starting, None),
    };
    Ok(PageState {
        codex_desktop_installed,
        locale: shell.locale.clone(),
        status,
        message,
    })
}

#[tauri::command]
async fn open_console(shell: State<'_, Shell>) -> Result<(), String> {
    launcher_action(shell.launcher.clone(), |launcher| {
        launcher.run(&["console"])
    })
    .await
}

#[tauri::command]
fn retry(app: AppHandle, shell: State<'_, Shell>) {
    if matches!(
        shell.view.lock().unwrap().page,
        Page::Loading(Status::Error, _)
    ) {
        begin_web(&app, true);
    }
}

#[tauri::command]
async fn choose_surface(
    app: AppHandle,
    shell: State<'_, Shell>,
    surface: Surface,
) -> Result<(), String> {
    if !matches!(shell.view.lock().unwrap().page, Page::Onboarding) {
        return Err("Launch surface can only be chosen on the onboarding page".into());
    }
    launcher_action(shell.launcher.clone(), move |launcher| {
        if matches!(surface, Surface::CodexDesktop) && !launcher.codex_installed()? {
            return Err("Codex Desktop is not installed / 未安装官方 Codex Desktop".into());
        }
        launcher.set_surface(surface)?;
        if matches!(surface, Surface::CodexDesktop) {
            launcher.launch_codex_desktop()?;
        }
        Ok(())
    })
    .await?;
    let on_main = app.clone();
    app.run_on_main_thread(move || {
        let shell = on_main.state::<Shell>();
        if shell.launcher.is_stopping()
            || !matches!(shell.view.lock().unwrap().page, Page::Onboarding)
        {
            return;
        }
        match surface {
            Surface::NativeShell => begin_web(&on_main, true),
            Surface::CodexDesktop => {
                shell.view.lock().unwrap().page = Page::Dormant;
                set_visible(&on_main, false);
            }
        }
    })
    .map_err(|error| error.to_string())
}

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let options = Options::from_env()?;
    let launcher = Arc::new(Launcher::new(&std::env::current_exe()?, options.data_dir));
    let locale = sys_locale::get_locale().unwrap_or_else(|| "en".into());
    let (ensure_web, requests) = mpsc::channel();
    let onboarding = options.onboarding;
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || show_main(&handle, None));
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(Shell {
            launcher: launcher.clone(),
            view: Mutex::new(View {
                page: if onboarding {
                    Page::Onboarding
                } else {
                    Page::Loading(Status::Starting, None)
                },
                last_login: None,
                pending_route: None,
            }),
            ensure_web,
            locale: locale.clone(),
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            open_console,
            retry,
            choose_surface
        ])
        .on_window_event(|window, event| {
            if window.label() == MAIN {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    set_visible(window.app_handle(), false);
                }
            }
        })
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let app_handle = app.handle().clone();
            let popup_app = app_handle.clone();
            let navigation_app = app_handle.clone();
            let path = if onboarding { ONBOARDING } else { LOADING };
            WebviewWindowBuilder::new(
                app,
                MAIN,
                WebviewUrl::App(path.trim_start_matches('/').into()),
            )
            .title("CodexHost")
            .inner_size(1140.0, 800.0)
            .min_inner_size(400.0, 320.0)
            .visible(false)
            .initialization_script(navigation::initialization_script())
            .on_navigation(move |url| match navigation_for(&navigation_app, url) {
                Navigation::Embedded | Navigation::Web => true,
                Navigation::Browser => {
                    open_browser(url);
                    false
                }
                Navigation::Block => false,
            })
            .on_new_window(move |url, _features| {
                match navigation_for(&popup_app, &url) {
                    Navigation::Browser => open_browser(&url),
                    Navigation::Web => {
                        let app = popup_app.clone();
                        let _ = popup_app.run_on_main_thread(move || {
                            if navigation_for(&app, &url) == Navigation::Web {
                                navigate(&app, url);
                            }
                        });
                    }
                    Navigation::Embedded | Navigation::Block => (),
                }
                NewWindowResponse::Deny
            })
            .build()?;
            tray::install(&app_handle, &locale)?;
            let ready = ShellReady::publish(&launcher.data_dir)?;
            app.manage(ready);
            let worker_app = app_handle.clone();
            std::thread::Builder::new()
                .name("web-service-watch".into())
                .spawn(move || {
                    readiness::watch(&launcher, requests, |event| {
                        let app = worker_app.clone();
                        let _ = worker_app.run_on_main_thread(move || web_event(&app, event));
                    });
                })?;
            show_main(&app_handle, None);
            if !onboarding {
                begin_web(&app_handle, false);
            }
            Ok(())
        })
        .build(tauri::generate_context!())?;
    app.run(|app, event| match event {
        RunEvent::Exit => {
            if let Some(ready) = app.try_state::<ShellReady>() {
                ready.remove_if_owned();
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(app, None),
        _ => (),
    });
    Ok(())
}
