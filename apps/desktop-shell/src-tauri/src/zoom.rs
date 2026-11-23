use tauri::WebviewWindow;
use webview2_com::ZoomFactorChangedEventHandler;

pub fn install(window: &WebviewWindow) -> tauri::Result<()> {
    let window_for_event = window.clone();
    window.with_webview(move |webview| {
        let controller = webview.controller();
        let handler = ZoomFactorChangedEventHandler::create(Box::new(move |sender, _| {
            let Some(sender) = sender else {
                return Ok(());
            };
            let mut factor = 1.0;
            unsafe { sender.ZoomFactor(&mut factor)? };
            let percent = (factor * 100.0).round() as u32;
            let _ = window_for_event.eval(&format!(
                "window.__codexhostShowZoom?.({percent})"
            ));
            Ok(())
        }));
        let mut token = 0_i64;
        if let Err(error) = unsafe { controller.add_ZoomFactorChanged(&handler, &mut token) } {
            codexhost_platform::show_error_dialog(&format!(
                "Could not observe CodexHost zoom changes: {error}"
            ));
        }
    })
}
