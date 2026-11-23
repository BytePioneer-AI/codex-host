use std::{fs, path::Path};

use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;
use webview2_com::ZoomFactorChangedEventHandler;

const FILE: &str = "shell-zoom-v1.json";

#[derive(Deserialize, Serialize)]
struct StoredZoom {
    factor: f64,
}

fn load(data_dir: &Path) -> f64 {
    fs::read(data_dir.join(FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<StoredZoom>(&bytes).ok())
        .map(|stored| stored.factor)
        .filter(|factor| factor.is_finite())
        .unwrap_or(1.0)
        .clamp(0.25, 5.0)
}

fn save(data_dir: &Path, factor: f64) {
    if let Ok(json) = serde_json::to_vec(&StoredZoom { factor }) {
        let _ = fs::write(data_dir.join(FILE), json);
    }
}

pub fn install(window: &WebviewWindow, data_dir: &Path) -> tauri::Result<()> {
    let window_for_event = window.clone();
    let data_dir = data_dir.to_path_buf();
    window.with_webview(move |webview| {
        let controller = webview.controller();
        let restored = load(&data_dir);
        if restored != 1.0 && let Err(error) = unsafe { controller.SetZoomFactor(restored) } {
            codexhost_platform::show_error_dialog(&format!(
                "Could not restore CodexHost zoom: {error}"
            ));
        }
        let handler = ZoomFactorChangedEventHandler::create(Box::new(move |sender, _| {
            let Some(sender) = sender else {
                return Ok(());
            };
            let mut factor = 1.0;
            unsafe { sender.ZoomFactor(&mut factor)? };
            save(&data_dir, factor);
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
