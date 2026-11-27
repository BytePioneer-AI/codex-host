use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use url::Url;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    url: Url,
    width: u32,
    height: u32,
    position_path: PathBuf,
}

impl Options {
    fn validate(&self) -> Result<(), &'static str> {
        if self.url.scheme() != "http"
            || self.url.host_str() != Some("127.0.0.1")
            || self.url.port().is_none()
            || !self.url.username().is_empty()
            || self.url.password().is_some()
            || !(96..=640).contains(&self.width)
            || !(96..=640).contains(&self.height)
            || !self.position_path.is_absolute()
        {
            return Err("Invalid extension window options");
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
struct Position {
    x: i32,
    y: i32,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct HitRegion {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

struct HitRegions(Arc<Mutex<Option<Vec<HitRegion>>>>);

#[tauri::command]
fn extension_window_hit_regions(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, HitRegions>,
    regions: Vec<HitRegion>,
) -> Result<(), String> {
    if window.label() != "extension"
        || regions.len() > 16
        || regions.iter().any(|region| {
            [region.x, region.y, region.width, region.height]
                .iter()
                .any(|value| !value.is_finite() || *value < 0.0 || *value > 640.0)
        })
    {
        return Err("Invalid hit regions".into());
    }
    *state.0.lock().unwrap() = Some(regions);
    Ok(())
}

fn on_screen(position: Position, size: (u32, u32), screens: &[(i32, i32, u32, u32)]) -> bool {
    screens.iter().any(|&(left, top, width, height)| {
        let right = i64::from(left) + i64::from(width);
        let bottom = i64::from(top) + i64::from(height);
        i64::from(position.x) >= i64::from(left)
            && i64::from(position.y) >= i64::from(top)
            && i64::from(position.x) + i64::from(size.0) <= right
            && i64::from(position.y) + i64::from(size.1) <= bottom
    })
}

#[tauri::command]
pub(crate) fn extension_window_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "extension" {
        return Err("Invalid window".into());
    }
    window.start_dragging().map_err(|error| error.to_string())
}

pub(crate) fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = std::io::stdin().lock();
    let mut line = String::new();
    input.by_ref().take(8193).read_line(&mut line)?;
    if line.len() > 8192 {
        return Err("Extension options exceed limit".into());
    }
    let options: Options = serde_json::from_str(&line)?;
    options.validate()?;
    drop(input);
    let saved = std::fs::read(&options.position_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Position>(&bytes).ok());
    let position = Arc::new(Mutex::new(saved));
    let pending_position = position.clone();
    let target = options.url.clone();
    let allowed = target.clone();
    let webview_directory = options
        .position_path
        .parent()
        .unwrap()
        .join("window-webview");
    let hit_regions = Arc::new(Mutex::new(None::<Vec<HitRegion>>));
    let cursor_regions = hit_regions.clone();
    let app = tauri::Builder::default()
        .manage(HitRegions(hit_regions))
        .invoke_handler(tauri::generate_handler![extension_window_drag, extension_window_hit_regions])
        .on_window_event(move |window, event| {
            if window.label() == "extension" {
                if let WindowEvent::Moved(next) = event {
                    *pending_position.lock().unwrap() = Some(Position { x: next.x, y: next.y });
                }
            }
        })
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let window = WebviewWindowBuilder::new(app, "extension", WebviewUrl::External(target))
                .title("CodexHost Extension")
                .inner_size(f64::from(options.width), f64::from(options.height))
                .decorations(false).transparent(true).shadow(false)
                .always_on_top(true).skip_taskbar(true).resizable(false)
                .maximizable(false).minimizable(false).closable(false)
                .focused(false).visible(false)
                .data_directory(webview_directory)
                .initialization_script("Object.defineProperty(window,'codexhostWindow',{value:Object.freeze({startDragging:()=>window.__TAURI_INTERNALS__.invoke('extension_window_drag'),setHitRegions:regions=>window.__TAURI_INTERNALS__.invoke('extension_window_hit_regions',{regions})})});")
                .on_navigation(move |url| url.origin() == allowed.origin() && url.path() == allowed.path() && url.query() == allowed.query())
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            let monitors = window.available_monitors()?;
            let screens: Vec<_> = monitors.iter().map(|monitor| {
                let origin = monitor.position();
                let size = monitor.size();
                (origin.x, origin.y, size.width, size.height)
            }).collect();
            let size = window.outer_size()?;
            if let Some(saved) = saved.filter(|value| on_screen(*value, (size.width, size.height), &screens)) {
                window.set_position(tauri::PhysicalPosition::new(saved.x, saved.y))?;
            } else if let Some(monitor) = window.primary_monitor()? {
                let origin = monitor.position();
                let display = monitor.size();
                window.set_position(tauri::PhysicalPosition::new(
                    origin.x + display.width.saturating_sub(size.width + 24) as i32,
                    origin.y + display.height.saturating_sub(size.height + 64) as i32,
                ))?;
            }
            window.show()?;
            std::thread::spawn(move || {
                let mut ignored = false;
                while window.app_handle().get_webview_window("extension").is_some() {
                    if let (Ok(cursor), Ok(origin), Ok(scale)) = (window.cursor_position(), window.outer_position(), window.scale_factor()) {
                        let horizontal = (cursor.x - f64::from(origin.x)) / scale;
                        let vertical = (cursor.y - f64::from(origin.y)) / scale;
                        let outside = cursor_regions.lock().unwrap().as_ref().is_some_and(|regions| !regions.iter().any(|region| {
                            horizontal >= region.x && horizontal < region.x + region.width && vertical >= region.y && vertical < region.y + region.height
                        }));
                        if outside != ignored && window.set_ignore_cursor_events(outside).is_ok() { ignored = outside; }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(40));
                }
            });
            println!("ready");
            std::io::stdout().flush()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut buffer = String::new();
                while std::io::stdin().read_line(&mut buffer).is_ok_and(|read| read > 0) {
                    buffer.clear();
                }
                handle.exit(0);
            });
            Ok(())
        })
        .build(tauri::generate_context!())?;
    app.run(move |_, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(position) = *position.lock().unwrap() {
                if let Ok(bytes) = serde_json::to_vec(&position) {
                    let temporary = options.position_path.with_extension("tmp");
                    if std::fs::write(&temporary, bytes).is_ok() {
                        let _ = std::fs::rename(temporary, &options.position_path);
                    }
                }
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_window_to_loopback_and_bounded_dimensions() {
        let root = tempfile::tempdir().unwrap();
        for url in [
            "https://example.com/",
            "http://localhost:1234/",
            "file:///tmp/page",
            "http://user@127.0.0.1:1234/",
        ] {
            let options = Options {
                url: Url::parse(url).unwrap(),
                width: 240,
                height: 280,
                position_path: root.path().join("position.json"),
            };
            assert!(options.validate().is_err());
        }
        let options = Options {
            url: Url::parse("http://127.0.0.1:1234/private/").unwrap(),
            width: 240,
            height: 280,
            position_path: root.path().join("position.json"),
        };
        assert!(options.validate().is_ok());
        assert!(
            Options {
                width: 4096,
                ..options
            }
            .validate()
            .is_err()
        );
    }

    #[test]
    fn recovers_positions_when_monitors_change() {
        let screens = [(0, 0, 1920, 1080), (-1280, 0, 1280, 1024)];
        assert!(on_screen(
            Position { x: -600, y: 100 },
            (240, 280),
            &screens
        ));
        assert!(!on_screen(
            Position { x: 1900, y: 100 },
            (240, 280),
            &screens
        ));
        assert!(!on_screen(
            Position { x: -600, y: 100 },
            (240, 280),
            &screens[..1]
        ));
    }
}
