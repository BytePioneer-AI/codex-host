use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
struct Position {
    x: i32,
    y: i32,
}

#[derive(Clone, Copy, Debug)]
struct MonitorBounds {
    left: i32,
    top: i32,
    width: u32,
    height: u32,
    scale_factor: f64,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct HitRegion {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

struct HitRegions {
    regions: Arc<Mutex<Option<Vec<HitRegion>>>>,
    click_through_supported: bool,
}

fn is_wayland_env(wayland_display: Option<&str>, session_type: Option<&str>) -> bool {
    wayland_display.is_some_and(|value| !value.trim().is_empty())
        || session_type.is_some_and(|value| value.trim().eq_ignore_ascii_case("wayland"))
}

fn click_through_supported_for(
    target_os: &str,
    wayland_display: Option<&str>,
    session_type: Option<&str>,
) -> bool {
    // Tao 0.37.x returns Ok((0, 0)) for cursor_position() on Linux Wayland instead of Err,
    // which would lock the window into permanent click-through if polled globally.
    !(target_os == "linux" && is_wayland_env(wayland_display, session_type))
}

fn click_through_supported() -> bool {
    click_through_supported_for(
        std::env::consts::OS,
        std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
    )
}

fn sanitized_scale(scale_factor: f64) -> f64 {
    if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    }
}

fn physical_window_size(logical_width: u32, logical_height: u32, scale_factor: f64) -> (u32, u32) {
    let scale = sanitized_scale(scale_factor);
    (
        (f64::from(logical_width) * scale).round().max(1.0) as u32,
        (f64::from(logical_height) * scale).round().max(1.0) as u32,
    )
}

fn on_screen(position: Position, logical_size: (u32, u32), screens: &[MonitorBounds]) -> bool {
    screens.iter().any(|screen| {
        let size = physical_window_size(logical_size.0, logical_size.1, screen.scale_factor);
        let right = i64::from(screen.left) + i64::from(screen.width);
        let bottom = i64::from(screen.top) + i64::from(screen.height);
        i64::from(position.x) >= i64::from(screen.left)
            && i64::from(position.y) >= i64::from(screen.top)
            && i64::from(position.x) + i64::from(size.0) <= right
            && i64::from(position.y) + i64::from(size.1) <= bottom
    })
}

fn resolve_initial_position(
    saved: Option<Position>,
    logical_size: (u32, u32),
    screens: &[MonitorBounds],
    primary: Option<MonitorBounds>,
) -> Option<Position> {
    if let Some(saved) = saved.filter(|value| on_screen(*value, logical_size, screens)) {
        return Some(saved);
    }
    let monitor = primary.or_else(|| screens.first().copied())?;
    let scale = sanitized_scale(monitor.scale_factor);
    let size = physical_window_size(logical_size.0, logical_size.1, scale);
    let right_margin = (24.0 * scale).round() as u32;
    let bottom_margin = (64.0 * scale).round() as u32;
    Some(Position {
        x: monitor.left
            + monitor
                .width
                .saturating_sub(size.0.saturating_add(right_margin)) as i32,
        y: monitor.top
            + monitor
                .height
                .saturating_sub(size.1.saturating_add(bottom_margin)) as i32,
    })
}

fn initialization_script(click_through_supported: bool) -> String {
    format!(
        "Object.defineProperty(window,'codexhostWindow',{{value:Object.freeze({{clickThroughSupported:{click_through_supported},startDragging:()=>window.__TAURI_INTERNALS__.invoke('extension_window_drag'),setHitRegions:regions=>window.__TAURI_INTERNALS__.invoke('extension_window_hit_regions',{{regions}})}})}});"
    )
}

#[tauri::command]
fn extension_window_hit_regions(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, HitRegions>,
    regions: Vec<HitRegion>,
) -> Result<bool, String> {
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
    if !state.click_through_supported {
        return Ok(false);
    }
    *state.regions.lock().unwrap() = Some(regions);
    Ok(true)
}

#[tauri::command]
pub(crate) fn extension_window_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "extension" {
        return Err("Invalid window".into());
    }
    window.start_dragging().map_err(|error| error.to_string())
}

