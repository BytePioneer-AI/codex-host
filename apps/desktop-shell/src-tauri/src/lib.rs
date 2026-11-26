mod instance;
mod launcher;
mod navigation;
mod readiness;
mod session_activation;
#[cfg(windows)]
mod session_dispatch;
mod tray;
mod visibility;
mod zoom;

use std::io::{self, Write};
#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::webview::{NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::{AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use url::Url;

use instance::{Activation, ActivationDelivery, Claim, PrimaryInstance};
use launcher::{Launcher, Options, Surface};
use navigation::{LOADING, Navigation, ONBOARDING, classify, embedded, open_browser};
use readiness::{ShellReady, WebEvent, WebReady};
use session_activation::{
    Abandon, Admission, Scheduling, SessionActivation, SessionClaim, SessionReceipt, wake_script,
};
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

struct View {
    page: Page,
    last_login: Option<Url>,
    pending_route: Option<&'static str>,
    session: SessionActivation,
}

impl View {
    fn open_route(&mut self, route: &'static str) -> Option<Url> {
        self.session.clear_unclaimed();
        if matches!(self.page, Page::Web) {
            let mut login = self.last_login.clone()?;
            login.set_fragment(Some(route));
            Some(login)
        } else {
            self.pending_route = Some(route);
            None
        }
    }

    fn connect(&mut self, mut login: Url) -> (Url, Option<u64>) {
        self.page = Page::Web;
        self.last_login = Some(login.clone());
        if let Some(route) = self.pending_route.take() {
            login.set_fragment(Some(route));
        }
        let generation = self.session.connect(&mut login);
        (login, generation)
    }

    fn accepts_session_page(&self, url: &Url) -> bool {
        matches!(self.page, Page::Web)
            && self
                .last_login
                .as_ref()
                .is_some_and(|login| login.origin() == url.origin())
    }
}

struct Shell {
    launcher: Arc<Launcher>,
    view: Mutex<View>,
    ensure_web: Sender<()>,
    locale: String,
    visibility: Mutex<WindowVisibility>,
    deferred_session: Mutex<Option<DeferredSession>>,
    zoom: Arc<Mutex<ZoomController>>,
    zoom_op: tauri::async_runtime::Mutex<()>,
    zoom_persist: Arc<Mutex<Option<u16>>>,
}

fn navigation_for(view: &mut View, url: &Url, admit: bool) -> Navigation {
    match classify(url, view.last_login.as_ref()) {
        Navigation::Web if matches!(view.page, Page::Web) => {
            if view.session.allows_navigation(url, admit) == Some(false) {
                Navigation::Block
            } else {
                Navigation::Web
            }
        }
        // Do not export a stale shell session navigation to the browser.
        Navigation::Web => Navigation::Block,
        Navigation::Browser if view.session.allows_navigation(url, false).is_some() => {
            Navigation::Block
        }
        decision => decision,
    }
}

enum TopLevelNavigation {
    #[cfg(any(windows, test))]
    Native { id: u64, redirected: bool },
    #[cfg(not(windows))]
    Portable,
}

fn handle_navigation(
    view: &Mutex<View>,
    url: &Url,
    source: TopLevelNavigation,
    open_external: impl FnOnce(&Url),
) -> bool {
    let decision = {
        let mut view = view.lock().unwrap();
        let (allowed, redirected) = match source {
            #[cfg(any(windows, test))]
            TopLevelNavigation::Native { id, redirected } => (
                view.session.native_login_allows(id, url, redirected),
                redirected,
            ),
            #[cfg(not(windows))]
            TopLevelNavigation::Portable => (view.session.portable_login_allows(url), false),
        };
        if !allowed {
            Navigation::Block
        } else {
            match navigation_for(&mut view, url, true) {
                // A superseded authentication redirect must not acquire a new browser.
                Navigation::Browser if redirected => Navigation::Block,
                decision => decision,
            }
        }
    };
    match decision {
        Navigation::Embedded | Navigation::Web => true,
        Navigation::Browser => {
            open_external(url);
            false
        }
        Navigation::Block => false,
    }
}

fn popup_navigation(app: &AppHandle, url: &Url) -> Navigation {
    let shell = app.state::<Shell>();
    navigation_for(&mut shell.view.lock().unwrap(), url, false)
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

fn begin_web(app: &AppHandle, replace_page: bool) -> bool {
    let shell = app.state::<Shell>();
    if shell.launcher.is_stopping() {
        return false;
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
        return false;
    }
    true
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
            let (url, generation) = view.connect(ready.login_url);
            drop(view);
            if let Some(generation) = generation {
                navigate_session_login(app, url, generation);
                sync_session_notice(app);
                schedule_session_followup(app, generation);
            } else {
                navigate(app, url);
            }
            return;
        }
        WebEvent::Reconnecting => {
            view.session.web_disconnected();
            view.page = Page::Loading(Status::Reconnecting, None);
            Status::Reconnecting
        }
        WebEvent::Error(message) => {
            view.session.web_disconnected();
            view.page = Page::Loading(Status::Error, Some(message));
            Status::Error
        }
    };
    drop(view);
    navigate_loading(app, status);
}

const SESSION_LOGIN_LIMIT: Duration = Duration::from_secs(10);

fn navigate_session_login(app: &AppHandle, url: Url, generation: u64) {
    #[cfg(windows)]
    let not_scheduled = app
        .get_webview_window(MAIN)
        .is_none_or(|window| session_dispatch::navigate(&window, url) == Scheduling::NotScheduled);
    #[cfg(not(windows))]
    let not_scheduled = !navigate(app, url);
    if not_scheduled {
        app.state::<Shell>()
            .view
            .lock()
            .unwrap()
            .session
            .defer_login(generation);
        return;
    }
    schedule_on_main(app, SESSION_LOGIN_LIMIT, move |app| {
        app.state::<Shell>()
            .view
            .lock()
            .unwrap()
            .session
            .expire_login(generation);
    });
}

