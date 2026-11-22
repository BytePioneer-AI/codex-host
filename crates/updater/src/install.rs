#[cfg(target_os = "macos")]
use std::env;
use std::error::Error;
use std::fs;
use std::fs::File;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::io::Read;
use std::path::Path;
use std::process::Command;

use codexhost_platform::configure_background_command;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use serde::Deserialize;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use sha2::{Digest, Sha256};

#[cfg(any(target_os = "windows", target_os = "macos"))]
use crate::request::validate_version;
use crate::request::{
    Installation, MacOsInstallation, NpmInstallation, UpdateRequest, WindowsInstallation,
};
#[cfg(target_os = "macos")]
use crate::status::unix_seconds;

const NPM_PACKAGE_NAME: &str = "@codexhost/cli";
#[cfg(any(target_os = "windows", target_os = "macos"))]
const DISTRIBUTION_FILE: &str = "codexhost-distribution.json";

#[cfg(any(target_os = "windows", target_os = "macos"))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DistributionMetadata {
    schema_version: u8,
    version: String,
    distribution: String,
    target: String,
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn sha256_file(path: &Path) -> Result<String, Box<dyn Error>> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn verify_artifact(path: &Path, expected: &str) -> Result<(), Box<dyn Error>> {
    let actual = sha256_file(path)?;
    if actual != expected {
        return Err(
            format!("update artifact SHA-256 mismatch: expected {expected}, got {actual}").into(),
        );
    }
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn distribution_metadata(path: &Path) -> Result<DistributionMetadata, Box<dyn Error>> {
    let metadata = serde_json::from_slice::<DistributionMetadata>(&fs::read(path)?)?;
    if metadata.schema_version != 1 || metadata.target.is_empty() {
        return Err("installed distribution metadata is invalid".into());
    }
    validate_version(&metadata.version)?;
    Ok(metadata)
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn verify_distribution(
    path: &Path,
    version: &str,
    expected_distribution: &str,
) -> Result<(), Box<dyn Error>> {
    let metadata = distribution_metadata(path)?;
    if metadata.version != version || metadata.distribution != expected_distribution {
        return Err(format!(
            "installed distribution metadata does not match {expected_distribution} {version}"
        )
        .into());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn require_npm_file(path: &Path) -> Result<(), Box<dyn Error>> {
    let metadata = fs::metadata(path).map_err(|error| {
        format!(
            "required npm file '{}' is unavailable: {error}",
            path.display()
        )
    })?;
    if !metadata.is_file() {
        return Err(format!("required npm file '{}' is not a file", path.display()).into());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
#[derive(Deserialize)]
struct NpmPlatformManifest {
    name: String,
    version: String,
}

#[cfg(target_os = "windows")]
fn verify_npm_installation(
    request: &UpdateRequest,
    npm: &NpmInstallation,
) -> Result<(), Box<dyn Error>> {
    let manifest: NpmPlatformManifest =
        serde_json::from_slice(&fs::read(npm.npm_package_root.join("package.json"))?)?;
    let expected_name = format!(
        "@codexhost/{}",
        npm.npm_package_root
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("npm platform package has no name")?
    );
    if manifest.name != expected_name || manifest.version != request.version {
        return Err("npm platform package manifest does not match the requested update".into());
    }
    for name in [
        "app/host-runtime.mjs",
        "app/web-server.mjs",
        "app/console-server.mjs",
        "app/desktop-controller.mjs",
        "app/renderer-extension.js",
    ] {
        require_npm_file(&npm.npm_package_root.join(name))?;
    }
    verify_distribution(
        &npm.npm_package_root.join("app").join(DISTRIBUTION_FILE),
        &request.version,
        "npm",
    )?;
    require_npm_file(&npm.npm_launcher_path)?;
    for name in [
        "bin/codexhost",
        "libexec/codexhost-shim",
        "libexec/codexhost-node-repl",
        "libexec/codexhost-updater",
    ] {
        require_npm_file(
            &npm.npm_package_root
                .join(format!("{name}{}", std::env::consts::EXE_SUFFIX)),
        )?;
    }
    require_npm_file(&npm.npm_package_root.join(format!(
        "libexec/codexhost-shell{}",
        std::env::consts::EXE_SUFFIX
    )))?;
    Ok(())
}

fn run_checked(command: &mut Command, label: &str) -> Result<(), Box<dyn Error>> {
    let status = command.status()?;
    if !status.success() {
        return Err(format!("{label} failed with {status}").into());
    }
    Ok(())
}

fn install_npm_package(
    request: &UpdateRequest,
    npm: &NpmInstallation,
    log_name: &str,
    prefix: Option<&Path>,
) -> Result<(), Box<dyn Error>> {
    let package = format!("{NPM_PACKAGE_NAME}@{}", request.version);
    let mut command = Command::new(&npm.node_path);
    command
        .arg(&npm.npm_cli_path)
        .args(["install", "--global", "--no-audit", "--no-fund"]);
    if let Some(prefix) = prefix {
        command.arg("--prefix").arg(prefix);
    }
    command.arg(package);
    configure_background_command(&mut command);
    if let Some(log) = operation_log(request, log_name) {
        command.stdout(log.try_clone()?).stderr(log);
    }
    run_checked(&mut command, "npm update")
}

#[cfg(target_os = "windows")]
struct NpmLayout {
    prefix: std::path::PathBuf,
    main_package: std::path::PathBuf,
    platform_package_name: std::ffi::OsString,
}

#[cfg(target_os = "windows")]
fn npm_layout(npm: &NpmInstallation) -> Result<NpmLayout, Box<dyn Error>> {
    let main_package = npm
        .npm_launcher_path
        .parent()
        .and_then(Path::parent)
        .ok_or("npm launcher does not identify a package directory")?;
    let prefix = main_package
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or("npm package does not identify a global prefix")?;
    if main_package.file_name().and_then(|name| name.to_str()) != Some("cli")
        || main_package
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            != Some("@codexhost")
        || prefix.join("node_modules/@codexhost/cli") != main_package
    {
        return Err("npm launcher has an unexpected global package layout".into());
    }
    let platform_package_name = npm
        .npm_package_root
        .file_name()
        .ok_or("npm platform package has no directory name")?
        .to_owned();
    if main_package
        .join("node_modules/@codexhost")
        .join(&platform_package_name)
        != npm.npm_package_root
    {
        return Err("npm platform package is outside the main package".into());
    }
    Ok(NpmLayout {
        prefix: prefix.to_owned(),
        main_package: main_package.to_owned(),
        platform_package_name,
    })
}

#[derive(Debug)]
pub(crate) struct UpdateBackup {
    path: std::path::PathBuf,
}

impl UpdateBackup {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn cleanup(&self) -> std::io::Result<()> {
        fs::remove_dir_all(&self.path)
    }
}

#[cfg(target_os = "windows")]
struct StagingDirectory(std::path::PathBuf);

#[cfg(target_os = "windows")]
impl Drop for StagingDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[cfg(target_os = "windows")]
fn install_staged_npm(
    request: &UpdateRequest,
    npm: &NpmInstallation,
) -> Result<UpdateBackup, Box<dyn Error>> {
    let layout = npm_layout(npm)?;
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let staging = layout
        .prefix
        .join(format!(".codexhost-update-{}-{unique}", std::process::id()));
    let backup = layout
        .prefix
        .join(format!(".codexhost-backup-{}-{unique}", std::process::id()));
    if staging.try_exists()? || backup.try_exists()? {
        return Err("npm update staging path already exists".into());
    }
    fs::create_dir_all(&staging)?;
    let _staging = StagingDirectory(staging.clone());
    install_npm_package(request, npm, "npm-install.log", Some(&staging))?;

    let staged_main = staging.join("node_modules/@codexhost/cli");
    let staged_npm = NpmInstallation {
        node_path: npm.node_path.clone(),
        npm_cli_path: npm.npm_cli_path.clone(),
        npm_launcher_path: staged_main.join("bin/codexhost.js"),
        npm_package_root: staged_main
            .join("node_modules/@codexhost")
            .join(&layout.platform_package_name),
    };
    verify_npm_installation(request, &staged_npm).map_err(|error| {
        format!(
            "staged npm update is incomplete: {error}; the existing installation was not changed"
        )
    })?;

    // Only a complete staged package reaches the live installation. The existing
    // global shims stay in place and continue to point at the same launcher path.
    crate::prepare_install::prepare(&npm.npm_package_root)?;
    fs::rename(&layout.main_package, &backup)?;
    if let Err(activate_error) = fs::rename(&staged_main, &layout.main_package) {
        let rollback = fs::rename(&backup, &layout.main_package);
        return Err(match rollback {
            Ok(()) => format!(
                "npm activation failed: {activate_error}; the previous installation was restored"
            )
            .into(),
            Err(rollback_error) => format!(
                "npm activation failed: {activate_error}; restoring the previous installation also failed: {rollback_error}"
            )
            .into(),
        });
    }
    if let Err(verify_error) = verify_npm_installation(request, npm) {
        let rollback = fs::rename(&layout.main_package, &staged_main)
            .and_then(|_| fs::rename(&backup, &layout.main_package));
        return Err(match rollback {
            Ok(()) => format!(
                "activated npm package is incomplete: {verify_error}; the previous installation was restored"
            )
            .into(),
            Err(rollback_error) => format!(
                "activated npm package is incomplete: {verify_error}; rollback failed: {rollback_error}"
            )
            .into(),
        });
    }
    Ok(UpdateBackup { path: backup })
}

#[cfg(target_os = "windows")]
fn install_npm(
    request: &UpdateRequest,
    npm: &NpmInstallation,
) -> Result<Option<UpdateBackup>, Box<dyn Error>> {
    install_staged_npm(request, npm).map(Some)
}

#[cfg(not(target_os = "windows"))]
fn install_npm(
    request: &UpdateRequest,
    npm: &NpmInstallation,
) -> Result<Option<UpdateBackup>, Box<dyn Error>> {
    install_npm_package(request, npm, "npm-install.log", None).map(|()| None)
}

/// A diagnostic log beside the operation status; updates proceed without it.
fn operation_log(request: &UpdateRequest, name: &str) -> Option<File> {
    File::create(request.status_path.parent()?.join(name)).ok()
}

#[cfg(target_os = "windows")]
fn install_windows(
    request: &UpdateRequest,
    windows: &WindowsInstallation,
) -> Result<(), Box<dyn Error>> {
    verify_artifact(&windows.installer_path, &windows.artifact_sha256)?;
    // Close the console, Node, Shim and Launcher still running from this
    // installation. Installers released before `prepare-install` do not, and
    // Inno aborts a silent install when Restart Manager cannot close them.
    crate::prepare_install::prepare(&windows.install_root)?;
    let mut command = Command::new(&windows.installer_path);
    command.args(["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"]);
    // Keep the running installation's directory, and leave Inno's log beside the
    // operation status for diagnosis.
    let mut directory = std::ffi::OsString::from("/DIR=");
    directory.push(&windows.install_root);
    command.arg(directory);
    if let Some(operation) = request.status_path.parent() {
        let mut log = std::ffi::OsString::from("/LOG=");
        log.push(operation.join("installer.log"));
        command.arg(log);
    }
    configure_background_command(&mut command);
    run_checked(&mut command, "Windows installer")?;
    verify_distribution(
        &windows.install_root.join("app").join(DISTRIBUTION_FILE),
        &request.version,
        "installer",
    )
}

#[cfg(not(target_os = "windows"))]
fn install_windows(
    _request: &UpdateRequest,
    _windows: &WindowsInstallation,
) -> Result<(), Box<dyn Error>> {
    Err("Windows installer updates require Windows".into())
}

#[cfg(target_os = "macos")]
fn install_macos(request: &UpdateRequest, macos: &MacOsInstallation) -> Result<(), Box<dyn Error>> {
    verify_artifact(&macos.dmg_path, &macos.artifact_sha256)?;
    let parent = macos
        .app_path
        .parent()
        .ok_or("macOS application path has no parent")?;
    let unique = format!("{}-{}", std::process::id(), unix_seconds());
    let mount = env::temp_dir().join(format!("codexhost-update-mount-{unique}"));
    let staged = parent.join(format!(".codexhost-update-{unique}.app"));
    let backup = parent.join(format!(".codexhost-backup-{unique}.app"));
    fs::create_dir_all(&mount)?;
    if staged.exists() || backup.exists() {
        return Err("macOS update staging path already exists".into());
    }
    let attach_result = run_checked(
        Command::new("/usr/bin/hdiutil")
            .args(["attach", "-nobrowse", "-readonly", "-mountpoint"])
            .arg(&mount)
            .arg(&macos.dmg_path),
        "macOS DMG mount",
    );
    if let Err(error) = attach_result {
        let _ = fs::remove_dir_all(&mount);
        return Err(error);
    }

    let prepare_result = (|| -> Result<(), Box<dyn Error>> {
        let source = mount.join("codexhost.app");
        if !source.is_dir() {
            return Err("macOS DMG does not contain codexhost.app".into());
        }
        run_checked(
            Command::new("/usr/bin/ditto").arg(&source).arg(&staged),
            "macOS application staging",
        )?;
        verify_distribution(
            &staged
                .join("Contents")
                .join("Resources")
                .join("app")
                .join(DISTRIBUTION_FILE),
            &request.version,
            "installer",
        )?;
        run_checked(
            Command::new("/usr/bin/codesign")
                .args(["--verify", "--deep", "--strict"])
                .arg(&staged),
            "macOS application integrity check",
        )
    })();
    let detach_result = run_checked(
        Command::new("/usr/bin/hdiutil").arg("detach").arg(&mount),
        "macOS DMG detach",
    );
    let _ = fs::remove_dir_all(&mount);
    if let Err(error) = prepare_result {
        let _ = fs::remove_dir_all(&staged);
        return Err(error);
    }
    detach_result?;

    fs::rename(&macos.app_path, &backup)?;
    if let Err(error) = fs::rename(&staged, &macos.app_path) {
        let _ = fs::rename(&backup, &macos.app_path);
        return Err(format!("could not activate updated macOS application: {error}").into());
    }
    if let Err(error) = verify_distribution(
        &macos
            .app_path
            .join("Contents")
            .join("Resources")
            .join("app")
            .join(DISTRIBUTION_FILE),
        &request.version,
        "installer",
    ) {
        let _ = fs::remove_dir_all(&macos.app_path);
        let _ = fs::rename(&backup, &macos.app_path);
        return Err(error);
    }
    fs::remove_dir_all(backup)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn install_macos(
    _request: &UpdateRequest,
    _macos: &MacOsInstallation,
) -> Result<(), Box<dyn Error>> {
    Err("macOS DMG updates require macOS".into())
}

pub(crate) fn preflight(request: &UpdateRequest) -> Result<(), Box<dyn Error>> {
    #[cfg(target_os = "windows")]
    if let Installation::Npm(npm) = &request.installation {
        npm_layout(npm).map_err(|error| {
            format!(
                "{error}; use `npm uninstall -g @codexhost/cli && npm install -g @codexhost/cli` instead"
            )
        })?;
    }
    #[cfg(not(target_os = "windows"))]
    let _ = request;
    Ok(())
}

pub(crate) fn install(request: &UpdateRequest) -> Result<Option<UpdateBackup>, Box<dyn Error>> {
    match &request.installation {
        Installation::Npm(npm) => install_npm(request, npm),
        Installation::WindowsInstaller(windows) => install_windows(request, windows).map(|()| None),
        Installation::MacosDmg(macos) => install_macos(request, macos).map(|()| None),
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::{DistributionMetadata, install_npm, verify_npm_installation};
    use crate::request::{Installation, NpmInstallation, UpdateRequest};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_DIRECTORY: AtomicUsize = AtomicUsize::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "codexhost-npm-install-{}-{}",
                std::process::id(),
                NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self, relative: &str) -> PathBuf {
            self.0.join(relative)
        }

        fn file(&self, relative: &str) -> PathBuf {
            let file = self.path(relative);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(&file, "fixture").unwrap();
            file
        }

        fn write_file(path: &std::path::Path, contents: &str) {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }

        fn fake_npm(&self, staged_install_complete: bool) -> NpmInstallation {
            let npm_cli_path = self.file("npm-cli.js");
            let npm_launcher_path =
                self.path("prefix/node_modules/@codexhost/cli/bin/codexhost.js");
            let npm_package_root = self
                .path("prefix/node_modules/@codexhost/cli/node_modules/@codexhost/cli-win32-x64");
            Self::write_file(&npm_launcher_path, "old launcher");
            for name in [
                "bin/codexhost.exe",
                "libexec/codexhost-shim.exe",
                "libexec/codexhost-shell.exe",
                "libexec/codexhost-node-repl.exe",
                "libexec/codexhost-updater.exe",
            ] {
                Self::write_file(&npm_package_root.join(name), "old executable");
            }
            Self::write_file(
                &npm_package_root.join("app/codexhost-distribution.json"),
                r#"{"schemaVersion":1,"version":"1.2.2","distribution":"npm","target":"windows-x64"}"#,
            );
            Self::write_file(
                &npm_package_root.join("package.json"),
                r#"{"name":"@codexhost/cli-win32-x64","version":"1.2.2"}"#,
            );
            for name in [
                "app/host-runtime.mjs",
                "app/web-server.mjs",
                "app/console-server.mjs",
                "app/desktop-controller.mjs",
                "app/renderer-extension.js",
            ] {
                Self::write_file(&npm_package_root.join(name), "old runtime");
            }
            Self::write_file(&self.path("prefix/codexhost.cmd"), "old shim");
            let config = serde_json::json!({
                "calls": self.path("calls"),
                "complete": staged_install_complete,
            });
            fs::write(
                &npm_cli_path,
                format!(
                    r#"
const fs = require("node:fs");
const path = require("node:path");
const config = {config};
const prefixIndex = process.argv.indexOf("--prefix");
if (prefixIndex < 0) throw new Error("update did not use an isolated prefix");
const prefix = process.argv[prefixIndex + 1];
fs.appendFileSync(config.calls, process.argv.slice(2).join(" ") + "\n");
const main = path.join(prefix, "node_modules", "@codexhost", "cli");
const launcher = path.join(main, "bin", "codexhost.js");
fs.mkdirSync(path.dirname(launcher), {{ recursive: true }});
fs.writeFileSync(launcher, config.complete ? "new launcher" : "incomplete launcher");
if (config.complete) {{
  const platform = path.join(main, "node_modules", "@codexhost", "cli-win32-x64");
  for (const name of [
    "bin/codexhost.exe",
    "libexec/codexhost-shim.exe",
    "libexec/codexhost-shell.exe",
    "libexec/codexhost-node-repl.exe",
    "libexec/codexhost-updater.exe",
  ]) {{
    const file = path.join(platform, name);
    fs.mkdirSync(path.dirname(file), {{ recursive: true }});
    fs.writeFileSync(file, "new executable");
  }}
  const metadata = path.join(platform, "app", "codexhost-distribution.json");
  fs.mkdirSync(path.dirname(metadata), {{ recursive: true }});
  fs.writeFileSync(metadata, JSON.stringify({{
    schemaVersion: 1,
    version: "1.2.3",
    distribution: "npm",
    target: "windows-x64",
  }}));
  fs.writeFileSync(path.join(platform, "package.json"), JSON.stringify({{
    name: "@codexhost/cli-win32-x64",
    version: "1.2.3",
  }}));
  for (const name of [
    "app/host-runtime.mjs",
    "app/web-server.mjs",
    "app/console-server.mjs",
    "app/desktop-controller.mjs",
    "app/renderer-extension.js",
  ]) {{
    const file = path.join(platform, name);
    fs.mkdirSync(path.dirname(file), {{ recursive: true }});
    fs.writeFileSync(file, "new runtime");
  }}
}}
"#
                ),
            )
            .unwrap();
            NpmInstallation {
                node_path: PathBuf::from("node"),
                npm_cli_path,
                npm_launcher_path,
                npm_package_root,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn request(fixture: &Fixture, npm: NpmInstallation) -> UpdateRequest {
        UpdateRequest {
            schema_version: 1,
            version: "1.2.3".into(),
            wait_pid: 1,
            wait_executable: fixture.path("launcher"),
            runtime_descriptor_path: fixture.path("runtime.json"),
            restart_target: Default::default(),
            data_directory: None,
            service_managed: false,
            status_path: fixture.path("status.json"),
            installation: crate::request::Installation::Npm(npm),
        }
    }

    #[test]
    fn distribution_metadata_rejects_unknown_fields() {
        let metadata = br#"{"schemaVersion":1,"version":"1.2.3","distribution":"npm","target":"macos-arm64","extra":true}"#;
        assert!(serde_json::from_slice::<DistributionMetadata>(metadata).is_err());
    }

    #[test]
    fn complete_staged_update_replaces_package_without_touching_shims() {
        let fixture = Fixture::new();
        let request = request(&fixture, fixture.fake_npm(true));
        let Installation::Npm(npm) = &request.installation else {
            unreachable!()
        };

        let backup = install_npm(&request, npm)
            .expect("a complete staged package should activate")
            .expect("the previous package should remain as a backup until cleanup");
        assert!(backup.path().exists());
        backup.cleanup().unwrap();
        assert!(!backup.path().exists());
        assert_eq!(
            fs::read_to_string(&npm.npm_launcher_path).unwrap(),
            "new launcher"
        );
        assert_eq!(
            fs::read_to_string(fixture.path("prefix/codexhost.cmd")).unwrap(),
            "old shim"
        );
        assert_eq!(
            fs::read_to_string(fixture.path("calls"))
                .unwrap()
                .lines()
                .count(),
            1
        );
    }

    #[test]
    fn platform_manifest_and_runtime_files_are_validated() {
        let fixture = Fixture::new();
        let request = request(&fixture, fixture.fake_npm(true));
        let Installation::Npm(npm) = &request.installation else {
            unreachable!()
        };
        install_npm(&request, npm)
            .expect("a complete staged package should activate")
            .expect("the previous package should remain as a backup")
            .cleanup()
            .unwrap();
        let manifest = npm.npm_package_root.join("package.json");
        let valid = fs::read(&manifest).unwrap();
        for invalid in [
            "not json".to_owned(),
            r#"{"name":"@codexhost/cli-win32-x64","version":"1.2.2"}"#.to_owned(),
        ] {
            fs::write(&manifest, invalid).unwrap();
            assert!(verify_npm_installation(&request, npm).is_err());
            fs::write(&manifest, &valid).unwrap();
        }
        let console = npm.npm_package_root.join("app/console-server.mjs");
        fs::remove_file(console).unwrap();
        assert!(verify_npm_installation(&request, npm).is_err());
    }

    #[test]
    fn incomplete_staged_update_preserves_existing_installation() {
        let fixture = Fixture::new();
        let request = request(&fixture, fixture.fake_npm(false));
        let Installation::Npm(npm) = &request.installation else {
            unreachable!()
        };

        let error =
            install_npm(&request, npm).expect_err("an incomplete staging install must fail");
        assert!(
            error
                .to_string()
                .contains("existing installation was not changed")
        );
        assert_eq!(
            fs::read_to_string(&npm.npm_launcher_path).unwrap(),
            "old launcher"
        );
        assert_eq!(
            fs::read_to_string(npm.npm_package_root.join("bin/codexhost.exe")).unwrap(),
            "old executable"
        );
        assert_eq!(
            fs::read_to_string(fixture.path("prefix/codexhost.cmd")).unwrap(),
            "old shim"
        );
    }
}

#[cfg(all(test, target_os = "macos"))]
mod distribution_tests {
    use super::DistributionMetadata;

    #[test]
    fn distribution_metadata_rejects_unknown_fields() {
        let metadata = br#"{"schemaVersion":1,"version":"1.2.3","distribution":"npm","target":"macos-arm64","extra":true}"#;
        assert!(serde_json::from_slice::<DistributionMetadata>(metadata).is_err());
    }
}
