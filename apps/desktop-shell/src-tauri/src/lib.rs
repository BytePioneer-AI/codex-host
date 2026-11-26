mod instance;
mod launcher;
mod navigation;
mod readiness;
mod tray;
mod zoom;

use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::webview::{NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::{AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use url::Url;

use instance::{Activation, Claim, PrimaryInstance};
use launcher::{Launcher, Options, Surface};
use navigation::{LOADING, Navigation, ONBOARDING, classify, embedded, open_browser};
use readiness::{ShellReady, WebEvent, WebReady};
use zoom::{ZoomController, ZoomState, percent_to_scale};

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
    version: &'static str,
    platform: &'static str,
    status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    web_running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    web_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    web_login_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WebAccessInfo {
    web_url: String,
    web_login_url: String,
}

enum Page {
    Onboarding,
    Dormant,
    Loading(Status, Option<String>),
    Web,
}

impl Page {
    fn accepts_web_events(&self) -> bool {
        matches!(self, Self::Loading(_, _) | Self::Web)
    }
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
    zoom: Arc<Mutex<ZoomController>>,
    zoom_op: tauri::async_runtime::Mutex<()>,
    zoom_persist: Arc<Mutex<Option<u16>>>,
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

fn permission_response(page: &Page, kind: PermissionKind) -> PermissionResponse {
    if matches!(page, Page::Web) && kind == PermissionKind::Microphone {
        PermissionResponse::Allow
    } else {
        PermissionResponse::Default
    }
}

fn navigate(app: &AppHandle, url: Url) {
    if let Some(window) = app.get_webview_window(MAIN)
        && window.navigate(url).is_err()
    {
        eprintln!("CodexHost: could not navigate the desktop window");
    }
}

fn navigate_loading(app: &AppHandle, status: Status) {
    let mut url = embedded(LOADING);
    let status_param = match status {
        Status::Starting => "starting",
        Status::Reconnecting => "reconnecting",
        Status::Error => "error",
    };
    let zoom = app.state::<Shell>().zoom.lock().unwrap().percent();
    url.set_query(Some(&format!("status={status_param}&zoom={zoom}")));
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
    if !view.page.accepts_web_events() {
        return;
    }
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

#[cfg(target_os = "macos")]
fn apply_macos_dock_icon() {
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    const DOCK_ICON_PNG: &[u8] = include_bytes!("../icons/dock.png");
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let data = NSData::with_bytes(DOCK_ICON_PNG);
    if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
        let app = NSApplication::sharedApplication(mtm);
        unsafe {
            app.setApplicationIconImage(Some(&image));
        }
    }
}

fn set_visible(app: &AppHandle, visible: bool) {
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    if visible {
        #[cfg(target_os = "macos")]
        {
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
            apply_macos_dock_icon();
        }
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

pub(crate) fn show_onboarding(app: &AppHandle) {
    let shell = app.state::<Shell>();
    if shell.launcher.is_stopping() {
        return;
    }
    let mut view = shell.view.lock().unwrap();
    view.page = Page::Onboarding;
    view.pending_route = None;
    drop(view);
    let zoom = shell.zoom.lock().unwrap().percent();
    let mut url = embedded(ONBOARDING);
    url.set_query(Some(&format!("zoom={zoom}")));
    navigate(app, url);
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
    let (codex_desktop_installed, web_ready) = if onboarding {
        let installed = launcher_action(shell.launcher.clone(), Launcher::codex_installed)
            .await
            .unwrap_or(false);
        let data_dir = shell.launcher.data_dir.clone();
        let web =
            tauri::async_runtime::spawn_blocking(move || WebReady::read_live_optional(&data_dir))
                .await
                .ok()
                .flatten();
        (installed, web)
    } else {
        (false, None)
    };
    let (status, message) = match &shell.view.lock().unwrap().page {
        Page::Loading(status, message) => (*status, message.clone()),
        _ => (Status::Starting, None),
    };
    Ok(PageState {
        codex_desktop_installed,
        locale: shell.locale.clone(),
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        status,
        message,
        web_running: web_ready.is_some(),
        web_url: web_ready.as_ref().map(WebReady::display_url),
        web_login_url: web_ready.map(|ready| ready.login_url.as_str().to_owned()),
    })
}

#[tauri::command]
async fn ensure_web_access(shell: State<'_, Shell>) -> Result<WebAccessInfo, String> {
    let ready = launcher_action(shell.launcher.clone(), readiness::ensure_web_ready).await?;
    Ok(WebAccessInfo {
        web_url: ready.display_url(),
        web_login_url: ready.login_url.as_str().to_owned(),
    })
}

#[tauri::command]
async fn open_web_browser(shell: State<'_, Shell>) -> Result<WebAccessInfo, String> {
    let ready = launcher_action(shell.launcher.clone(), readiness::ensure_web_ready).await?;
    let info = WebAccessInfo {
        web_url: ready.display_url(),
        web_login_url: ready.login_url.as_str().to_owned(),
    };
    let login = ready.login_url;
    tauri::async_runtime::spawn_blocking(move || {
        codexhost_platform::open_external_url(login.as_str())
            .map_err(|error| format!("Could not open the system browser: {error}"))
    })
    .await
    .map_err(|error| format!("Browser open task failed: {error}"))??;
    Ok(info)
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowChromeState {
    maximized: bool,
    fullscreen: bool,
}

#[tauri::command]
fn window_start_dragging(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_minimize(window: tauri::WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_toggle_maximize(window: tauri::WebviewWindow) -> Result<bool, String> {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|error| error.to_string())?;
        Ok(false)
    } else {
        window.maximize().map_err(|error| error.to_string())?;
        Ok(true)
    }
}

#[tauri::command]
fn window_close(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_chrome_state(window: tauri::WebviewWindow) -> WindowChromeState {
    WindowChromeState {
        maximized: window.is_maximized().unwrap_or(false),
        fullscreen: window.is_fullscreen().unwrap_or(false),
    }
}

#[tauri::command]
fn window_zoom_get(shell: State<'_, Shell>) -> ZoomState {
    shell.zoom.lock().unwrap().state()
}

fn persist_latest_zoom(
    zoom: &Arc<Mutex<ZoomController>>,
    persisted: &Arc<Mutex<Option<u16>>>,
    data_dir: &std::path::Path,
) {
    let mut last_persisted = persisted.lock().unwrap();
    let percent = zoom.lock().unwrap().percent();
    if *last_persisted == Some(percent) {
        return;
    }
    match zoom::persist(data_dir, percent) {
        Ok(_) => *last_persisted = Some(percent),
        Err(error) => eprintln!("CodexHost: could not save desktop shell zoom: {error}"),
    }
}

async fn apply_zoom_update(
    window: tauri::WebviewWindow,
    shell: &Shell,
    resolve: impl FnOnce(&ZoomController) -> Result<u16, String>,
) -> Result<ZoomState, String> {
    let _op = shell.zoom_op.lock().await;
    let next_percent = {
        let controller = shell.zoom.lock().unwrap();
        let next = resolve(&controller)?;
        if next == controller.percent() {
            return Ok(controller.state());
        }
        next
    };
    window
        .set_zoom(percent_to_scale(next_percent))
        .map_err(|error| error.to_string())?;
    let (state, changed) = shell.zoom.lock().unwrap().commit(next_percent);
    if changed {
        let zoom = shell.zoom.clone();
        let persisted = shell.zoom_persist.clone();
        let data_dir = shell.launcher.data_dir.clone();
        drop(tauri::async_runtime::spawn_blocking(move || {
            persist_latest_zoom(&zoom, &persisted, &data_dir);
        }));
    }
    Ok(state)
}

#[tauri::command]
async fn window_zoom_step(
    window: tauri::WebviewWindow,
    shell: State<'_, Shell>,
    delta: i8,
) -> Result<ZoomState, String> {
    apply_zoom_update(window, &shell, |controller| controller.resolve_step(delta)).await
}

#[tauri::command]
async fn window_zoom_set(
    window: tauri::WebviewWindow,
    shell: State<'_, Shell>,
    percent: u16,
) -> Result<ZoomState, String> {
    apply_zoom_update(window, &shell, |controller| controller.resolve_set(percent)).await
}

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let options = Options::from_env()?;
    let activation = if options.onboarding {
        Activation::Onboarding
    } else {
        Activation::Show
    };
    let (instance, activations) = match instance::claim(&options.data_dir, activation)? {
        Claim::Primary {
            instance,
            activations,
        } => (instance, activations),
        Claim::Forwarded => return Ok(()),
    };
    let launcher = Arc::new(Launcher::new(&std::env::current_exe()?, options.data_dir));
    let zoom_controller = ZoomController::load(&launcher.data_dir);
    let initial_zoom_percent = zoom_controller.percent();
    let boot_nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let boot_id = format!("{}-{boot_nanos}", std::process::id());
    let zoom = Arc::new(Mutex::new(zoom_controller));
    let zoom_persist = Arc::new(Mutex::new(Some(initial_zoom_percent)));
    let locale = sys_locale::get_locale().unwrap_or_else(|| "en".into());
    let (ensure_web, requests) = mpsc::channel();
    let onboarding = options.onboarding;
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(instance)
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
            zoom,
            zoom_op: tauri::async_runtime::Mutex::new(()),
            zoom_persist,
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            open_console,
            retry,
            choose_surface,
            ensure_web_access,
            open_web_browser,
            window_start_dragging,
            window_minimize,
            window_toggle_maximize,
            window_close,
            window_chrome_state,
            window_zoom_get,
            window_zoom_step,
            window_zoom_set
        ])
        .on_window_event(|window, event| {
            if window.label() == MAIN
                && let WindowEvent::CloseRequested { api, .. } = event
            {
                api.prevent_close();
                set_visible(window.app_handle(), false);
            }
        })
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                apply_macos_dock_icon();
            }
            let app_handle = app.handle().clone();
            let popup_app = app_handle.clone();
            let navigation_app = app_handle.clone();
            let permission_app = app_handle.clone();
            let path = if onboarding { ONBOARDING } else { LOADING };
            let builder = WebviewWindowBuilder::new(
                app,
                MAIN,
                WebviewUrl::App(path.trim_start_matches('/').into()),
            )
            .title("CodexHost")
            .inner_size(1140.0, 800.0)
            .min_inner_size(400.0, 320.0)
            .visible(false)
            // Keep HTML5 drag-and-drop active in WKWebView/WebView2 (thread references, row reorder, file drops).
            .disable_drag_drop_handler()
            .initialization_script(navigation::initialization_script(
                initial_zoom_percent,
                &boot_id,
            ));
            #[cfg(target_os = "windows")]
            let builder = builder.decorations(false).shadow(true);
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            builder
                .on_permission_request(move |_, kind| {
                    let shell = permission_app.state::<Shell>();
                    let view = shell.view.lock().unwrap();
                    permission_response(&view.page, kind)
                })
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
            let initial_scale = app.state::<Shell>().zoom.lock().unwrap().scale();
            if let Some(window) = app.get_webview_window(MAIN)
                && let Err(error) = window.set_zoom(initial_scale)
            {
                eprintln!("CodexHost: could not apply initial desktop shell zoom: {error}");
            }
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
    let activation_app = app.handle().clone();
    std::thread::Builder::new()
        .name("instance-activations".into())
        .spawn(move || {
            while let Ok(activation) = activations.recv() {
                let handle = activation_app.clone();
                let delivered = activation_app.run_on_main_thread(move || match activation {
                    Activation::Onboarding => show_onboarding(&handle),
                    Activation::Show => show_main(&handle, None),
                });
                if delivered.is_err() {
                    eprintln!("CodexHost: could not deliver a desktop window activation");
                    break;
                }
            }
        })?;
    app.run(|app, event| match event {
        RunEvent::Exit => {
            if let Some(shell) = app.try_state::<Shell>() {
                // Flush any queued or in-flight zoom update before exiting (no-op if unchanged).
                persist_latest_zoom(&shell.zoom, &shell.zoom_persist, &shell.launcher.data_dir);
            }
            if let Some(ready) = app.try_state::<ShellReady>() {
                ready.remove_if_owned();
            }
            if let Some(instance) = app.try_state::<PrimaryInstance>() {
                instance.shutdown();
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(app, None),
        _ => (),
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use tauri::webview::{PermissionKind, PermissionResponse};

    use super::{Page, Status, permission_response};

    #[test]
    fn onboarding_and_dormant_ignore_background_web_events() {
        assert!(!Page::Onboarding.accepts_web_events());
        assert!(!Page::Dormant.accepts_web_events());
        assert!(Page::Loading(Status::Starting, None).accepts_web_events());
        assert!(Page::Loading(Status::Reconnecting, None).accepts_web_events());
        assert!(Page::Loading(Status::Error, Some("err".into())).accepts_web_events());
        assert!(Page::Web.accepts_web_events());
    }

    #[test]
    fn grants_microphone_permission_only_for_live_web_page() {
        assert_eq!(
            permission_response(&Page::Web, PermissionKind::Microphone),
            PermissionResponse::Allow
        );
        assert_eq!(
            permission_response(&Page::Onboarding, PermissionKind::Microphone),
            PermissionResponse::Default
        );
        assert_eq!(
            permission_response(
                &Page::Loading(Status::Starting, None),
                PermissionKind::Microphone
            ),
            PermissionResponse::Default
        );
        assert_eq!(
            permission_response(&Page::Web, PermissionKind::Camera),
            PermissionResponse::Default
        );
    }
}
