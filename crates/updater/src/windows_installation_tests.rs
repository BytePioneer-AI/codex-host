use super::*;
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture {
    root: PathBuf,
    npm: NpmInstallation,
}
fn file(path: &Path, contents: impl AsRef<[u8]>) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}
impl Fixture {
    fn new(nested: bool) -> Self {
        let root = std::env::temp_dir().join(format!(
            "codexhost-归属 空格-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let prefix = root.join("prefix-one");
        let cli = prefix.join("node_modules/@codexhost/cli");
        let platform = if nested {
            cli.join("node_modules/@codexhost/cli-win32-x64")
        } else {
            prefix.join("node_modules/@codexhost/cli-win32-x64")
        };
        file(&cli.join("package.json"), json!({"name":"@codexhost/cli","version":"1.2.3","bin":{"codexhost":"bin/codexhost.js"},"optionalDependencies":{"@codexhost/cli-win32-x64":"1.2.3"}}).to_string());
        file(&cli.join("bin/codexhost.js"), "fixture");
        file(&platform.join("package.json"), json!({"name":"@codexhost/cli-win32-x64","version":"1.2.3","os":["win32"],"cpu":["x64"]}).to_string());
        file(&platform.join("app/codexhost-distribution.json"), json!({"schemaVersion":1,"version":"1.2.3","distribution":"npm","target":"windows-x64"}).to_string());
        file(&platform.join("bin/codexhost.exe"), "fixture");
        file(
            &prefix.join("codexhost.cmd"),
            "\"%dp0%\\node_modules\\@codexhost\\cli\\bin\\codexhost.js\"",
        );
        file(&root.join("system-node/node.exe"), "fixture");
        file(
            &root.join("system-node/node_modules/npm/bin/npm-cli.js"),
            "fixture",
        );
        file(
            &root.join("system-node/node_modules/npm/package.json"),
            r#"{"name":"npm"}"#,
        );
        Self {
            npm: NpmInstallation {
                node_path: root.join("system-node/node.exe"),
                npm_cli_path: root.join("system-node/node_modules/npm/bin/npm-cli.js"),
                npm_launcher_path: cli.join("bin/codexhost.js"),
                prefix: Some(prefix),
                package_root: Some(platform),
                installed_version: Some("1.2.3".into()),
                prepared: None,
                recovery: None,
            },
            root,
        }
    }
    fn validate(&self) -> Result<(), Box<dyn Error>> {
        validate_npm(&self.npm, "x64", &self.npm.node_path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[test]
fn accepts_nested_and_hoisted_packages_in_the_original_prefix() {
    for nested in [false, true] {
        let f = Fixture::new(nested);
        f.validate().unwrap();
        validate_npm(
            &f.npm,
            "x64",
            &f.npm
                .package_root
                .as_ref()
                .unwrap()
                .join("bin/codexhost.exe"),
        )
        .unwrap();
    }
}
#[test]
fn rejects_another_prefix_wrong_version_architecture_or_missing_identity() {
    let mut f = Fixture::new(false);
    assert!(validate_npm(&f.npm, "arm64", &f.npm.node_path).is_err());
    let prefix = f.npm.prefix.clone();
    f.npm.prefix = Some(f.root.join("prefix-two"));
    assert!(f.validate().is_err());
    f.npm.prefix = prefix;
    f.npm.installed_version = Some("1.2.4".into());
    assert!(f.validate().is_err());
    f.npm.installed_version = None;
    assert!(f.validate().is_err());
}
#[test]
fn rejects_an_unrelated_owner_and_a_non_global_layout() {
    let f = Fixture::new(false);
    let other = f.root.join("other/node.exe");
    file(&other, "unrelated");
    assert!(validate_npm(&f.npm, "x64", &other).is_err());
    fs::remove_file(f.npm.prefix.as_ref().unwrap().join("codexhost.cmd")).unwrap();
    assert!(f.validate().is_err());
}
#[cfg(unix)]
#[test]
fn rejects_linked_package_ancestors() {
    let f = Fixture::new(false);
    let scope = f
        .npm
        .prefix
        .as_ref()
        .unwrap()
        .join("node_modules/@codexhost");
    let outside = f.root.join("linked-scope");
    fs::rename(&scope, &outside).unwrap();
    std::os::unix::fs::symlink(&outside, &scope).unwrap();
    assert!(f.validate().is_err());
}
#[cfg(target_os = "windows")]
#[test]
fn windows_accepts_case_variation_and_rejects_package_junctions() {
    let mut f = Fixture::new(false);
    f.npm.prefix = Some(PathBuf::from(
        f.npm
            .prefix
            .as_ref()
            .unwrap()
            .to_string_lossy()
            .to_uppercase(),
    ));
    f.validate().unwrap();
    let scope = f
        .npm
        .prefix
        .as_ref()
        .unwrap()
        .join("node_modules/@codexhost");
    let outside = f.root.join("linked-scope");
    fs::rename(&scope, &outside).unwrap();
    let status = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&scope)
        .arg(&outside)
        .status()
        .unwrap();
    assert!(status.success());
    assert!(f.validate().is_err());
    fs::remove_dir(&scope).unwrap();
}
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
#[test]
fn windows_request_parsing_rejects_legacy_or_incomplete_ownership_fields() {
    let f = Fixture::new(false);
    let path = f.root.join("request.json");
    let mut value = json!({ "schema_version": 1, "version": "1.2.4", "wait_pid": 123456789,
        "wait_executable": f.npm.node_path, "wait_started_at_micros": "123456789", "runtime_descriptor_path": f.root.join("runtime.json"), "status_path": f.root.join("status.json"),
        "installation": { "kind": "npm", "node_path": f.npm.node_path, "npm_cli_path": f.npm.npm_cli_path, "npm_launcher_path": f.npm.npm_launcher_path,
            "prefix": f.npm.prefix, "package_root": f.npm.package_root, "installed_version": "1.2.3" } });
    use sha2::Digest;
    let digest = format!("{:x}", sha2::Sha256::digest(b"fixture"));
    for (key, name) in [("prepared", "npm"), ("recovery", "npm-previous")] {
        let directory = f.root.join(name);
        fs::create_dir_all(directory.join("cache")).unwrap();
        for name in ["cli.tgz", "platform.tgz"] {
            file(&directory.join(name), b"fixture");
        }
        for name in ["user.npmrc", "global.npmrc"] {
            file(&directory.join(name), b"");
        }
        value["installation"][key] = json!({ "unpacked_bytes":1024, "cache_path": directory.join("cache"), "user_config_path": directory.join("user.npmrc"), "global_config_path": directory.join("global.npmrc"),
            "cli": { "path": directory.join("cli.tgz"), "sha256": digest }, "platform": { "path": directory.join("platform.tgz"), "sha256": digest } });
    }
    file(&path, value.to_string());
    crate::request::UpdateRequest::parse(&path).unwrap();
    value["installation"]
        .as_object_mut()
        .unwrap()
        .remove("prefix");
    file(&path, value.to_string());
    assert!(
        crate::request::UpdateRequest::parse(&path)
            .unwrap_err()
            .to_string()
            .contains("prefix")
    );
    value["installation"]["prefix"] = json!(f.npm.prefix);
    value
        .as_object_mut()
        .unwrap()
        .remove("wait_started_at_micros");
    file(&path, value.to_string());
    assert!(
        crate::request::UpdateRequest::parse(&path)
            .unwrap_err()
            .to_string()
            .contains("creation time")
    );
}

#[cfg(target_os = "windows")]
#[test]
fn refuses_unverified_installer_recovery_before_handoff() {
    let f = Fixture::new(false);
    let root = f.root.join("installer");
    file(&root.join("app/codexhost-distribution.json"), json!({"schemaVersion":1,"version":"1.2.3","distribution":"installer","target":format!("windows-{}", super::architecture())}).to_string());
    file(&root.join("bin/codexhost.exe"), "fixture");
    file(&root.join("runtime/node.exe"), "fixture");
    let artifact = f.root.join("new.exe");
    file(&artifact, "fixture");
    let request = f.root.join("request.json");
    file(&request, json!({"schema_version":1,"version":"1.2.4","wait_pid":123456,"wait_executable":root.join("bin/codexhost.exe"),"wait_started_at_micros":"123456789", "runtime_descriptor_path":f.root.join("runtime.json"),"status_path":f.root.join("status.json"),
        "installation":{"kind":"windows-installer","installer_path":artifact,"artifact_sha256":"ab".repeat(32),"install_root":root,"installed_version":"1.2.3"}}).to_string());
    assert!(
        crate::request::UpdateRequest::parse(&request)
            .unwrap_err()
            .to_string()
            .contains("file-recovery capability")
    );
    assert!(!f.root.join("status.json").exists());
}

#[test]
fn verifies_both_native_npm_manifests_after_target_or_old_version_installation() {
    let f = Fixture::new(false);
    crate::install::verify_npm_target(f.npm.prefix.as_ref().unwrap(), "1.2.3", "x64").unwrap();
    file(
        &f.npm.package_root.as_ref().unwrap().join("package.json"),
        json!({"name":"@codexhost/cli-win32-x64","version":"1.2.4"}).to_string(),
    );
    assert!(
        crate::install::verify_npm_target(f.npm.prefix.as_ref().unwrap(), "1.2.3", "x64").is_err()
    );
}

#[test]
fn installer_identity_and_dir_are_fixed_to_the_running_installation() {
    let f = Fixture::new(false);
    let install = f.root.join("Programs/中文 安装");
    file(&install.join("app/codexhost-distribution.json"), json!({"schemaVersion":1,"version":"1.2.3","distribution":"installer","target":"windows-x64"}).to_string());
    file(&install.join("bin/codexhost.exe"), "fixture");
    file(&install.join("runtime/node.exe"), "fixture");
    let windows = WindowsInstallation {
        installer_path: f.root.join("prepared.exe"),
        artifact_sha256: "ab".repeat(32),
        install_root: install.clone(),
        recovery: None,
        installed_version: Some("1.2.3".into()),
    };
    validate_installer(&windows, "x64", &install.join("bin/codexhost.exe")).unwrap();
    assert!(validate_installer(&windows, "arm64", &install.join("bin/codexhost.exe")).is_err());
    assert!(validate_installer(&windows, "x64", &f.npm.node_path).is_err());
    let arguments = crate::install::windows_installer_arguments(&windows);
    assert!(arguments.contains(&"/NOCLOSEAPPLICATIONS".into()));
    assert!(arguments.contains(&"/NORESTARTAPPLICATIONS".into()));
    assert!(
        !arguments
            .iter()
            .any(|arg| arg == "/CLOSEAPPLICATIONS" || arg == "/RESTARTAPPLICATIONS")
    );
    assert_eq!(
        arguments.last().unwrap(),
        &std::ffi::OsString::from(format!("/DIR={}", install.display()))
    );
}
