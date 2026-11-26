mod instance;
mod launcher;
mod navigation;
mod readiness;
mod tray;
mod visibility;
mod zoom;

use std::io::{self, Write};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::webview::{NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::{AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use url::Url;

use instance::{Activation, ActivationDelivery, Claim, PrimaryInstance};
use launcher::{Launcher, Options, Surface};
use navigation::{LOADING, Navigation, ONBOARDING, classify, embedded, open_browser};
use readiness::{ShellReady, WebEvent, WebReady};
use visibility::{WindowVisibility, WindowVisibilityState, compute_window_hidden};
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

enum MainTarget {
    Route(&'static str),
    Session(String),
}

impl MainTarget {
    fn apply(self, url: &mut Url) {
        match self {
            Self::Route(route) => url.set_fragment(Some(route)),
            Self::Session(session_id) => {
                url.query_pairs_mut().append_pair("session", &session_id);
            }
        }
    }
}

struct View {
    page: Page,
    last_login: Option<Url>,
    pending_target: Option<MainTarget>,
    live_session_generation: u64,
}

impl View {
    fn open_target(&mut self, target: Option<MainTarget>) -> Result<Option<Url>, String> {
        let Some(target) = target else {
            return Ok(None);
        };
        if matches!(self.page, Page::Web) {
            let mut url = self
                .last_login
                .clone()
                .ok_or("Desktop Web login URL is unavailable")?;
            self.pending_target = None;
            target.apply(&mut url);
            Ok(Some(url))
        } else {
            self.pending_target = Some(target);
            Ok(None)
        }
    }

    fn connect(&mut self, mut login: Url) -> Url {
        self.page = Page::Web;
        self.last_login = Some(login.clone());
        if let Some(target) = self.pending_target.take() {
            target.apply(&mut login);
        }
        login
    }

    fn queue_live_session(&mut self, session_id: String) -> u64 {
        self.live_session_generation = self.live_session_generation.wrapping_add(1);
        self.pending_target = Some(MainTarget::Session(session_id));
        self.live_session_generation
    }

    fn finish_live_session(&mut self, generation: u64, opened: bool) -> Option<Url> {
        if !matches!(self.page, Page::Web)
            || self.live_session_generation != generation
            || !matches!(self.pending_target, Some(MainTarget::Session(_)))
        {
            return None;
        }
        let mut login = self.last_login.clone()?;
        let target = self.pending_target.take()?;
        if opened {
            return None;
        }
        target.apply(&mut login);
        Some(login)
    }
}

struct Shell {
    launcher: Arc<Launcher>,
    view: Mutex<View>,
    ensure_web: Sender<()>,
    locale: String,
    visibility: Mutex<WindowVisibility>,
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

fn navigate(app: &AppHandle, url: Url) -> bool {
    let Some(window) = app.get_webview_window(MAIN) else {
        return false;
    };
    if window.navigate(url).is_err() {
        eprintln!("CodexHost: could not navigate the desktop window");
        return false;
    }
    true
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
            let url = view.connect(ready.login_url);
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

const WINDOW_HIDE_RECONCILE_DELAYS: [Duration; 2] =
    [Duration::from_millis(150), Duration::from_millis(450)];

fn apply_window_hidden_state(app: &AppHandle, state: WindowVisibilityState) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.eval(visibility::sync_script(state));
    }
}

fn sync_window_hidden(app: &AppHandle, hidden: bool) {
    let next = {
        let shell = app.state::<Shell>();
        let mut visibility = shell.visibility.lock().unwrap();
        visibility.update(hidden)
    };
    if let Some(state) = next {
        apply_window_hidden_state(app, state);
    }
}

fn sync_window_hidden_explicit(app: &AppHandle, hidden: bool) {
    let next = {
        let shell = app.state::<Shell>();
        let mut visibility = shell.visibility.lock().unwrap();
        visibility.set_explicit(hidden)
    };
    if let Some(state) = next {
        apply_window_hidden_state(app, state);
    }
}

fn reconcile_window_hidden(app: &AppHandle, generation: u64) {
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    let visible = window.is_visible().unwrap_or(true);
    let minimized = window.is_minimized().unwrap_or(false);
    let hidden = compute_window_hidden(visible, minimized);
    let next = {
        let shell = app.state::<Shell>();
        let mut visibility = shell.visibility.lock().unwrap();
        visibility.apply_reconciled(generation, hidden)
    };
    if let Some(state) = next {
        let _ = window.eval(visibility::sync_script(state));
    }
}

fn schedule_window_hidden_refresh(app: &AppHandle) {
    let (generation, already_hidden) = {
        let shell = app.state::<Shell>();
        let mut visibility = shell.visibility.lock().unwrap();
        (visibility.begin_reconcile(), visibility.state().hidden)
    };
    let next_tick_app = app.clone();
    let _ = app.run_on_main_thread(move || {
        reconcile_window_hidden(&next_tick_app, generation);
    });
    if already_hidden {
        return;
    }
    let delayed_app = app.clone();
    drop(tauri::async_runtime::spawn_blocking(move || {
        for delay in WINDOW_HIDE_RECONCILE_DELAYS {
            std::thread::sleep(delay);
            let keep_going = delayed_app.try_state::<Shell>().is_some_and(|shell| {
                if shell.launcher.is_stopping() {
                    return false;
                }
                let visibility = shell.visibility.lock().unwrap();
                !visibility.state().hidden && visibility.is_reconcile_current(generation)
            });
            if !keep_going {
                return;
            }
            let tick_app = delayed_app.clone();
            if delayed_app
                .run_on_main_thread(move || reconcile_window_hidden(&tick_app, generation))
                .is_err()
            {
                return;
            }
        }
    }));
}

fn refresh_window_hidden(window: &tauri::Window) {
    let visible = window.is_visible().unwrap_or(true);
    let minimized = window.is_minimized().unwrap_or(false);
    sync_window_hidden(
        window.app_handle(),
        compute_window_hidden(visible, minimized),
    );
}

fn set_visible(app: &AppHandle, visible: bool) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN)
        .ok_or("Desktop window is unavailable")?;
    if visible {
        #[cfg(target_os = "macos")]
        {
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
            apply_macos_dock_icon();
        }
        let show = window.show();
        let restore = window.unminimize();
        let focus = window.set_focus();
        if show.is_ok() && restore.is_ok() {
            sync_window_hidden_explicit(app, false);
        }
        show.and(restore)
            .and(focus)
            .map_err(|error| error.to_string())
    } else {
        let hide = window.hide();
        if hide.is_ok() {
            sync_window_hidden_explicit(app, true);
        }
        #[cfg(target_os = "macos")]
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        hide.map_err(|error| error.to_string())
    }
}

fn prepare_main_target(
    app: &AppHandle,
    shell: &Shell,
    target: Option<MainTarget>,
) -> Result<Option<Url>, String> {
    let mut view = shell.view.lock().unwrap();
    let begin = matches!(view.page, Page::Dormant)
        || (matches!(view.page, Page::Onboarding) && target.is_some());
    let url = view.open_target(target)?;
    drop(view);
    if begin {
        begin_web(app, true);
    }
    Ok(url)
}

pub(crate) fn show_main(app: &AppHandle, route: Option<&'static str>) {
    let shell = app.state::<Shell>();
    if shell.launcher.is_stopping() {
        return;
    }
    if let Ok(Some(url)) = prepare_main_target(app, &shell, route.map(MainTarget::Route)) {
        navigate(app, url);
    }
    let _ = set_visible(app, true);
}

fn session_script(origin: &str, session_id: &str) -> String {
    let origin = serde_json::to_string(origin).expect("Web origin is a JSON string");
    let session = serde_json::to_string(session_id).expect("Session ID is a JSON string");
    format!(
        "(() => {{ try {{ if (location.origin !== {origin} || typeof window.__codexhostOpenSession !== 'function') return false; window.__codexhostOpenSession({session}); return true; }} catch {{ return false; }} }})()"
    )
}

fn finish_live_session(app: &AppHandle, generation: u64, opened: bool) -> bool {
    let shell = app.state::<Shell>();
    let target = shell
        .view
        .lock()
        .unwrap()
        .finish_live_session(generation, opened);
    target.is_some_and(|url| navigate(app, url))
}

fn show_session(app: &AppHandle, session_id: String) -> bool {
    let shell = app.state::<Shell>();
    if shell.launcher.is_stopping() {
        return false;
    }
    let Some(window) = app.get_webview_window(MAIN) else {
        return false;
    };
    let live_request = {
        let mut view = shell.view.lock().unwrap();
        if matches!(view.page, Page::Web) {
            let Some(login) = view.last_login.as_ref() else {
                return false;
            };
            let origin = login.origin().ascii_serialization();
            // Keep the target until the live page accepts it or a reconnect consumes it.
            let generation = view.queue_live_session(session_id.clone());
            Some((origin, generation))
        } else {
            None
        }
    };
    let Some((origin, generation)) = live_request else {
        let accepted = prepare_main_target(app, &shell, Some(MainTarget::Session(session_id)))
            .is_ok_and(|target| target.is_none_or(|url| navigate(app, url)));
        if accepted {
            let _ = set_visible(app, true);
        }
        return accepted;
    };
    let script = session_script(&origin, &session_id);
    let callback_app = app.clone();
    let scheduled = window
        .eval_with_callback(script, move |result| {
            let app = callback_app.clone();
            let _ = callback_app.run_on_main_thread(move || {
                finish_live_session(&app, generation, result == "true");
            });
        })
        .is_ok();
    if scheduled || finish_live_session(app, generation, false) {
        let _ = set_visible(app, true);
        return true;
    }
    false
}

pub(crate) fn show_onboarding(app: &AppHandle) {
    let shell = app.state::<Shell>();
    if shell.launcher.is_stopping() {
        return;
    }
    let mut view = shell.view.lock().unwrap();
    view.page = Page::Onboarding;
    view.pending_target = None;
    drop(view);
    let zoom = shell.zoom.lock().unwrap().percent();
    let mut url = embedded(ONBOARDING);
    url.set_query(Some(&format!("zoom={zoom}")));
    navigate(app, url);
    let _ = set_visible(app, true);
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
                let _ = set_visible(&on_main, false);
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
    window.minimize().map_err(|error| error.to_string())?;
    schedule_window_hidden_refresh(window.app_handle());
    Ok(())
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
fn window_visibility_get(
    window: tauri::WebviewWindow,
    shell: State<'_, Shell>,
) -> WindowVisibilityState {
    let hidden = compute_window_hidden(
        window.is_visible().unwrap_or(true),
        window.is_minimized().unwrap_or(false),
    );
    let mut visibility = shell.visibility.lock().unwrap();
    let _ = visibility.update(hidden);
    visibility.state()
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
    let options = Options::from_env().inspect_err(|_| {
        if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--session")) {
            SessionLaunchReply::new(io::stdout()).send(SessionLaunchOutcome::Rejected);
        }
    })?;
    let session_reply = options
        .session_id
        .is_some()
        .then(|| Arc::new(SessionLaunchReply::new(io::stdout())));
    let activation = if let Some(id) = &options.session_id {
        Activation::ShowSession(id.clone())
    } else if options.onboarding {
        Activation::Onboarding
    } else {
        Activation::Show
    };
    let claim = instance::claim(&options.data_dir, activation).inspect_err(|_| {
        if let Some(reply) = &session_reply {
            reply.send(SessionLaunchOutcome::Rejected);
        }
    })?;
    let (instance, activations) = match claim {
        Claim::Primary {
            instance,
            activations,
        } => (instance, activations),
        Claim::Forwarded => {
            if let Some(reply) = &session_reply {
                reply.send(SessionLaunchOutcome::Accepted);
            }
            return Ok(());
        }
        Claim::DeliveryUnknown => {
            if let Some(reply) = &session_reply {
                reply.send(SessionLaunchOutcome::DeliveryUnknown);
            }
            return Ok(());
        }
    };
    let _reject_if_unready = RejectUnfinishedSessionLaunch(session_reply.clone());
    run_primary(options, instance, activations, session_reply)
}

fn run_primary(
    options: Options,
    instance: PrimaryInstance,
    activations: mpsc::Receiver<ActivationDelivery>,
    session_reply: Option<Arc<SessionLaunchReply>>,
) -> Result<(), Box<dyn std::error::Error>> {
    let initial_target = options.session_id.map(MainTarget::Session);
    let launcher = Arc::new(Launcher::new(
        &std::env::current_exe()?,
        options.data_dir,
        options.explicit_data_dir,
    ));
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
    let setup_reply = session_reply.clone();
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
                pending_target: initial_target,
                live_session_generation: 0,
            }),
            ensure_web,
            locale: locale.clone(),
            visibility: Mutex::new(WindowVisibility::new(true)),
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
            window_visibility_get,
            window_zoom_get,
            window_zoom_step,
            window_zoom_set
        ])
        .on_window_event(|window, event| {
            if window.label() != MAIN {
                return;
            }
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = set_visible(window.app_handle(), false);
                }
                // Reconcile actual OS visibility/minimized state on resize or focus
                // changes. Unfocused visible windows (e.g. on a secondary display)
                // report visible=true and minimized=false, so they stay unpaused.
                WindowEvent::Resized(_) => {
                    refresh_window_hidden(window);
                }
                WindowEvent::Focused(true) => {
                    let visible = window.is_visible().unwrap_or(true);
                    let minimized = window.is_minimized().unwrap_or(false);
                    let hidden = compute_window_hidden(visible, minimized);
                    sync_window_hidden_explicit(window.app_handle(), hidden);
                    if hidden {
                        let app = window.app_handle().clone();
                        let generation = {
                            let shell = app.state::<Shell>();
                            let mut visibility = shell.visibility.lock().unwrap();
                            visibility.begin_reconcile()
                        };
                        let tick_app = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            reconcile_window_hidden(&tick_app, generation);
                        });
                    }
                }
                WindowEvent::Focused(false) => {
                    // Defer reading OS state until the event loop settles: during
                    // minimize transitions (both `window_minimize` and native macOS
                    // miniaturize), `Focused(false)` can arrive before `is_minimized()`
                    // flips to true. Secondary-display unfocus keeps visible=true and
                    // minimized=false across every check, so it never pauses.
                    schedule_window_hidden_refresh(window.app_handle());
                }
                _ => (),
            }
        })
        .setup(move |app| {
            // Tauri panics when the setup hook returns Err.
            let mut reject_on_failure = RejectUnfinishedSessionLaunch(setup_reply);
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
            reject_on_failure.0 = None;
            Ok(())
        })
        .build(tauri::generate_context!())?;
    let activation_app = app.handle().clone();
    std::thread::Builder::new()
        .name("instance-activations".into())
        .spawn(move || {
            while let Ok(ActivationDelivery {
                action,
                session_reply,
            }) = activations.recv()
            {
                let handle = activation_app.clone();
                let schedule_failure = session_reply.clone();
                let delivered = activation_app.run_on_main_thread(move || match action {
                    Activation::Onboarding => show_onboarding(&handle),
                    Activation::Show => show_main(&handle, None),
                    Activation::ShowSession(id) => {
                        let accepted = show_session(&handle, id);
                        if let Some(reply) = session_reply {
                            let _ = reply.send(accepted);
                        }
                    }
                });
                if delivered.is_err() {
                    if let Some(reply) = schedule_failure {
                        let _ = reply.send(false);
                    }
                    eprintln!("CodexHost: could not deliver a desktop window activation");
                    break;
                }
            }
        })?;
    app.run(move |app, event| match event {
        RunEvent::Ready => {
            if let Some(reply) = &session_reply {
                reply.send(SessionLaunchOutcome::Accepted);
            }
        }
        RunEvent::Exit => {
            if let Some(reply) = &session_reply {
                reply.send(SessionLaunchOutcome::Rejected);
            }
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

enum SessionLaunchOutcome {
    Accepted,
    Rejected,
    DeliveryUnknown,
}

struct SessionLaunchReply<W = io::Stdout>(Mutex<Option<W>>);

impl<W: Write> SessionLaunchReply<W> {
    fn new(output: W) -> Self {
        Self(Mutex::new(Some(output)))
    }

    fn send(&self, outcome: SessionLaunchOutcome) {
        let Some(mut output) = self.0.lock().unwrap().take() else {
            return;
        };
        let line: &[u8] = match outcome {
            SessionLaunchOutcome::Accepted => b"ok\n",
            SessionLaunchOutcome::Rejected => b"no\n",
            SessionLaunchOutcome::DeliveryUnknown => b"unknown\n",
        };
        let _ = output.write_all(line).and_then(|()| output.flush());
    }
}

struct RejectUnfinishedSessionLaunch<W: Write = io::Stdout>(Option<Arc<SessionLaunchReply<W>>>);

impl<W: Write> Drop for RejectUnfinishedSessionLaunch<W> {
    fn drop(&mut self) {
        if let Some(reply) = &self.0 {
            reply.send(SessionLaunchOutcome::Rejected);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tauri::webview::{PermissionKind, PermissionResponse};
    use url::Url;

    use super::{
        MainTarget, Page, RejectUnfinishedSessionLaunch, SessionLaunchOutcome, SessionLaunchReply,
        Status, View, permission_response, session_script,
    };

    #[test]
    fn primary_session_launch_emits_one_terminal_reply_across_startup_phases() {
        for (scenario, setup, ready, expected) in [
            ("build failed", None, false, b"no\n"),
            ("setup failed", Some(false), false, b"no\n"),
            ("failed after setup", Some(true), false, b"no\n"),
            ("reached Ready", Some(true), true, b"ok\n"),
        ] {
            let output = tempfile::NamedTempFile::new().unwrap();
            let reply = Arc::new(SessionLaunchReply::new(output.reopen().unwrap()));
            {
                let _primary = RejectUnfinishedSessionLaunch(Some(reply.clone()));
                if let Some(succeeded) = setup {
                    {
                        let mut setup = RejectUnfinishedSessionLaunch(Some(reply.clone()));
                        if succeeded {
                            setup.0 = None;
                        }
                    }
                    let after_setup: &[u8] = if succeeded { b"" } else { b"no\n" };
                    assert_eq!(
                        std::fs::read(output.path()).unwrap(),
                        after_setup,
                        "{scenario}: before the primary guard drops"
                    );
                }
                if ready {
                    assert!(std::fs::read(output.path()).unwrap().is_empty());
                    reply.send(SessionLaunchOutcome::Accepted);
                    reply.send(SessionLaunchOutcome::Accepted);
                    reply.send(SessionLaunchOutcome::Rejected);
                }
            }
            assert_eq!(
                std::fs::read(output.path()).unwrap(),
                expected.as_slice(),
                "{scenario}"
            );
        }
    }

    #[test]
    fn unknown_forwarded_session_emits_one_terminal_reply() {
        let output = tempfile::NamedTempFile::new().unwrap();
        let reply = Arc::new(SessionLaunchReply::new(output.reopen().unwrap()));
        {
            let _reject_if_unready = RejectUnfinishedSessionLaunch(Some(reply.clone()));
            reply.send(SessionLaunchOutcome::DeliveryUnknown);
        }
        assert_eq!(
            std::fs::read(output.path()).unwrap().as_slice(),
            b"unknown\n"
        );
    }

    #[test]
    fn notification_session_uses_the_live_login_and_survives_reconnect() {
        let old_login = Url::parse("http://127.0.0.1:4400/?token=old").unwrap();
        let new_login = Url::parse("http://127.0.0.1:4401/?token=new").unwrap();
        let session = || MainTarget::Session("thread/一?x=#".into());
        let mut view = View {
            page: Page::Loading(Status::Starting, None),
            last_login: None,
            pending_target: Some(session()),
            live_session_generation: 0,
        };
        let live = view.connect(old_login);
        assert_eq!(
            live.as_str(),
            "http://127.0.0.1:4400/?token=old&session=thread%2F%E4%B8%80%3Fx%3D%23"
        );

        assert!(view.pending_target.is_none());
        let earlier = view.queue_live_session("earlier".into());
        view.page = Page::Loading(Status::Reconnecting, None);
        assert_eq!(view.open_target(Some(session())).unwrap(), None);
        assert_eq!(view.finish_live_session(earlier, false), None);
        let reconnected = view.connect(new_login.clone());
        assert_eq!(
            reconnected.as_str(),
            "http://127.0.0.1:4401/?token=new&session=thread%2F%E4%B8%80%3Fx%3D%23"
        );
        assert_eq!(view.connect(new_login.clone()), new_login);
        let request = view.queue_live_session("thread/一?x=#".into());
        assert_eq!(
            view.finish_live_session(request, false).unwrap(),
            reconnected
        );
        let request = view.queue_live_session("thread/一?x=#".into());
        assert_eq!(view.finish_live_session(request, true), None);
        assert!(view.pending_target.is_none());
    }

    #[test]
    fn tray_route_supersedes_live_fallback_even_if_the_same_session_is_requested_again() {
        let login = Url::parse("http://127.0.0.1:4401/?token=new").unwrap();
        let mut view = View {
            page: Page::Web,
            last_login: Some(login),
            pending_target: None,
            live_session_generation: 0,
        };
        let earlier = view.queue_live_session("thread".into());
        let settings = view
            .open_target(Some(MainTarget::Route("connect-devices")))
            .unwrap()
            .unwrap();
        assert_eq!(
            settings.as_str(),
            "http://127.0.0.1:4401/?token=new#connect-devices"
        );
        assert_eq!(view.finish_live_session(earlier, false), None);

        let latest = view.queue_live_session("thread".into());
        assert_eq!(
            view.open_target(None).unwrap(),
            None,
            "show the current page"
        );
        assert_eq!(view.finish_live_session(earlier, false), None);
        assert_eq!(
            view.finish_live_session(latest, false).unwrap().as_str(),
            "http://127.0.0.1:4401/?token=new&session=thread"
        );
    }

    #[test]
    fn live_session_script_uses_a_json_string_on_the_trusted_origin() {
        let id = r#"id"); globalThis.injected = true; //"#;
        let script = session_script("http://127.0.0.1:4400", id);
        assert!(script.contains(&format!(
            "window.__codexhostOpenSession({})",
            serde_json::to_string(id).unwrap()
        )));
        assert!(script.contains(r#"location.origin !== "http://127.0.0.1:4400""#));
    }

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
