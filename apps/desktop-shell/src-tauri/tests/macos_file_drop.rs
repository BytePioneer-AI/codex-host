#![cfg(target_os = "macos")]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::Command;

#[test]
fn webkit_receives_only_the_dropped_files_after_the_source_disappears() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let work = tempfile::tempdir().unwrap();
    let fixture = work.path().join("file-drop-test");
    assert!(
        Command::new("xcrun")
            .arg("clang")
            .current_dir(root)
            .args(["-fobjc-arc", "-framework", "AppKit", "-framework", "WebKit"])
            .args(["tests/macos_file_drop.m", "src/macos_file_drop.m", "-o"])
            .arg(&fixture)
            .status()
            .unwrap()
            .success()
    );
    // A real home-volume path avoids Foundation's /var and /tmp path aliases.
    let caches = PathBuf::from(std::env::var_os("HOME").unwrap()).join("Library/Caches");
    fs::create_dir_all(&caches).unwrap();
    let home = tempfile::Builder::new()
        .prefix("codexhost-drop-test-")
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir_in(caches)
        .unwrap();
    assert!(
        Command::new(fixture)
            .env("HOME", home.path())
            .env("CFFIXED_USER_HOME", home.path())
            .status()
            .unwrap()
            .success()
    );
}
