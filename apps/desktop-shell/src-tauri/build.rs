fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "choose_surface",
            "retry",
            "open_console",
            "get_state",
            "ensure_web_access",
            "open_web_browser",
        ]),
    ))
    .expect("build Tauri desktop shell");
}