#[cfg(windows)]
fn observe_session_login(window: &tauri::WebviewWindow) -> Scheduling {
    let started = window.app_handle().clone();
    let completed = started.clone();
    session_dispatch::observe_navigation(
        window,
        move |id, url, redirected| {
            handle_navigation(
                &started.state::<Shell>().view,
                url,
                TopLevelNavigation::Native { id, redirected },
                open_browser,
            )
        },
        move |id, outcome| {
            let finished = completed
                .state::<Shell>()
                .view
                .lock()
                .unwrap()
                .session
                .native_login_completed(id, outcome);
            if finished {
                wake_pending_session(&completed);
            }
        },
    )
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

enum SessionDispatch {
    Pending(u64),
    Live { login: Url, generation: u64 },
}

fn prepare_session(
    view: &Mutex<View>,
    session_id: String,
    show_window: impl FnOnce() -> Result<(), String>,
    start_web: impl FnOnce() -> bool,
) -> Result<SessionDispatch, Admission> {
    let start = {
        let view = view.lock().unwrap();
        match view.page {
            Page::Dormant | Page::Onboarding => true,
            Page::Loading(Status::Error, _) => return Err(Admission::Rejected),
            Page::Web => view.session.login_needs_retry() && !view.session.has_claim(),
            _ => false,
        }
    };
    show_window().map_err(|_| Admission::Rejected)?;
    if start && !start_web() {
        return Err(Admission::Rejected);
    }
    let mut view = view.lock().unwrap();
    let login = if matches!(view.page, Page::Web) {
        Some(view.last_login.clone().ok_or(Admission::Rejected)?)
    } else {
        None
    };
    let joins_login = view.session.login_in_flight();
    let generation = view
        .session
        .stage(session_id, login.is_some())
        .ok_or(Admission::Unknown)?;
    Ok(match login {
        Some(_) if joins_login => SessionDispatch::Pending(generation),
        Some(login) => SessionDispatch::Live { login, generation },
        None => SessionDispatch::Pending(generation),
    })
}

pub(crate) fn show_main(app: &AppHandle, route: Option<&'static str>) {
    let shell = app.state::<Shell>();
    if shell.launcher.is_stopping() {
        return;
    }
    let (url, begin) = {
        let mut view = shell.view.lock().unwrap();
        let begin = matches!(view.page, Page::Dormant)
            || (matches!(view.page, Page::Onboarding) && route.is_some());
        (route.and_then(|route| view.open_route(route)), begin)
    };
    if begin {
        begin_web(app, true);
    }
    if let Some(url) = url {
        navigate(app, url);
    }
    sync_session_notice(app);
    let _ = set_visible(app, true);
}

const SESSION_PROBE_DELAY: Duration = Duration::from_millis(500);
const SESSION_NOTICE_DELAY: Duration = Duration::from_secs(2);
const SESSION_WAIT_LIMIT: Duration = Duration::from_millis(700);

fn finish_session(view: &Mutex<View>, generation: u64, scheduling: Scheduling) -> Admission {
    let mut view = view.lock().unwrap();
    let outcome = view.session.finish(generation, scheduling);
    if outcome == Admission::Accepted {
        view.pending_route = None;
    }
    outcome
}

#[cfg(any(windows, test))]
fn dispatch_live_session(
    view: &Mutex<View>,
    login: Url,
    generation: u64,
    schedule_eval: impl FnOnce() -> Scheduling,
    schedule_navigation: impl FnOnce(Url) -> Scheduling,
    wake: impl FnOnce(),
) -> Admission {
    let eval = schedule_eval();
    let scheduling = if eval == Scheduling::Scheduled {
        eval
    } else {
        let url = view.lock().unwrap().session.stage_url(generation, login);
        match url.map_or(Scheduling::Unknown, schedule_navigation) {
            Scheduling::NotScheduled if eval == Scheduling::Unknown => Scheduling::Unknown,
            navigation => navigation,
        }
    };
    let outcome = finish_session(view, generation, scheduling);
    if outcome == Admission::Accepted {
        wake();
    }
    outcome
}

#[cfg(any(not(windows), test))]
fn portable_dispatch_scheduling(result: &str) -> Scheduling {
    match result {
        "true" => Scheduling::Scheduled,
        "false" => Scheduling::NotScheduled,
        _ => Scheduling::Unknown,
    }
}

#[cfg(not(windows))]
fn dispatch_portable_session(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    script: String,
    origin: &str,
    generation: u64,
    reply: Option<Sender<bool>>,
) -> Admission {
    let origin = serde_json::to_string(origin).expect("Web origin is a JSON string");
    let proof = format!(
        "(() => {{ if (location.origin !== {origin} || typeof window.__codexhostOpenDesktopSession !== 'function') return false; {script} return true; }})()"
    );
    let handle = app.clone();
    let reply = Arc::new(Mutex::new(reply));
    let callback_reply = reply.clone();
    let _ = window.eval_with_callback(proof, move |result| {
        let scheduling = portable_dispatch_scheduling(&result);
        let app = handle.clone();
        let callback_reply = callback_reply.clone();
        let _ = handle.run_on_main_thread(move || {
            complete_portable_dispatch(&app, generation, scheduling, &callback_reply);
        });
    });
    // Only the callback can confirm this candidate; dispatch alone cannot replace A.
    schedule_on_main(app, SESSION_PROBE_DELAY, move |app| {
        complete_portable_dispatch(app, generation, Scheduling::Unknown, &reply);
    });
    Admission::Unknown
}

#[cfg(not(windows))]
fn complete_portable_dispatch(
    app: &AppHandle,
    generation: u64,
    scheduling: Scheduling,
    reply: &Mutex<Option<Sender<bool>>>,
) {
    let shell = app.state::<Shell>();
    match resolve_portable_dispatch(&shell.view, generation, scheduling, reply) {
        Admission::Accepted => {
            wake_session(app, generation);
            sync_session_notice(app);
            schedule_session_followup(app, generation);
        }
        Admission::Rejected | Admission::Unknown => wake_pending_session(app),
    }
}

#[cfg(any(not(windows), test))]
fn resolve_portable_dispatch(
    view: &Mutex<View>,
    generation: u64,
    scheduling: Scheduling,
    reply: &Mutex<Option<Sender<bool>>>,
) -> Admission {
    send_session_reply(
        finish_session(view, generation, scheduling),
        reply.lock().unwrap().take(),
    )
}

fn schedule_on_main(
    app: &AppHandle,
    delay: Duration,
    action: impl FnOnce(&AppHandle) + Send + 'static,
) {
    let app = app.clone();
    drop(tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(delay);
        let on_main = app.clone();
        let _ = app.run_on_main_thread(move || action(&on_main));
    }));
}

fn session_notice_label(locale: &str) -> &'static str {
    if locale.starts_with("zh") {
        "通知会话打开状态未确认，请在当前窗口查看"
    } else {
        "Notification session opening unconfirmed. Check this window."
    }
}

fn sync_session_notice(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let unconfirmed = shell.view.lock().unwrap().session.is_unconfirmed();
    if let Some(window) = app.get_webview_window(MAIN) {
        let notice = unconfirmed.then(|| session_notice_label(&shell.locale));
        if let Some(text) = notice {
            let _ = window.set_title(&format!("CodexHost — {text}"));
        } else {
            let _ = window.set_title("CodexHost");
        }
        #[cfg(windows)]
        if let Ok(notice) = serde_json::to_string(&notice) {
            let _ = window.eval(format!(
                "window.__codexhostSetDesktopSessionNotice?.({notice});"
            ));
        }
    }
    tray::set_session_notice(app, unconfirmed);
}

fn wake_session(app: &AppHandle, generation: u64) {
    let shell = app.state::<Shell>();
    let wake = {
        let view = shell.view.lock().unwrap();
        view.last_login.as_ref().and_then(|url| {
            view.session
                .wake_url_only(generation)
                .filter(|_| matches!(view.page, Page::Web))
                .map(|url_only| {
                    wake_script(&url.origin().ascii_serialization(), generation, url_only)
                })
        })
    };
    if let (Some(window), Some(wake)) = (app.get_webview_window(MAIN), wake) {
        let _ = window.eval(wake);
    }
}

fn wake_pending_session(app: &AppHandle) {
    let previous = app
        .state::<Shell>()
        .view
        .lock()
        .unwrap()
        .session
        .pending_generation();
    if let Some(previous) = previous {
        wake_session(app, previous);
    }
}

fn schedule_session_followup(app: &AppHandle, generation: u64) {
    schedule_on_main(app, SESSION_PROBE_DELAY, move |app| {
        wake_session(app, generation)
    });
    schedule_on_main(app, SESSION_NOTICE_DELAY, move |app| {
        app.state::<Shell>()
            .view
            .lock()
            .unwrap()
            .session
            .mark_unconfirmed(generation);
        sync_session_notice(app);
    });
}

