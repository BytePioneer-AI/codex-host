#[cfg(target_os = "macos")]
use std::env;
use std::error::Error;
use std::fs;
use std::fs::File;
use std::io::Read;
use std::path::Path;
#[cfg(target_os = "linux")]
use std::path::PathBuf;
use std::process::Command;

use codexhost_platform::configure_background_command;
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[cfg(target_os = "linux")]
use crate::request::validate_linux_archive_paths;
use crate::request::validate_version;
use crate::request::{
    Installation, LinuxArchiveInstallation, MacOsInstallation, NpmInstallation, UpdateRequest,
    WindowsInstallation,
};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use crate::status::unix_seconds;

const DISTRIBUTION_FILE: &str = "codexhost-distribution.json";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DistributionMetadata {
    schema_version: u8,
    version: String,
    distribution: String,
    target: String,
}

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

fn verify_artifact(path: &Path, expected: &str) -> Result<(), Box<dyn Error>> {
    let actual = sha256_file(path)?;
    if actual != expected {
        return Err(
            format!("update artifact SHA-256 mismatch: expected {expected}, got {actual}").into(),
        );
    }
    Ok(())
}

fn distribution_metadata(path: &Path) -> Result<DistributionMetadata, Box<dyn Error>> {
    let metadata = serde_json::from_slice::<DistributionMetadata>(&fs::read(path)?)?;
    if metadata.schema_version != 1 || metadata.target.is_empty() {
        return Err("installed distribution metadata is invalid".into());
    }
    validate_version(&metadata.version)?;
    Ok(metadata)
}

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

/// Checks, before anything stops, that this update can replace the installation that
/// restart runs, and returns the npm package specs for an npm installation.
pub(crate) fn preflight(request: &UpdateRequest) -> Result<Vec<String>, Box<dyn Error>> {
    let Installation::Npm(npm) = &request.installation else {
        return Ok(Vec::new());
    };
    #[cfg(target_os = "windows")]
    npm_layout(npm).map_err(|error| {
        format!(
            "{error}; use `npm uninstall -g @codexhost/cli && npm install -g @codexhost/cli` instead"
        )
    })?;
    crate::npm::install_specs(
        &npm.node_path,
        &npm.npm_cli_path,
        &npm.npm_launcher_path,
        &npm.npm_package_root,
        &request.version,
    )?
    .ok_or_else(|| {
        format!(
            "npm uses a different global installation than {}; update manually with the npm that installed codexhost",
            npm.npm_package_root.display()
        )
        .into()
    })
}

fn install_npm_package(
    request: &UpdateRequest,
    npm: &NpmInstallation,
    specs: &[String],
    log_name: &str,
    prefix: Option<&Path>,
) -> Result<(), Box<dyn Error>> {
    let mut command = Command::new(&npm.node_path);
    command
        .arg(&npm.npm_cli_path)
        // The update manager downloaded these packages into the npm cache before the
        // services stopped, so the install does not wait on a slow or lagging registry.
        .args([
            "install",
            "--global",
            "--prefer-offline",
            "--no-audit",
            "--no-fund",
        ]);
    if let Some(prefix) = prefix {
        command.arg("--prefix").arg(prefix);
    }
    command.args(specs);
    configure_background_command(&mut command);
    if let Some(log) = operation_log(request, log_name) {
        command.stdout(log.try_clone()?).stderr(log);
    }
    run_checked(&mut command, "npm update")?;
    if prefix.is_some() {
        return Ok(());
    }
    // Restart runs the payload at npm_package_root, so it must be the requested version.
    verify_distribution(
        &npm.npm_package_root.join("app").join(DISTRIBUTION_FILE),
        &request.version,
        "npm",
    )
    .map_err(|error| {
        format!(
            "npm update did not replace the platform package at {}: {error}",
            npm.npm_package_root.display()
        )
        .into()
    })
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
    specs: &[String],
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
    install_npm_package(request, npm, specs, "npm-install.log", Some(&staging))?;

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
    specs: &[String],
) -> Result<Option<UpdateBackup>, Box<dyn Error>> {
    install_staged_npm(request, npm, specs).map(Some)
}

