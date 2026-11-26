use std::sync::{Arc, Mutex};
use std::thread::{self, ThreadId};

use tauri::WebviewWindow;
use webview2_com::{
    CoTaskMemPWSTR, ExecuteScriptCompletedHandler, Microsoft::Web::WebView2::Win32::ICoreWebView2,
    NavigationCompletedEventHandler, NavigationStartingEventHandler,
};
use windows_core::{BOOL, HSTRING, PWSTR};

use crate::session_activation::Scheduling;

struct NativeCall {
    thread: ThreadId,
    result: Arc<Mutex<Scheduling>>,
}

impl NativeCall {
    fn observe(dispatch: impl FnOnce(Self)) -> Scheduling {
        let result = Arc::new(Mutex::new(Scheduling::Unknown));
        dispatch(Self {
            thread: thread::current().id(),
            result: result.clone(),
        });
        *result.lock().unwrap()
    }

    fn run(self, operation: impl FnOnce() -> windows_core::Result<()>) {
        // Wry runs with_webview inline on its UI thread. A deferred callback
        // cannot report a synchronous result and must not dispatch the action.
        if self.thread != thread::current().id() {
            return;
        }
        *self.result.lock().unwrap() = match operation() {
            Ok(()) => Scheduling::Scheduled,
            Err(_) => Scheduling::NotScheduled,
        };
    }
}

fn schedule(
    window: &WebviewWindow,
    operation: impl FnOnce(ICoreWebView2) -> windows_core::Result<()> + Send + 'static,
) -> Scheduling {
    NativeCall::observe(|call| {
        let _ = window.with_webview(move |webview| {
            // The platform handle is used only in Wry's main-thread callback.
            call.run(|| unsafe { webview.controller().CoreWebView2().and_then(operation) });
        });
    })
}

pub(super) fn eval(window: &WebviewWindow, script: String) -> Scheduling {
    schedule(window, move |webview| {
        let script = HSTRING::from(script);
        let done = ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(())));
        unsafe { webview.ExecuteScript(&script, &done) }
    })
}

pub(super) fn navigate(window: &WebviewWindow, url: url::Url) -> Scheduling {
    schedule(window, move |webview| {
        let url = HSTRING::from(url.as_str());
        unsafe { webview.Navigate(&url) }
    })
}

pub(super) fn observe_navigation(
    window: &WebviewWindow,
    allow: impl Fn(u64, &url::Url, bool) -> bool + Send + 'static,
    completed: impl Fn(u64, bool) + Send + Sync + 'static,
) -> Scheduling {
    schedule(window, move |webview| unsafe {
        let completed = Arc::new(completed);
        let canceled = completed.clone();
        let mut token = 0;
        webview.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut id = 0;
                    let mut uri = PWSTR::null();
                    let mut redirected = BOOL::default();
                    let identified = args.NavigationId(&mut id).is_ok()
                        && args.IsRedirected(&mut redirected).is_ok()
                        && args.Uri(&mut uri).is_ok();
                    let uri = CoTaskMemPWSTR::from(uri);
                    if !identified
                        || !url::Url::parse(&uri.to_string())
                            .is_ok_and(|url| allow(id, &url, redirected.as_bool()))
                    {
                        args.SetCancel(true)?;
                        canceled(id, false);
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;
        webview.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut id = 0;
                    let mut succeeded = BOOL::default();
                    args.NavigationId(&mut id)?;
                    args.IsSuccess(&mut succeeded)?;
                    completed(id, succeeded.as_bool());
                }
                Ok(())
            })),
            &mut token,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_hresult_takes_precedence_over_the_dispatcher() {
        let fail = windows_core::HRESULT(0x80004005_u32 as i32);
        assert_eq!(
            NativeCall::observe(|call| call.run(|| fail.ok())),
            Scheduling::NotScheduled
        );
        assert_eq!(
            NativeCall::observe(|call| call.run(|| windows_core::HRESULT(0).ok())),
            Scheduling::Scheduled
        );
        assert_eq!(NativeCall::observe(drop), Scheduling::Unknown);
        assert_eq!(
            NativeCall::observe(|call| {
                thread::spawn(|| call.run(|| panic!("do not dispatch from a deferred callback")))
                    .join()
                    .unwrap();
            }),
            Scheduling::Unknown
        );
    }
}