pub(crate) fn run() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args_os().len() != 2 {
        return Err("Usage: codexhost-shell --extension-window".into());
    }
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
    let shown = Arc::new(AtomicBool::new(false));
    let shown_for_events = shown.clone();
    let target = options.url.clone();
    let allowed = target.clone();
    let webview_directory = options
        .position_path
        .parent()
        .ok_or("Extension position path has no parent directory")?
        .join("window-webview");
    let supports_click_through = click_through_supported();
    let hit_regions = Arc::new(Mutex::new(None::<Vec<HitRegion>>));
    let cursor_regions = hit_regions.clone();
    let logical_size = (options.width, options.height);
    let app = tauri::Builder::default()
        .manage(HitRegions {
            regions: hit_regions,
            click_through_supported: supports_click_through,
        })
        .invoke_handler(tauri::generate_handler![
            extension_window_drag,
            extension_window_hit_regions
        ])
        .on_window_event(move |window, event| {
            if window.label() == "extension" && shown_for_events.load(Ordering::Acquire) {
                if let WindowEvent::Moved(next) = event {
                    *pending_position.lock().unwrap() = Some(Position {
                        x: next.x,
                        y: next.y,
                    });
                }
            }
        })
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let window = WebviewWindowBuilder::new(app, "extension", WebviewUrl::External(target))
                .title("CodexHost Extension")
                .inner_size(f64::from(options.width), f64::from(options.height))
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .closable(false)
                .focused(false)
                .visible(false)
                .data_directory(webview_directory)
                .initialization_script(initialization_script(supports_click_through))
                .on_navigation(move |url| {
                    url.origin() == allowed.origin()
                        && url.path() == allowed.path()
                        && url.query() == allowed.query()
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            let to_bounds = |monitor: &tauri::Monitor| {
                let origin = monitor.position();
                let size = monitor.size();
                MonitorBounds {
                    left: origin.x,
                    top: origin.y,
                    width: size.width,
                    height: size.height,
                    scale_factor: monitor.scale_factor(),
                }
            };
            let monitors = window.available_monitors()?;
            let screens: Vec<_> = monitors.iter().map(&to_bounds).collect();
            let primary = window.primary_monitor()?.as_ref().map(&to_bounds);
            // Compute initial placement from configured logical dimensions and monitor scale
            // rather than outer_size(), which can report 0x0 on hidden Linux/GTK windows.
            if let Some(initial) = resolve_initial_position(saved, logical_size, &screens, primary)
            {
                window.set_position(tauri::PhysicalPosition::new(initial.x, initial.y))?;
            }
            window.show()?;
            shown.store(true, Ordering::Release);
            if supports_click_through {
                std::thread::spawn(move || {
                    let mut ignored = false;
                    while window
                        .app_handle()
                        .get_webview_window("extension")
                        .is_some()
                    {
                        if let (Ok(cursor), Ok(origin), Ok(scale)) = (
                            window.cursor_position(),
                            window.outer_position(),
                            window.scale_factor(),
                        ) {
                            let scale = sanitized_scale(scale);
                            let horizontal = (cursor.x - f64::from(origin.x)) / scale;
                            let vertical = (cursor.y - f64::from(origin.y)) / scale;
                            let outside =
                                cursor_regions
                                    .lock()
                                    .unwrap()
                                    .as_ref()
                                    .is_some_and(|regions| {
                                        !regions.iter().any(|region| {
                                            horizontal >= region.x
                                                && horizontal < region.x + region.width
                                                && vertical >= region.y
                                                && vertical < region.y + region.height
                                        })
                                    });
                            if outside != ignored
                                && window.set_ignore_cursor_events(outside).is_ok()
                            {
                                ignored = outside;
                            }
                        }
                        std::thread::sleep(std::time::Duration::from_millis(40));
                    }
                });
            }
            println!("ready");
            std::io::stdout().flush()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut buffer = String::new();
                while std::io::stdin()
                    .read_line(&mut buffer)
                    .is_ok_and(|read| read > 0)
                {
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
        let screens = [
            MonitorBounds {
                left: 0,
                top: 0,
                width: 1920,
                height: 1080,
                scale_factor: 1.0,
            },
            MonitorBounds {
                left: -1280,
                top: 0,
                width: 1280,
                height: 1024,
                scale_factor: 1.0,
            },
        ];
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

    #[test]
    fn computes_initial_position_from_logical_size_and_scale_factor() {
        let hidpi = MonitorBounds {
            left: 100,
            top: 50,
            width: 3840,
            height: 2160,
            scale_factor: 2.0,
        };
        let screens = [hidpi];
        // Physical size for 240x280 at 2x is 480x560; margins are 48x128.
        assert_eq!(
            resolve_initial_position(None, (240, 280), &screens, Some(hidpi)),
            Some(Position {
                x: 100 + (3840 - 480 - 48),
                y: 50 + (2160 - 560 - 128),
            })
        );
        // Saved position that clips at 2x scale must fall back to default placement.
        assert_eq!(
            resolve_initial_position(
                Some(Position { x: 3600, y: 100 }),
                (240, 280),
                &screens,
                Some(hidpi),
            ),
            Some(Position {
                x: 100 + (3840 - 480 - 48),
                y: 50 + (2160 - 560 - 128),
            })
        );
        // Valid saved position inside monitor bounds is preserved.
        assert_eq!(
            resolve_initial_position(
                Some(Position { x: 500, y: 400 }),
                (240, 280),
                &screens,
                Some(hidpi),
            ),
            Some(Position { x: 500, y: 400 })
        );
    }

    #[test]
    fn disables_click_through_on_linux_wayland_only() {
        assert!(!click_through_supported_for(
            "linux",
            Some("wayland-0"),
            None
        ));
        assert!(!click_through_supported_for("linux", None, Some("wayland")));
        assert!(!click_through_supported_for(
            "linux",
            Some(""),
            Some("Wayland")
        ));
        assert!(click_through_supported_for("linux", None, Some("x11")));
        assert!(click_through_supported_for(
            "linux",
            Some("  "),
            Some("x11")
        ));
        assert!(click_through_supported_for(
            "macos",
            Some("wayland-0"),
            Some("wayland")
        ));
        assert!(click_through_supported_for(
            "windows",
            Some("wayland-0"),
            Some("wayland")
        ));
        assert!(initialization_script(false).contains("clickThroughSupported:false"));
        assert!(initialization_script(true).contains("clickThroughSupported:true"));
    }
}
