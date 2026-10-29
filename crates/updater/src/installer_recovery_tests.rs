use super::*;
use sha2::{Digest, Sha256};
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
struct Fixture {
    root: PathBuf,
    operation: PathBuf,
    windows: WindowsInstallation,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn write(file: &Path, bytes: impl AsRef<[u8]>) {
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, bytes).unwrap();
}
fn manifest(version: &str, extra: bool) -> String {
    let mut files = vec![
        "bin/codexhost.exe",
        "runtime/node.exe",
        "libexec/codexhost-updater.exe",
        "app/host-runtime.mjs",
        "app/codexhost-distribution.json",
    ];
    if extra {
        files.push("app/plugins/new-bundled/plugin.mjs");
    }
    format!(
        "codexhost-inno-files-v1\n{version}\nwindows-x64\n{}\n",
        files
            .iter()
            .map(|p| format!("{} 3 {p}", hash(b"old")))
            .collect::<Vec<_>>()
            .join("\n")
    )
}
impl Fixture {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "inno-owned-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let operation = root.join("operation");
        let install = root.join("install");
        let old = manifest("1.2.3", false);
        let next = manifest("1.2.4", true);
        for f in installer_files::parse(old.clone()).unwrap().files {
            write(&install.join(f.path), b"old");
        }
        write(&install.join(installer_files::MARKER), &old);
        let oldexe = operation.join("previous.exe");
        let newexe = operation.join("update.exe");
        write(&oldexe, b"oldInno");
        write(&newexe, b"newInno");
        let oldjson =
            serde_json::json!({"schemaVersion":1,"installerSha256":hash(b"oldInno"),"files":old})
                .to_string();
        let newjson =
            serde_json::json!({"schemaVersion":1,"installerSha256":hash(b"newInno"),"files":next})
                .to_string();
        write(&operation.join("previous-installer.json"), &oldjson);
        write(&operation.join("target-installer.json"), &newjson);
        write(&operation.join("previous-files.txt"), old);
        write(&operation.join("replacement-files.txt"), next);
        let windows = WindowsInstallation {
            installer_path: newexe,
            artifact_sha256: hash(b"newInno"),
            install_root: install,
            installed_version: Some("1.2.3".into()),
            recovery: Some(Box::new(Materials {
                installer_path: oldexe,
                artifact_sha256: hash(b"oldInno"),
                manifest_path: operation.join("previous-installer.json"),
                manifest_sha256: hash(oldjson.as_bytes()),
                target_manifest_path: operation.join("target-installer.json"),
                target_manifest_sha256: hash(newjson.as_bytes()),
                replacement_files_path: operation.join("replacement-files.txt"),
                protected_roots: vec![root.join("user-data")],
            })),
        };
        Self {
            root,
            operation,
            windows,
        }
    }
}
#[test]
fn exact_original_materials_and_unknown_user_plugins_are_preserved_by_preflight() {
    let f = Fixture::new();
    let user = f
        .windows
        .install_root
        .join("app/plugins/user-plugin/state.json");
    write(&user, b"user-data");
    preflight(&f.windows, &f.operation, "1.2.4", "x64").unwrap();
    assert_eq!(fs::read(user).unwrap(), b"user-data");
    assert!(
        replacement_argument(&f.operation.join("replacement-files.txt"))
            .to_string_lossy()
            .starts_with("/CODEXHOSTREPLACEFILES=")
    );
}
#[test]
fn refuses_user_collision_overlap_modified_bundles_and_material_tampering() {
    for condition in [
        "collision",
        "overlap",
        "modified",
        "tampered",
        "missing-old-capability",
        "hardlink",
    ] {
        let mut f = Fixture::new();
        match condition {
            "collision" => write(
                &f.windows
                    .install_root
                    .join("app/plugins/new-bundled/plugin.mjs"),
                b"user plugin",
            ),
            "overlap" => f
                .windows
                .recovery
                .as_mut()
                .unwrap()
                .protected_roots
                .push(f.windows.install_root.join("app/plugins")),
            "modified" => write(
                &f.windows.install_root.join("app/host-runtime.mjs"),
                b"user edit",
            ),
            "tampered" => write(&f.operation.join("previous.exe"), b"bad"),
            "hardlink" => fs::hard_link(
                f.windows.install_root.join("app/host-runtime.mjs"),
                f.root.join("user-alias"),
            )
            .unwrap(),
            _ => {
                f.windows.recovery = None;
            }
        }
        assert!(
            preflight(&f.windows, &f.operation, "1.2.4", "x64").is_err(),
            "accepted {condition}"
        );
    }
}
#[test]
fn restore_verification_rejects_leftover_new_software_even_with_old_version() {
    let f = Fixture::new();
    let (old, next) = manifests(&f.windows, &f.operation, "1.2.4", "x64").unwrap();
    verify_files(&f.windows.install_root, &old, &next).unwrap();
    write(
        &f.windows
            .install_root
            .join("app/plugins/new-bundled/plugin.mjs"),
        b"old",
    );
    assert!(verify_files(&f.windows.install_root, &old, &next).is_err());
    assert!(verify_target(&f.windows, &f.operation, "1.2.4", "x64").is_err());
}
#[test]
fn rejects_ambiguous_and_escaping_paths_and_unknown_capability() {
    for name in [
        "app/../user",
        "app/CON.txt",
        "app/x.",
        "user/data",
        "app/a:stream",
    ] {
        let text = manifest("1.2.3", false).replace("app/host-runtime.mjs", name);
        assert!(installer_files::parse(text).is_err(), "accepted {name}");
    }
    let f = Fixture::new();
    write(
        &f.windows.install_root.join(installer_files::MARKER),
        b"legacy",
    );
    assert!(preflight(&f.windows, &f.operation, "1.2.4", "x64").is_err());
    let failure = ToolFailure {
        tool_stopped: false,
        restart_pending: false,
        message: "unknown".into(),
    };
    assert!(!failure.tool_stopped);
    assert!(!failure.restart_pending);
    assert_eq!(failure.to_string(), "unknown");
    assert!(!failure.may_restore());
    let mut failure = ToolFailure {
        tool_stopped: true,
        restart_pending: true,
        message: "pending OS writes".into(),
    };
    assert!(!failure.may_restore());
    failure.restart_pending = false;
    assert!(failure.may_restore());
}