fn show_session(app: &AppHandle, session_id: String, reply: Option<Sender<bool>>) -> Admission {
    let shell = app.state::<Shell>();
    if shell.launcher.is_stopping() {
        return send_session_reply(Admission::Rejected, reply);
    }
    let dispatch = match prepare_session(
        &shell.view,
        session_id,
        || set_visible(app, true),
        || begin_web(app, true),
    ) {
        Ok(dispatch) => dispatch,
        Err(outcome) => return send_session_reply(outcome, reply),
    };
    let (outcome, generation) = match dispatch {
        SessionDispatch::Pending(generation) => (
            finish_session(&shell.view, generation, Scheduling::Scheduled),
            generation,
        ),
        SessionDispatch::Live { login, generation } => {
            let origin = login.origin().ascii_serialization();
            let script = wake_script(&origin, generation, false);
            let Some(window) = app.get_webview_window(MAIN) else {
                return send_session_reply(
                    finish_session(&shell.view, generation, Scheduling::NotScheduled),
                    reply,
                );
            };
            if !window
                .url()
                .is_ok_and(|current| current.origin() == login.origin())
            {
                let outcome = finish_session(&shell.view, generation, Scheduling::Unknown);
                wake_pending_session(app);
                return send_session_reply(outcome, reply);
            }
            #[cfg(not(windows))]
            return dispatch_portable_session(app, &window, script, &origin, generation, reply);
            #[cfg(windows)]
            let outcome = dispatch_live_session(
                &shell.view,
                login,
                generation,
                || session_dispatch::eval(&window, script),
                |url| session_dispatch::navigate(&window, url),
                || wake_session(app, generation),
            );
            #[cfg(windows)]
            (outcome, generation)
        }
    };
    if outcome == Admission::Accepted {
        sync_session_notice(app);
        schedule_session_followup(app, generation);
    } else {
        wake_pending_session(app);
    }
    send_session_reply(outcome, reply)
}

struct DeferredSession {
    session_id: String,
    reply: Sender<bool>,
    until: Instant,
}

fn send_session_reply(outcome: Admission, reply: Option<Sender<bool>>) -> Admission {
    if let Some(reply) = reply {
        match outcome {
            Admission::Accepted => {
                let _ = reply.send(true);
            }
            Admission::Rejected => {
                let _ = reply.send(false);
            }
            Admission::Unknown => (),
        }
    }
    outcome
}

fn forward_session(app: &AppHandle, session_id: String, reply: Sender<bool>) {
    let shell = app.state::<Shell>();
    let held = {
        let view = shell.view.lock().unwrap();
        if view.session.is_discarding() {
            return; // Do not queue behind an explicit abandonment.
        }
        view.session.has_claim()
    };
    if held {
        let mut waiting = shell.deferred_session.lock().unwrap();
        if waiting.is_some() {
            return; // A full waiting slot is not an explicit rejection.
        }
        *waiting = Some(DeferredSession {
            session_id,
            reply,
            until: Instant::now() + SESSION_WAIT_LIMIT,
        });
        drop(waiting);
        schedule_on_main(app, SESSION_WAIT_LIMIT, resume_forwarded_session);
    } else {
        resume_forwarded_session(app);
        show_session(app, session_id, Some(reply));
    }
}

fn take_deferred_session(
    waiting: &mut Option<DeferredSession>,
    held: bool,
    now: Instant,
) -> Option<DeferredSession> {
    if waiting.as_ref().is_some_and(|request| now >= request.until) {
        waiting.take(); // Drop the reply: the instance reports unknown.
    }
    if held { None } else { waiting.take() }
}

fn resume_forwarded_session(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let held = shell.view.lock().unwrap().session.has_claim();
    let ready = take_deferred_session(
        &mut shell.deferred_session.lock().unwrap(),
        held,
        Instant::now(),
    );
    if let Some(request) = ready {
        show_session(app, request.session_id, Some(request.reply));
    }
}

fn begin_session_abandonment(
    view: &Mutex<View>,
    waiting: &Mutex<Option<DeferredSession>>,
) -> Option<Abandon> {
    let disposition = view.lock().unwrap().session.abandon_unconfirmed()?;
    if matches!(disposition, Abandon::AwaitDocument) {
        // Waiting clicks are unknown, not a new intent to open after cancellation.
        waiting.lock().unwrap().take();
    }
    Some(disposition)
}

pub(crate) fn abandon_session(app: &AppHandle) {
    let shell = app.state::<Shell>();
    match begin_session_abandonment(&shell.view, &shell.deferred_session) {
        Some(Abandon::AwaitDocument) => (),
        Some(Abandon::Unclaimed) => {
            sync_session_notice(app);
            return;
        }
        None => return,
    }
    probe_session_bridge(app);
    schedule_on_main(app, SESSION_PROBE_DELAY, probe_session_bridge);
}

fn probe_session_bridge(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.eval("window.__codexhostRefreshDesktopSession?.();");
    }
}

#[tauri::command]
fn desktop_session_claim(
    window: tauri::WebviewWindow,
    shell: State<'_, Shell>,
    generation: Option<String>,
    document: String,
) -> SessionClaim {
    if document.len() != 36 || shell.launcher.is_stopping() {
        return SessionClaim::Unavailable;
    }
    let Ok(url) = window.url() else {
        return SessionClaim::Retry;
    };
    let mut view = shell.view.lock().unwrap();
    if window.label() != MAIN {
        return SessionClaim::Unavailable;
    }
    if !view.accepts_session_page(&url) {
        return SessionClaim::Retry;
    }
    match generation {
        Some(generation) => generation
            .parse()
            .map_or(SessionClaim::Unavailable, |generation| {
                view.session.claim(generation, document)
            }),
        None => view.session.ready(&document),
    }
}

#[tauri::command]
fn desktop_session_opened(
    window: tauri::WebviewWindow,
    shell: State<'_, Shell>,
    generation: String,
    document: String,
) -> SessionReceipt {
    confirm_session_receipt(window, shell, generation, document, false)
}

#[tauri::command]
fn desktop_session_discarded(
    window: tauri::WebviewWindow,
    shell: State<'_, Shell>,
    generation: String,
    document: String,
) -> SessionReceipt {
    confirm_session_receipt(window, shell, generation, document, true)
}

fn confirm_session_receipt(
    window: tauri::WebviewWindow,
    shell: State<'_, Shell>,
    generation: String,
    document: String,
    discarded: bool,
) -> SessionReceipt {
    let Ok(generation) = generation.parse() else {
        return SessionReceipt::Unavailable;
    };
    if window.label() != MAIN || document.len() != 36 {
        return SessionReceipt::Unavailable;
    }
    let Ok(url) = window.url() else {
        return SessionReceipt::Retry;
    };
    let mut view = shell.view.lock().unwrap();
    let current = view.accepts_session_page(&url);
    let result = view
        .session
        .receipt(generation, &document, discarded, current);
    if result == SessionReceipt::Confirmed {
        drop(view);
        let app = window.app_handle().clone();
        let _ = window.run_on_main_thread(move || {
            sync_session_notice(&app);
            if !discarded {
                resume_forwarded_session(&app);
            }
        });
    }
    result
}

