fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "choose_surface",
            "retry",
            "open_console",
            "get_state",
            "ensure_web_access",
            "open_web_browser",
            "window_start_dragging",
            "window_minimize",
            "window_toggle_maximize",
            "window_close",
            "window_chrome_state",
        ]),
    ))
    .expect("build Tauri desktop shell");
}