#[cfg(not(target_os = "windows"))]
fn install_npm(
    request: &UpdateRequest,
    npm: &NpmInstallation,
    specs: &[String],
) -> Result<Option<UpdateBackup>, Box<dyn Error>> {
    install_npm_package(request, npm, specs, "npm-install.log", None).map(|()| None)
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

/// The single top-level directory the release archive extracts to.
#[cfg(target_os = "linux")]
fn extracted_root(staging: &Path) -> Result<PathBuf, Box<dyn Error>> {
    let mut entries = fs::read_dir(staging)?.collect::<Result<Vec<_>, _>>()?;
    if entries.len() != 1 || !entries[0].file_type()?.is_dir() {
        return Err("Linux release archive must contain exactly one top-level directory".into());
    }
    Ok(entries.remove(0).path())
}

#[cfg(any(target_os = "linux", test))]
fn activate_linux_installation(
    install_root: &Path,
    staged: &Path,
    staging: &Path,
    backup: &Path,
    version: &str,
    remove_backup: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<(), Box<dyn Error>> {
    // Running processes keep their open executables after the directory moves aside.
    fs::rename(install_root, backup)?;
    if let Err(error) = fs::rename(staged, install_root) {
        let _ = fs::rename(backup, install_root);
        let _ = fs::remove_dir_all(staging);
        return Err(format!("could not activate updated Linux installation: {error}").into());
    }
    let _ = fs::remove_dir_all(staging);
    if let Err(error) = verify_distribution(
        &install_root.join("app").join(DISTRIBUTION_FILE),
        version,
        "installer",
    ) {
        let _ = fs::remove_dir_all(install_root);
        let _ = fs::rename(backup, install_root);
        return Err(error);
    }
    if let Err(error) = remove_backup(backup) {
        eprintln!(
            "codexhost updater: warning: updated Linux installation is active, but could not remove backup '{}': {error}",
            backup.display()
        );
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn install_linux(
    request: &UpdateRequest,
    linux: &LinuxArchiveInstallation,
) -> Result<(), Box<dyn Error>> {
    validate_linux_archive_paths(request, linux)?;
    verify_artifact(&linux.archive_path, &linux.artifact_sha256)?;
    let parent = linux
        .install_root
        .parent()
        .ok_or("Linux install root has no parent")?;
    let unique = format!("{}-{}", std::process::id(), unix_seconds());
    // Staging beside the installation keeps both renames on one filesystem.
    let staging = parent.join(format!(".codexhost-update-{unique}"));
    let backup = parent.join(format!(".codexhost-backup-{unique}"));
    if staging.exists() || backup.exists() {
        return Err("Linux update staging path already exists".into());
    }
    fs::create_dir(&staging)?;
    let staged = (|| -> Result<PathBuf, Box<dyn Error>> {
        run_checked(
            Command::new("tar")
                .args(["--extract", "--gzip", "--no-same-owner", "--file"])
                .arg(&linux.archive_path)
                .arg("--directory")
                .arg(&staging),
            "Linux archive extraction",
        )?;
        let root = extracted_root(&staging)?;
        verify_distribution(
            &root.join("app").join(DISTRIBUTION_FILE),
            &request.version,
            "installer",
        )?;
        Ok(root)
    })();
    let staged = match staged {
        Ok(root) => root,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
    };

    activate_linux_installation(
        &linux.install_root,
        &staged,
        &staging,
        &backup,
        &request.version,
        |path| fs::remove_dir_all(path),
    )
}

#[cfg(not(target_os = "linux"))]
fn install_linux(
    _request: &UpdateRequest,
    _linux: &LinuxArchiveInstallation,
) -> Result<(), Box<dyn Error>> {
    Err("Linux archive updates require Linux".into())
}

/// `npm_specs` comes from [`preflight`].
pub(crate) fn install(
    request: &UpdateRequest,
    npm_specs: &[String],
) -> Result<Option<UpdateBackup>, Box<dyn Error>> {
    match &request.installation {
        Installation::Npm(npm) => install_npm(request, npm, npm_specs),
        Installation::WindowsInstaller(windows) => install_windows(request, windows).map(|()| None),
        Installation::MacosDmg(macos) => install_macos(request, macos).map(|()| None),
        Installation::LinuxArchive(linux) => install_linux(request, linux).map(|()| None),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io;
    use std::path::Path;

    use super::{DistributionMetadata, activate_linux_installation};

    fn write_release_tree(root: &Path, version: &str, marker: &str) {
        fs::create_dir_all(root.join("app")).unwrap();
        fs::write(
            root.join("app/codexhost-distribution.json"),
            format!(
                r#"{{"schemaVersion":1,"version":"{version}","distribution":"installer","target":"linux-x64"}}"#
            ),
        )
        .unwrap();
        fs::write(root.join("marker"), marker).unwrap();
    }

    #[cfg(target_os = "windows")]
    mod windows_npm {
        use super::super::{install_npm, verify_npm_installation};
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
                let npm_package_root = self.path(
                    "prefix/node_modules/@codexhost/cli/node_modules/@codexhost/cli-win32-x64",
                );
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
        fn complete_staged_update_replaces_package_without_touching_shims() {
            let fixture = Fixture::new();
            let request = request(&fixture, fixture.fake_npm(true));
            let Installation::Npm(npm) = &request.installation else {
                unreachable!()
            };

            let backup = install_npm(&request, npm, &["@codexhost/cli@1.2.3".into()])
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
            install_npm(&request, npm, &["@codexhost/cli@1.2.3".into()])
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

            let error = install_npm(&request, npm, &["@codexhost/cli@1.2.3".into()])
                .expect_err("an incomplete staging install must fail");
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

    #[test]
    fn distribution_metadata_rejects_unknown_fields() {
        let metadata = br#"{"schemaVersion":1,"version":"1.2.3","distribution":"npm","target":"macos-arm64","extra":true}"#;
        assert!(serde_json::from_slice::<DistributionMetadata>(metadata).is_err());
    }

    #[test]
    fn linux_activation_succeeds_when_backup_cleanup_fails_after_verification() {
        let directory = std::env::temp_dir().join(format!(
            "codexhost-linux-backup-cleanup-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let install_root = directory.join("codexhost");
        let staging = directory.join(".codexhost-update-1");
        let staged = staging.join("codexhost-1.1.0-linux-x64");
        let backup = directory.join(".codexhost-backup-1");
        write_release_tree(&install_root, "1.0.0", "old");
        write_release_tree(&staged, "1.1.0", "new");

        activate_linux_installation(&install_root, &staged, &staging, &backup, "1.1.0", |_| {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "backup directory locked",
            ))
        })
        .unwrap();

        assert_eq!(
            fs::read_to_string(install_root.join("marker")).unwrap(),
            "new"
        );
        assert!(!staging.exists());
        assert_eq!(fs::read_to_string(backup.join("marker")).unwrap(), "old");
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn linux_activation_restores_backup_when_post_swap_verification_fails() {
        let directory = std::env::temp_dir().join(format!(
            "codexhost-linux-post-swap-rollback-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let install_root = directory.join("codexhost");
        let staging = directory.join(".codexhost-update-1");
        let staged = staging.join("codexhost-1.1.0-linux-x64");
        let backup = directory.join(".codexhost-backup-1");
        write_release_tree(&install_root, "1.0.0", "old");
        write_release_tree(&staged, "1.1.0", "new");

        let mut cleanup_called = false;
        let result =
            activate_linux_installation(&install_root, &staged, &staging, &backup, "1.2.0", |_| {
                cleanup_called = true;
                Ok(())
            });
        assert!(result.is_err());
        assert!(!cleanup_called);
        assert_eq!(
            fs::read_to_string(install_root.join("marker")).unwrap(),
            "old"
        );
        assert!(!backup.exists());
        fs::remove_dir_all(&directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn npm_update_replaces_the_platform_package_that_restart_runs() {
        use crate::request::{Installation, NpmInstallation, RestartTarget, UpdateRequest};

        let directory =
            std::env::temp_dir().join(format!("codexhost-npm-layout-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        let global_root = directory.join("lib/node_modules");
        let modules = global_root.join("@codexhost");
        let nested = modules.join("cli/node_modules/@codexhost/cli-fixture");
        let independent = modules.join("cli-fixture");
        let elsewhere = directory.join("other/node_modules/@codexhost/cli-fixture");
        let npm_cli = directory.join("npm.sh");
        fs::create_dir_all(&global_root).unwrap();
        // Like npm: a named package is installed; the CLI brings only its nested payload.
        fs::write(
            &npm_cli,
            format!(
                r#"set -eu
if [ "$1" = root ]; then echo '{}'; exit 0; fi
shift 5
for spec in "$@"; do
  case "$spec" in
    @codexhost/cli@*) root='{}' ;;
    @codexhost/cli-fixture@*) root='{}' ;;
  esac
  mkdir -p "$root/app"
  printf '{{"schemaVersion":1,"version":"%s","distribution":"npm","target":"fixture"}}' "${{spec##*@}}" > "$root/app/codexhost-distribution.json"
done
"#,
                global_root.display(),
                nested.display(),
                independent.display()
            ),
        )
        .unwrap();
        for package_root in [&nested, &independent, &elsewhere] {
            for root in [&nested, &independent, &elsewhere] {
                let _ = fs::remove_dir_all(root);
                fs::create_dir_all(root.join("app")).unwrap();
                fs::write(
                    root.join("app/codexhost-distribution.json"),
                    r#"{"schemaVersion":1,"version":"1.0.0","distribution":"npm","target":"fixture"}"#,
                )
                .unwrap();
            }
            let request = UpdateRequest {
                schema_version: 1,
                version: "1.1.0".into(),
                wait_pid: 2,
                wait_executable: "/unused".into(),
                runtime_descriptor_path: "/unused".into(),
                restart_target: RestartTarget::Desktop,
                data_directory: None,
                service_managed: false,
                status_path: directory.join("status.json"),
                installation: Installation::Npm(NpmInstallation {
                    node_path: "/bin/sh".into(),
                    npm_cli_path: npm_cli.clone(),
                    npm_launcher_path: modules.join("cli/bin/codexhost.js"),
                    npm_package_root: package_root.clone(),
                }),
            };

            let result =
                super::preflight(&request).and_then(|specs| super::install(&request, &specs));

            if package_root == &elsewhere {
                let error = result.unwrap_err().to_string();
                assert!(error.contains("different global installation"), "{error}");
                continue;
            }
            assert!(result.unwrap().is_none());
            let installed =
                super::distribution_metadata(&package_root.join("app/codexhost-distribution.json"))
                    .unwrap();
            assert_eq!(installed.version, "1.1.0", "{}", package_root.display());
        }
        fs::remove_dir_all(&directory).unwrap();
    }

    #[cfg(target_os = "linux")]
    mod linux_archive {
        use std::fs;
        use std::path::{Path, PathBuf};
        use std::process::Command;

        use super::super::{install_linux, sha256_file};
        use crate::request::{
            Installation, LinuxArchiveInstallation, NpmInstallation, RestartTarget, UpdateRequest,
        };

        fn release_tree(root: &Path, version: &str, marker: &str) {
            fs::create_dir_all(root.join("app")).unwrap();
            fs::write(
                root.join("app/codexhost-distribution.json"),
                format!(
                    r#"{{"schemaVersion":1,"version":"{version}","distribution":"installer","target":"linux-x64"}}"#
                ),
            )
            .unwrap();
            fs::write(root.join("marker"), marker).unwrap();
        }

        fn archive(directory: &Path, version: &str) -> PathBuf {
            let source = directory.join("source");
            release_tree(
                &source.join(format!("codexhost-{version}-linux-x64")),
                version,
                "new",
            );
            let archive = directory.join("update.tar.gz");
            let status = Command::new("tar")
                .arg("-czf")
                .arg(&archive)
                .arg("-C")
                .arg(&source)
                .arg(".")
                .status()
                .unwrap();
            assert!(status.success());
            archive
        }

        fn request(version: &str) -> UpdateRequest {
            let path = PathBuf::from("/unused");
            UpdateRequest {
                schema_version: 1,
                version: version.into(),
                wait_pid: 2,
                wait_executable: path.clone(),
                runtime_descriptor_path: path.clone(),
                restart_target: RestartTarget::Desktop,
                data_directory: None,
                service_managed: false,
                status_path: path.clone(),
                installation: Installation::Npm(NpmInstallation {
                    node_path: path.clone(),
                    npm_cli_path: path.clone(),
                    npm_launcher_path: path.clone(),
                    npm_package_root: path,
                }),
            }
        }

        fn fixture(name: &str) -> PathBuf {
            let directory = std::env::temp_dir().join(format!(
                "codexhost-linux-archive-{name}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&directory);
            fs::create_dir_all(&directory).unwrap();
            directory
        }

        fn siblings(directory: &Path) -> Vec<String> {
            let mut names = fs::read_dir(directory.join("installed"))
                .unwrap()
                .map(|entry| entry.unwrap().file_name().into_string().unwrap())
                .collect::<Vec<_>>();
            names.sort();
            names
        }

        #[test]
        fn replaces_the_installation_and_leaves_no_staging_behind() {
            let directory = fixture("replace");
            let install_root = directory.join("installed/codexhost");
            release_tree(&install_root, "1.0.0", "old");
            let archive_path = archive(&directory, "1.1.0");
            let linux = LinuxArchiveInstallation {
                artifact_sha256: sha256_file(&archive_path).unwrap(),
                archive_path,
                install_root: install_root.clone(),
            };

            install_linux(&request("1.1.0"), &linux).unwrap();

            assert_eq!(
                fs::read_to_string(install_root.join("marker")).unwrap(),
                "new"
            );
            assert_eq!(siblings(&directory), ["codexhost"]);
            fs::remove_dir_all(directory).unwrap();
        }

        #[test]
        fn keeps_the_installation_when_the_archive_is_not_the_requested_version() {
            let directory = fixture("mismatch");
            let install_root = directory.join("installed/codexhost");
            release_tree(&install_root, "1.0.0", "old");
            let archive_path = archive(&directory, "1.1.0");
            let linux = LinuxArchiveInstallation {
                artifact_sha256: sha256_file(&archive_path).unwrap(),
                archive_path,
                install_root: install_root.clone(),
            };

            assert!(install_linux(&request("1.2.0"), &linux).is_err());

            assert_eq!(
                fs::read_to_string(install_root.join("marker")).unwrap(),
                "old"
            );
            assert_eq!(siblings(&directory), ["codexhost"]);
            fs::remove_dir_all(directory).unwrap();
        }

        #[test]
        fn refuses_to_replace_when_data_archive_or_status_is_inside_install_root() {
            let directory = fixture("containment");
            let install_root = directory.join("installed/codexhost");
            release_tree(&install_root, "1.0.0", "old");
            let archive_path = archive(&directory, "1.1.0");
            let sha256 = sha256_file(&archive_path).unwrap();

            let mut data_inside = request("1.1.0");
            data_inside.data_directory = Some(install_root.join("data"));
            let linux = LinuxArchiveInstallation {
                artifact_sha256: sha256.clone(),
                archive_path: archive_path.clone(),
                install_root: install_root.clone(),
            };
            assert!(install_linux(&data_inside, &linux).is_err());

            let mut status_inside = request("1.1.0");
            status_inside.status_path = install_root.join("updates/status.json");
            assert!(install_linux(&status_inside, &linux).is_err());

            let archive_inside = install_root.join("update.tar.gz");
            fs::copy(&archive_path, &archive_inside).unwrap();
            let linux_archive_inside = LinuxArchiveInstallation {
                artifact_sha256: sha256,
                archive_path: archive_inside,
                install_root: install_root.clone(),
            };
            assert!(install_linux(&request("1.1.0"), &linux_archive_inside).is_err());

            assert_eq!(
                fs::read_to_string(install_root.join("marker")).unwrap(),
                "old"
            );
            assert_eq!(siblings(&directory), ["codexhost"]);
            fs::remove_dir_all(directory).unwrap();
        }
    }
}