pub(crate) fn show_onboarding(app: &AppHandle) {
    let shell = app.state::<Shell>();
    if shell.launcher.is_stopping() {
        return;
    }
    let mut view = shell.view.lock().unwrap();
    view.page = Page::Onboarding;
    view.pending_route = None;
    view.session.clear_unclaimed();
    drop(view);
    let zoom = shell.zoom.lock().unwrap().percent();
    let mut url = embedded(ONBOARDING);
    url.set_query(Some(&format!("zoom={zoom}")));
    navigate(app, url);
    sync_session_notice(app);
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
            Surface::NativeShell => {
                begin_web(&on_main, true);
            }
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
    desktop_session_notice: Option<&'static str>,
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
fn window_chrome_state(window: tauri::WebviewWindow, shell: State<'_, Shell>) -> WindowChromeState {
    WindowChromeState {
        maximized: window.is_maximized().unwrap_or(false),
        fullscreen: window.is_fullscreen().unwrap_or(false),
        desktop_session_notice: shell
            .view
            .lock()
            .unwrap()
            .session
            .is_unconfirmed()
            .then(|| session_notice_label(&shell.locale)),
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
    let initial_session = options.session_id;
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
                pending_route: None,
                session: SessionActivation::default(),
            }),
            ensure_web,
            locale: locale.clone(),
            visibility: Mutex::new(WindowVisibility::new(true)),
            deferred_session: Mutex::new(None),
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
            desktop_session_claim,
            desktop_session_opened,
            desktop_session_discarded,
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
            #[cfg(not(windows))]
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
            #[cfg(windows)]
            let navigation_ready = Arc::new(AtomicBool::new(false));
            #[cfg(windows)]
            let builder = {
                let ready = navigation_ready.clone();
                builder.on_navigation(move |url| {
                    ready.load(Ordering::Relaxed) || classify(url, None) == Navigation::Embedded
                })
            };
            #[cfg(not(windows))]
            let builder = builder.on_navigation(move |url| {
                handle_navigation(
                    &navigation_app.state::<Shell>().view,
                    url,
                    TopLevelNavigation::Portable,
                    open_browser,
                )
            });
            #[cfg(not(windows))]
            let builder = builder.on_page_load(|window, payload| {
                if payload.event() == tauri::webview::PageLoadEvent::Started {
                    let shell = window.state::<Shell>();
                    let finished = shell
                        .view
                        .lock()
                        .unwrap()
                        .session
                        .portable_login_loaded(payload.url());
                    if finished {
                        wake_pending_session(window.app_handle());
                    }
                }
            });
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
                .on_new_window(move |url, _features| {
                    match popup_navigation(&popup_app, &url) {
                        Navigation::Browser => open_browser(&url),
                        Navigation::Web => {
                            let app = popup_app.clone();
                            let _ = popup_app.run_on_main_thread(move || {
                                if popup_navigation(&app, &url) == Navigation::Web {
                                    navigate(&app, url);
                                }
                            });
                        }
                        Navigation::Embedded | Navigation::Block => (),
                    }
                    NewWindowResponse::Deny
                })
                .build()?;
            #[cfg(windows)]
            {
                let window = app.get_webview_window(MAIN).expect("main window was built");
                if observe_session_login(&window) != Scheduling::Scheduled {
                    return Err(
                        io::Error::other("Cannot install desktop Web navigation policy").into(),
                    );
                }
                navigation_ready.store(true, Ordering::Relaxed);
            }
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
            if let Some(session_id) = initial_session {
                let admission = if begin_web(&app_handle, false) {
                    show_session(&app_handle, session_id, None)
                } else {
                    Admission::Rejected
                };
                confirm_session_setup(admission, reject_on_failure.0.as_deref())?;
            } else {
                show_main(&app_handle, None);
                if !onboarding {
                    begin_web(&app_handle, false);
                }
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
                        if let Some(reply) = session_reply {
                            forward_session(&handle, id, reply);
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

fn confirm_session_setup<W: Write>(
    admission: Admission,
    reply: Option<&SessionLaunchReply<W>>,
) -> io::Result<()> {
    match admission {
        Admission::Accepted => (),
        Admission::Rejected => {
            return Err(io::Error::other(
                "Desktop session activation was not accepted",
            ));
        }
        Admission::Unknown => {
            if let Some(reply) = reply {
                reply.send(SessionLaunchOutcome::DeliveryUnknown);
            }
        }
    }
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
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::{Duration, Instant};

    use tauri::webview::{PermissionKind, PermissionResponse};
    use url::Url;

    use super::session_activation::NativeLoginCompletion::{Loaded, Rejected, TransportFailed};
    use super::{
        Abandon, Admission, DeferredSession, Page, RejectUnfinishedSessionLaunch, Scheduling,
        SessionActivation, SessionClaim, SessionDispatch, SessionLaunchOutcome, SessionLaunchReply,
        SessionReceipt, Status, TopLevelNavigation, View, begin_session_abandonment,
        confirm_session_setup, dispatch_live_session, finish_session, handle_navigation,
        permission_response, portable_dispatch_scheduling, prepare_session,
        resolve_portable_dispatch, take_deferred_session, wake_script,
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
    fn unknown_primary_setup_is_not_overridden_by_ready_or_exit() {
        let output = tempfile::NamedTempFile::new().unwrap();
        let reply = Arc::new(SessionLaunchReply::new(output.reopen().unwrap()));
        {
            let _reject_if_unready = RejectUnfinishedSessionLaunch(Some(reply.clone()));
            confirm_session_setup(Admission::Unknown, Some(reply.as_ref())).unwrap();
            reply.send(SessionLaunchOutcome::Accepted);
        }
        assert_eq!(
            std::fs::read(output.path()).unwrap().as_slice(),
            b"unknown\n"
        );
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

    fn session_view(page: Page, last_login: Option<Url>) -> View {
        View {
            page,
            last_login,
            pending_route: None,
            session: SessionActivation::default(),
        }
    }

    fn accept(view: &mut View, session_id: &str, live: bool) -> u64 {
        let generation = view.session.stage(session_id.into(), live).unwrap();
        assert_eq!(
            view.session.finish(generation, Scheduling::Scheduled),
            Admission::Accepted
        );
        generation
    }

    fn granted(session_id: &str) -> SessionClaim {
        SessionClaim::Granted {
            session_id: session_id.into(),
        }
    }

    #[test]
    fn unclaimed_notification_session_uses_the_fresh_login_on_reconnect() {
        let old_login = Url::parse("http://127.0.0.1:4400/?token=old").unwrap();
        let new_login = Url::parse("http://127.0.0.1:4401/?token=new").unwrap();
        let mut view = session_view(Page::Loading(Status::Starting, None), None);
        let thread = "thread/一?x=#";
        accept(&mut view, thread, false);
        let (first, Some(old_generation)) = view.connect(old_login) else {
            panic!("first delivery")
        };
        assert_eq!(
            first.as_str(),
            "http://127.0.0.1:4400/?token=old&session=thread%2F%E4%B8%80%3Fx%3D%23&desktopSessionGeneration=2"
        );
        assert_eq!(view.session.allows_navigation(&first, false), Some(true));
        view.page = Page::Loading(Status::Reconnecting, None);
        let (reconnected, Some(generation)) = view.connect(new_login.clone()) else {
            panic!("second delivery")
        };
        assert_eq!(
            reconnected.as_str(),
            "http://127.0.0.1:4401/?token=new&session=thread%2F%E4%B8%80%3Fx%3D%23&desktopSessionGeneration=3"
        );
        assert_eq!(view.session.allows_navigation(&first, false), Some(false));
        assert_eq!(
            view.session.allows_navigation(&reconnected, false),
            Some(true)
        );
        assert_eq!(view.session.wake_url_only(generation), Some(true));
        assert_eq!(
            view.session.ready("new-document"),
            SessionClaim::Unavailable
        );
        assert_eq!(
            view.session.claim(old_generation, "old-document".into()),
            SessionClaim::Unavailable
        );
        assert_eq!(
            view.session.claim(generation, "new-document".into()),
            granted(thread)
        );
        assert_eq!(
            view.session
                .receipt(generation, "new-document", false, true),
            SessionReceipt::Confirmed
        );
        assert_eq!(view.connect(new_login.clone()), (new_login, None));
    }

    #[test]
    fn reconnect_does_not_replay_a_claimed_session_with_no_ack() {
        let login = Url::parse("http://127.0.0.1:4400/?token=old").unwrap();
        let new_login = Url::parse("http://127.0.0.1:4401/?token=new").unwrap();
        let mut view = session_view(Page::Web, Some(login));
        let generation = accept(&mut view, "thread", true);
        assert_eq!(
            view.session.claim(generation, "D1".into()),
            granted("thread")
        );
        assert_eq!(
            view.session.claim(generation, "D2".into()),
            SessionClaim::Unavailable
        );
        assert_eq!(
            view.session.claim(generation, "D1".into()),
            granted("thread")
        );
        assert_eq!(
            wake_script("http://127.0.0.1:4400", generation, false),
            r#"if (location.origin === "http://127.0.0.1:4400") window.__codexhostOpenDesktopSession?.('1', false);"#
        );
        assert_eq!(view.connect(new_login.clone()), (new_login, None));
        assert_eq!(
            view.session.claim(generation, "D2".into()),
            SessionClaim::Unavailable
        );
        assert_eq!(
            view.session.claim(generation, "D1".into()),
            SessionClaim::Unavailable
        );
        assert_eq!(view.session.ready("D2"), SessionClaim::Unavailable);
        assert_eq!(view.session.wake_url_only(generation), None);
        assert_eq!(
            view.session.receipt(generation, "D2", false, true),
            SessionReceipt::Unavailable
        );
        assert!(view.session.stage("next".into(), true).is_none());
        assert_eq!(
            view.session.receipt(generation, "D1", false, false),
            SessionReceipt::Retry
        );
        assert!(view.session.has_claim());
        assert_eq!(
            view.session.receipt(generation, "D1", false, true),
            SessionReceipt::Confirmed
        );
        assert!(view.session.stage("next".into(), true).is_some());
    }

    #[test]
    fn candidate_preserves_the_current_target_until_dispatch_is_accepted() {
        let login = Url::parse("http://127.0.0.1:4400/?token=secret").unwrap();
        use Scheduling::{NotScheduled, Scheduled, Unknown};
        for (eval, navigate, over_gate, expected) in [
            (NotScheduled, NotScheduled, false, Admission::Rejected),
            (NotScheduled, NotScheduled, true, Admission::Unknown),
            (NotScheduled, Scheduled, true, Admission::Accepted),
            (Scheduled, NotScheduled, false, Admission::Accepted),
            (Unknown, NotScheduled, false, Admission::Unknown),
            (NotScheduled, Unknown, false, Admission::Unknown),
        ] {
            let view = Mutex::new(session_view(Page::Web, Some(login.clone())));
            let (a, b) = {
                let mut view = view.lock().unwrap();
                let a = accept(&mut view, "A", true);
                view.pending_route = Some("connect-devices");
                let b = view.session.stage("B".into(), true).unwrap();
                (a, b)
            };
            let mut woke = false;
            assert_eq!(
                dispatch_live_session(
                    &view,
                    login.clone(),
                    b,
                    || {
                        let mut view = view.lock().unwrap();
                        assert_eq!(view.session.claim(b, "page".into()), SessionClaim::Retry);
                        assert_eq!(view.pending_route, Some("connect-devices"));
                        eval
                    },
                    |url| {
                        assert_ne!(eval, Scheduled);
                        assert_eq!(
                            url.as_str(),
                            "http://127.0.0.1:4400/?session=B&desktopSessionGeneration=2"
                        );
                        let mut view = view.lock().unwrap();
                        if over_gate {
                            assert_eq!(view.session.allows_navigation(&url, true), Some(true));
                        }
                        assert_eq!(view.session.claim(b, "page".into()), SessionClaim::Retry);
                        navigate
                    },
                    || {
                        let mut view = view.lock().unwrap();
                        assert_eq!(view.session.claim(b, "page".into()), granted("B"));
                        assert_eq!(
                            view.session.claim(a, "page".into()),
                            SessionClaim::Unavailable
                        );
                        assert!(view.pending_route.is_none());
                        woke = true;
                    }
                ),
                expected
            );
            assert_eq!(woke, expected == Admission::Accepted);
            if !woke {
                let mut view = view.lock().unwrap();
                assert_eq!(view.pending_route, Some("connect-devices"));
                assert_eq!(
                    view.session.claim(b, "page".into()),
                    SessionClaim::Unavailable
                );
                assert_eq!(view.session.claim(a, "page".into()), granted("A"));
            }
        }
    }

    #[test]
    fn live_activation_does_not_supersede_a_pending_login_navigation() {
        let login = Url::parse("http://127.0.0.1:4400/?token=secret").unwrap();
        let mut view = session_view(Page::Loading(Status::Starting, None), None);
        accept(&mut view, "A", false);
        let (initial, a) = view.connect(login);
        let a = a.unwrap();
        let view = Mutex::new(view);

        assert!(matches!(
            prepare_session(&view, "B".into(), || Ok(()), || false),
            Err(Admission::Unknown)
        ));
        let mut view = view.into_inner().unwrap();
        assert_eq!(view.session.allows_navigation(&initial, true), Some(true));
        assert!(view.session.native_login_allows(10, &initial, false));
        assert!(!view.session.native_login_completed(9, Rejected));
        let redirected =
            Url::parse("http://127.0.0.1:4400/?session=A&desktopSessionGeneration=2").unwrap();
        assert_eq!(
            view.session.allows_navigation(&redirected, true),
            Some(true)
        );
        assert!(view.session.native_login_allows(10, &redirected, true));
        assert!(view.session.native_login_completed(10, Loaded));
        assert!(!view.session.login_needs_retry());
        assert_eq!(view.session.claim(a, "boot-page".into()), granted("A"));
        assert_eq!(
            view.session.receipt(a, "boot-page", false, true),
            SessionReceipt::Confirmed
        );
        assert!(view.session.stage("B".into(), true).is_some());
    }

    #[test]
    fn abandoning_an_unclaimed_login_target_does_not_cancel_auth_navigation() {
        let login = Url::parse("http://127.0.0.1:4400/?token=secret").unwrap();
        let mut view = session_view(Page::Loading(Status::Starting, None), None);
        accept(&mut view, "A", false);
        let (initial, a) = view.connect(login);
        let a = a.unwrap();
        view.session.mark_unconfirmed(a);
        assert!(matches!(
            view.session.abandon_unconfirmed(),
            Some(Abandon::Unclaimed)
        ));
        let view = Mutex::new(view);
        let Ok(SessionDispatch::Pending(b)) = prepare_session(
            &view,
            "B".into(),
            || Ok(()),
            || panic!("reuse in-flight login"),
        ) else {
            panic!("B should queue behind the original authentication");
        };
        assert_eq!(
            finish_session(&view, b, Scheduling::Scheduled),
            Admission::Accepted
        );
        let mut view = view.into_inner().unwrap();
        assert_eq!(view.session.allows_navigation(&initial, true), Some(true));
        assert!(view.session.native_login_allows(10, &initial, false));
        assert_eq!(
            view.session.claim(b, "old-page".into()),
            SessionClaim::Retry
        );
        let redirected =
            Url::parse("http://127.0.0.1:4400/?session=A&desktopSessionGeneration=2").unwrap();
        assert_eq!(
            view.session.allows_navigation(&redirected, true),
            Some(true)
        );
        assert!(view.session.native_login_allows(10, &redirected, true));
        assert!(view.session.native_login_completed(10, Loaded));
        assert_eq!(view.session.claim(b, "boot-page".into()), granted("B"));
        assert_eq!(
            view.session.claim(a, "boot-page".into()),
            SessionClaim::Unavailable
        );
        assert_eq!(
            view.session.allows_navigation(&redirected, true),
            Some(false)
        );
    }

    #[test]
    fn failed_login_allows_the_next_click_to_request_fresh_authentication() {
        let login = Url::parse("http://127.0.0.1:4400/?token=secret").unwrap();
        for end in ["canceled", "unexpected redirect", "missing callback"] {
            let mut view = session_view(Page::Loading(Status::Starting, None), None);
            accept(&mut view, "A", false);
            let (initial, a) = view.connect(login.clone());
            let a = a.unwrap();
            match end {
                "canceled" => {
                    assert!(view.session.native_login_allows(10, &initial, false));
                    assert!(view.session.native_login_completed(10, Rejected));
                }
                "unexpected redirect" => {
                    assert!(view.session.native_login_allows(10, &initial, false));
                    let unexpected = Url::parse("http://127.0.0.1:4400/wrong").unwrap();
                    assert!(!view.session.native_login_allows(10, &unexpected, true));
                    assert!(view.session.native_login_completed(10, Loaded));
                }
                _ => {
                    view.session.expire_login(a);
                    assert_eq!(view.session.allows_navigation(&initial, true), Some(true));
                }
            }
            if end != "missing callback" {
                assert_eq!(view.connect(login.clone()), (login.clone(), None));
            }
            let view = Mutex::new(view);
            let Ok(SessionDispatch::Pending(b)) = prepare_session(
                &view,
                "B".into(),
                || Ok(()),
                || {
                    view.lock().unwrap().page = Page::Loading(Status::Starting, None);
                    true
                },
            ) else {
                panic!("{end} must not block the next click");
            };
            assert_eq!(
                finish_session(&view, b, Scheduling::Scheduled),
                Admission::Accepted
            );
            let mut view = view.into_inner().unwrap();
            let (fresh, generation) = view.connect(login.clone());
            assert!(
                fresh
                    .query_pairs()
                    .any(|(name, value)| name == "session" && value == "B")
            );
            assert!(generation.is_some());
            assert_eq!(
                view.session.claim(a, "stale".into()),
                SessionClaim::Unavailable
            );
            view.session.expire_login(a);
            assert!(view.session.login_in_flight());
        }
    }

    #[test]
    fn unscheduled_first_login_reconnects_with_a_fresh_url_and_generation() {
        let login = Url::parse("http://127.0.0.1:4400/?token=fixture").unwrap();
        let fresh_login = Url::parse("http://127.0.0.1:4401/?token=fresh").unwrap();
        let mut view = session_view(Page::Loading(Status::Starting, None), None);
        accept(&mut view, "A", false);
        let (first_hop, original) = view.connect(login);
        let original = original.unwrap();
        assert!(view.session.defer_login(original));
        assert!(view.session.login_needs_retry());
        assert_eq!(
            view.session.allows_navigation(&first_hop, true),
            Some(false)
        );
        assert_eq!(
            view.session.claim(original, "old-page".into()),
            SessionClaim::Unavailable
        );

        view.session.web_disconnected();
        let (fresh, replacement) = view.connect(fresh_login);
        let replacement = replacement.unwrap();
        assert_ne!(original, replacement);
        assert_eq!(
            fresh.as_str(),
            format!(
                "http://127.0.0.1:4401/?token=fresh&session=A&desktopSessionGeneration={replacement}"
            )
        );
        assert!(!view.session.defer_login(original));
        assert_eq!(view.session.allows_navigation(&fresh, true), Some(true));
        assert_eq!(
            view.session.claim(original, "old-page".into()),
            SessionClaim::Unavailable
        );
        assert_eq!(
            view.session.claim(replacement, "new-page".into()),
            granted("A")
        );
    }

    #[test]
    fn joined_login_failure_and_service_disconnect_have_different_recovery() {
        let login = Url::parse("http://127.0.0.1:4400/?token=fixture").unwrap();
        let fresh_login = Url::parse("http://127.0.0.1:4401/?token=fresh").unwrap();
        for completion in [Some(Rejected), Some(TransportFailed), None] {
            let authentication_failed = completion == Some(Rejected);
            let mut view = session_view(Page::Loading(Status::Starting, None), None);
            accept(&mut view, "A", false);
            let (initial, a) = view.connect(login.clone());
            assert!(view.session.native_login_allows(1, &initial, false));
            let a = a.unwrap();
            let old_redirect = Url::parse(&format!(
                "http://127.0.0.1:4400/?session=A&desktopSessionGeneration={a}"
            ))
            .unwrap();
            view.session.mark_unconfirmed(a);
            assert!(matches!(
                view.session.abandon_unconfirmed(),
                Some(Abandon::Unclaimed)
            ));
            let view = Mutex::new(view);
            let Ok(SessionDispatch::Pending(b)) = prepare_session(
                &view,
                "B".into(),
                || Ok(()),
                || panic!("join existing login"),
            ) else {
                panic!("B must join the in-flight login");
            };
            assert_eq!(
                finish_session(&view, b, Scheduling::Scheduled),
                Admission::Accepted
            );
            {
                let mut view = view.lock().unwrap();
                let old_page = Url::parse("http://127.0.0.1:4400/").unwrap();
                assert!(view.accepts_session_page(&old_page));
                assert_eq!(
                    view.session.claim(b, "old-page".into()),
                    SessionClaim::Retry
                );
                if let Some(completion) = completion {
                    assert!(view.session.native_login_completed(1, completion));
                }
                view.session.web_disconnected();
                view.page = Page::Loading(Status::Reconnecting, None);
                assert!(!view.session.portable_login_loaded(&old_redirect));
                assert_eq!(view.session.ready("old-page"), SessionClaim::Unavailable);
                assert_eq!(view.session.wake_url_only(b), None);
                assert_eq!(
                    view.session.claim(b, "old-page".into()),
                    SessionClaim::Unavailable
                );
                if authentication_failed {
                    assert_eq!(
                        view.connect(fresh_login.clone()),
                        (fresh_login.clone(), None)
                    );
                }
            }

            if authentication_failed {
                let Ok(SessionDispatch::Pending(retry)) = prepare_session(
                    &view,
                    "B".into(),
                    || Ok(()),
                    || {
                        view.lock().unwrap().page = Page::Loading(Status::Starting, None);
                        true
                    },
                ) else {
                    panic!("an explicit click must request authentication");
                };
                assert_eq!(
                    finish_session(&view, retry, Scheduling::Scheduled),
                    Admission::Accepted
                );
            }
            let mut view = view.into_inner().unwrap();
            let (initial, generation) = view.connect(fresh_login.clone());
            let generation = generation.unwrap();
            assert_ne!(b, generation);
            assert_eq!(
                initial.as_str(),
                format!(
                    "http://127.0.0.1:4401/?token=fresh&session=B&desktopSessionGeneration={generation}"
                )
            );
            assert!(!view.session.portable_login_loaded(&old_redirect));
            let redirect = Url::parse(&format!(
                "http://127.0.0.1:4401/?session=B&desktopSessionGeneration={generation}"
            ))
            .unwrap();
            assert!(view.session.native_login_allows(2, &initial, false));
            assert!(view.session.native_login_allows(2, &redirect, true));
            assert!(view.session.native_login_completed(2, Loaded));
            assert_eq!(
                view.session.claim(b, "old-page".into()),
                SessionClaim::Unavailable
            );
            assert_eq!(
                view.session.claim(generation, "new-page".into()),
                granted("B")
            );
            assert_eq!(
                view.session.receipt(generation, "new-page", false, true),
                SessionReceipt::Confirmed
            );
            view.session.web_disconnected();
            assert_eq!(
                view.connect(fresh_login.clone()),
                (fresh_login.clone(), None)
            );
        }
    }

    #[test]
    fn navigation_handoff_blocks_login_redirects_but_preserves_direct_external_links() {
        let login = Url::parse("http://127.0.0.1:4400/?token=fixture").unwrap();
        let external = Url::parse("https://example.test/path").unwrap();
        let redirect =
            Url::parse("http://127.0.0.1:4400/?session=A&desktopSessionGeneration=2").unwrap();
        for expected_redirect in [false, true] {
            let mut view = session_view(Page::Loading(Status::Starting, None), None);
            accept(&mut view, "A", false);
            let (initial, _) = view.connect(login.clone());
            let view = Mutex::new(view);
            let mut opened = Vec::new();
            let mut navigate = |url, id, redirected| {
                handle_navigation(
                    &view,
                    url,
                    TopLevelNavigation::Native { id, redirected },
                    |external| opened.push(external.clone()),
                )
            };

            assert!(navigate(&initial, 1, false));
            // An unrelated direct link still goes through the browser handoff.
            assert!(!navigate(&external, 2, false));
            // No generation or session metadata from the original request survives this redirect.
            let destination = if expected_redirect {
                &redirect
            } else {
                &external
            };
            assert_eq!(navigate(destination, 1, true), expected_redirect);
            assert!(
                view.lock()
                    .unwrap()
                    .session
                    .native_login_completed(1, if expected_redirect { Loaded } else { Rejected })
            );
            // A late native redirect after the reservation is gone cannot be handed off either.
            assert!(!navigate(&external, 1, true));
            assert_eq!(opened, [external.clone()]);
        }
    }

    #[test]
    fn native_manual_sign_in_return_navigates_without_reviving_the_notification() {
        let login = Url::parse("http://127.0.0.1:4400/?token=fixture").unwrap();
        let fresh_login = Url::parse("http://127.0.0.1:4401/?token=fresh").unwrap();
        for completion in [Loaded, Rejected, TransportFailed] {
            let mut view = session_view(Page::Loading(Status::Starting, None), None);
            accept(&mut view, "thread/one", false);
            let (initial, generation) = view.connect(login.clone());
            let generation = generation.unwrap();
            let manual_return = Url::parse(&format!(
                "http://127.0.0.1:4400/?session=thread%2Fone&desktopSessionGeneration={generation}"
            ))
            .unwrap();
            let mut wrong_origin = manual_return.clone();
            wrong_origin.set_port(Some(4401)).unwrap();
            let mut wrong_path = manual_return.clone();
            wrong_path.set_path("/other");
            let view = Mutex::new(view);
            let mut opened = Vec::new();
            let mut navigate = |url, id| {
                handle_navigation(
                    &view,
                    url,
                    TopLevelNavigation::Native {
                        id,
                        redirected: false,
                    },
                    |external| opened.push(external.clone()),
                )
            };

            assert!(navigate(&initial, 1));
            assert!(
                view.lock()
                    .unwrap()
                    .session
                    .native_login_completed(1, completion)
            );
            assert!(!navigate(&wrong_origin, 2));
            assert!(!navigate(&wrong_path, 3));
            assert!(!navigate(&initial, 4));
            assert!(navigate(&manual_return, 5));
            assert!(opened.is_empty());

            let mut view = view.into_inner().unwrap();
            assert!(!view.session.native_login_completed(5, Loaded));
            assert_eq!(view.session.ready("manual-page"), SessionClaim::Unavailable);
            assert_eq!(
                view.session.claim(generation, "manual-page".into()),
                SessionClaim::Unavailable
            );
            view.session.web_disconnected();
            let (url, replacement) = view.connect(fresh_login.clone());
            if completion == TransportFailed {
                assert!(replacement.is_some_and(|replacement| replacement != generation));
            } else {
                assert_eq!((url, replacement), (fresh_login.clone(), None));
            }
        }
    }

    #[test]
    fn portable_execution_proof_resolves_once_and_keeps_a_when_b_is_not_scheduled() {
        for (result, expected, receipt, late) in [
            (Some("true"), Admission::Accepted, Some(true), None),
            (
                Some("false"),
                Admission::Rejected,
                Some(false),
                Some("true"),
            ),
            (Some("null"), Admission::Unknown, None, Some("true")),
            (None, Admission::Unknown, None, Some("false")),
        ] {
            let mut current = session_view(Page::Web, None);
            let a = accept(&mut current, "A", true);
            let b = current.session.stage("B".into(), true).unwrap();
            assert_eq!(current.session.claim(b, "page".into()), SessionClaim::Retry);
            let view = Mutex::new(current);
            let (send, receive) = mpsc::channel();
            let reply = Mutex::new(Some(send));
            let first = result.map_or(Scheduling::Unknown, portable_dispatch_scheduling);
            assert_eq!(resolve_portable_dispatch(&view, b, first, &reply), expected);
            match receipt {
                Some(accepted) => assert_eq!(receive.try_recv(), Ok(accepted)),
                None => assert_eq!(receive.try_recv(), Err(mpsc::TryRecvError::Disconnected)),
            }
            assert_eq!(
                resolve_portable_dispatch(
                    &view,
                    b,
                    late.map_or(Scheduling::Unknown, portable_dispatch_scheduling),
                    &reply,
                ),
                Admission::Unknown
            );
            assert_eq!(receive.try_recv(), Err(mpsc::TryRecvError::Disconnected));
            let mut view = view.into_inner().unwrap();
            assert_eq!(
                view.session.claim(b, "page".into()),
                if first == Scheduling::Scheduled {
                    granted("B")
                } else {
                    SessionClaim::Unavailable
                }
            );
            assert_eq!(
                view.session.claim(a, "page".into()),
                if first == Scheduling::Scheduled {
                    SessionClaim::Unavailable
                } else {
                    granted("A")
                }
            );
        }
    }

    #[test]
    fn late_admitted_navigation_can_deliver_only_the_preserved_url_target() {
        let login = Url::parse("http://127.0.0.1:4400/?token=secret").unwrap();
        let mut current = session_view(Page::Web, Some(login.clone()));
        let a = current.session.stage("A".into(), true).unwrap();
        let a_url = current.session.stage_url(a, login.clone()).unwrap();
        assert_eq!(
            current.session.finish(a, Scheduling::Scheduled),
            Admission::Accepted
        );
        assert_eq!(current.session.allows_navigation(&a_url, true), Some(true));
        assert_eq!(current.session.ready("old"), SessionClaim::Unavailable);
        let b = current.session.stage("B".into(), true).unwrap();
        let view = Mutex::new(current);
        assert_eq!(
            dispatch_live_session(
                &view,
                login,
                b,
                || Scheduling::NotScheduled,
                |url| {
                    let mut current = view.lock().unwrap();
                    assert_eq!(current.session.allows_navigation(&url, true), Some(true));
                    Scheduling::NotScheduled
                },
                || panic!("B must not wake as the committed target"),
            ),
            Admission::Unknown
        );
        let mut current = view.into_inner().unwrap();
        assert_eq!(
            current.session.claim(b, "late-document".into()),
            SessionClaim::Unavailable
        );
        assert_eq!(
            current.session.ready("late-document"),
            SessionClaim::Wake {
                generation: a.to_string()
            }
        );
        assert_eq!(current.session.wake_url_only(a), Some(false));
        assert_eq!(
            current.session.claim(a, "late-document".into()),
            granted("A")
        );
    }

    #[test]
    fn tray_route_supersedes_an_unclaimed_notification_without_reviving_it() {
        let login = Url::parse("http://127.0.0.1:4401/?token=new").unwrap();
        let mut view = session_view(Page::Web, Some(login));
        let earlier = accept(&mut view, "thread", true);
        assert_eq!(
            view.open_route("connect-devices").unwrap().as_str(),
            "http://127.0.0.1:4401/?token=new#connect-devices"
        );
        let latest = accept(&mut view, "thread", true);
        assert_eq!(
            view.session.claim(earlier, "old-document".into()),
            SessionClaim::Unavailable
        );
        assert_eq!(
            view.session.claim(latest, "new-document".into()),
            granted("thread")
        );
    }

    #[test]
    fn claimed_target_blocks_the_waiter_until_release_or_unknown_timeout() {
        let mut view = session_view(Page::Web, None);
        let generation = accept(&mut view, "A", true);
        assert_eq!(view.session.claim(generation, "D1".into()), granted("A"));
        let now = Instant::now();
        let (reply, outcome) = mpsc::channel();
        let mut waiting = Some(DeferredSession {
            session_id: "B".into(),
            reply,
            until: now + Duration::from_secs(1),
        });
        assert!(take_deferred_session(&mut waiting, view.session.has_claim(), now).is_none());
        assert_eq!(
            view.session.receipt(generation, "D1", false, true),
            SessionReceipt::Confirmed
        );
        let next = take_deferred_session(&mut waiting, view.session.has_claim(), now).unwrap();
        assert_eq!(next.session_id, "B");
        assert_eq!(outcome.try_recv(), Err(mpsc::TryRecvError::Empty));
        assert_eq!(
            view.session.claim(generation, "D1".into()),
            SessionClaim::Unavailable
        );

        let generation = accept(&mut view, "A", true);
        assert_eq!(view.session.claim(generation, "D1".into()), granted("A"));
        let (reply, outcome) = mpsc::channel();
        let mut waiting = Some(DeferredSession {
            session_id: "expired".into(),
            reply,
            until: now,
        });
        assert!(take_deferred_session(&mut waiting, view.session.has_claim(), now).is_none());
        assert_eq!(outcome.try_recv(), Err(mpsc::TryRecvError::Disconnected));
        assert_eq!(view.session.claim(generation, "D1".into()), granted("A"));
    }

    #[test]
    fn abandonment_waits_for_the_document_and_drops_already_waiting_clicks() {
        let mut view = session_view(Page::Web, None);
        let a = accept(&mut view, "A", true);
        assert_eq!(view.session.claim(a, "D1".into()), granted("A"));
        view.session.mark_unconfirmed(a);
        let view = Mutex::new(view);
        let (reply, outcome) = mpsc::channel();
        let waiting = Mutex::new(Some(DeferredSession {
            session_id: "B".into(),
            reply,
            until: Instant::now() + Duration::from_secs(1),
        }));
        assert!(matches!(
            begin_session_abandonment(&view, &waiting),
            Some(Abandon::AwaitDocument)
        ));
        assert_eq!(outcome.try_recv(), Err(mpsc::TryRecvError::Disconnected));

        let mut view = view.into_inner().unwrap();
        assert!(view.session.is_discarding());
        assert!(view.session.stage("B".into(), true).is_none());
        assert_eq!(view.session.ready("D2"), SessionClaim::Unavailable);
        assert_eq!(
            view.session.ready("D1"),
            SessionClaim::Discard {
                generation: a.to_string()
            }
        );
        assert_eq!(
            view.session.claim(a, "D1".into()),
            SessionClaim::Unavailable
        );
        assert_eq!(
            view.session.receipt(a, "D1", false, true),
            SessionReceipt::Retry
        );
        assert_eq!(
            view.session.receipt(a, "D2", true, true),
            SessionReceipt::Unavailable
        );
        assert_eq!(
            view.session.receipt(a, "D1", true, false),
            SessionReceipt::Retry
        );
        assert!(view.session.has_claim());
        assert_eq!(
            view.session.receipt(a, "D1", true, true),
            SessionReceipt::Confirmed
        );
        assert!(view.session.stage("fresh click".into(), true).is_some());
        assert!(waiting.into_inner().unwrap().is_none());
    }

    #[test]
    fn refused_sessions_do_not_replace_the_pending_target_or_dispatch() {
        let login = Url::parse("http://127.0.0.1:4400/?token=secret").unwrap();
        for page in [Page::Web, Page::Loading(Status::Starting, None)] {
            let view = Mutex::new(session_view(page, Some(login.clone())));
            accept(&mut view.lock().unwrap(), "first", false);
            assert!(matches!(
                prepare_session(
                    &view,
                    "rejected".into(),
                    || Err("window did not restore".into()),
                    || panic!("do not start Web after a window failure"),
                ),
                Err(Admission::Rejected)
            ));
            let (url, _) = view.lock().unwrap().connect(login.clone());
            assert_eq!(
                url.query_pairs()
                    .find(|(name, _)| name == "session")
                    .unwrap()
                    .1,
                "first"
            );
        }
        let view = Mutex::new(session_view(Page::Loading(Status::Error, None), None));
        assert!(matches!(
            prepare_session(
                &view,
                "rejected".into(),
                || panic!("an error page must not take over the notification"),
                || panic!("an error page declines rather than starting Web"),
            ),
            Err(Admission::Rejected)
        ));
        assert_eq!(view.lock().unwrap().connect(login.clone()), (login, None));
        let Ok(SessionDispatch::Live { generation, .. }) =
            prepare_session(&view, "accepted".into(), || Ok(()), || false)
        else {
            panic!("live session should be eligible to dispatch");
        };
        assert_eq!(
            finish_session(&view, generation, Scheduling::Scheduled),
            Admission::Accepted
        );
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
