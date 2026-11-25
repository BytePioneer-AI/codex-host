fn main() {
    // Unbundled macOS debug runs (`npm start app`) need an embedded Info.plist
    // so WKWebView exposes `navigator.mediaDevices` for voice input.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
        && std::env::var("PROFILE").as_deref() == Ok("debug")
    {
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
        let plist = std::path::Path::new(&manifest_dir).join("Info.plist");
        println!("cargo:rerun-if-changed={}", plist.display());
        println!("cargo:rustc-link-arg-bin=codexhost-shell=-Wl,-sectcreate");
        println!("cargo:rustc-link-arg-bin=codexhost-shell=-Wl,__TEXT");
        println!("cargo:rustc-link-arg-bin=codexhost-shell=-Wl,__info_plist");
        println!(
            "cargo:rustc-link-arg-bin=codexhost-shell=-Wl,{}",
            plist.display()
        );
    }

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
