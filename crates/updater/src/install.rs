#[cfg(target_os = "macos")]
use std::env;
use std::error::Error;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::fs;
use std::fs::File;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::io::Read;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::path::Path;
use std::process::{Command, Stdio};

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

fn run_checked(command: &mut Command, label: &str) -> Result<(), Box<dyn Error>> {
    let status = command.status()?;
    if !status.success() {
        return Err(format!("{label} failed with {status}").into());
    }
    Ok(())
}

fn install_npm(request: &UpdateRequest, npm: &NpmInstallation) -> Result<(), Box<dyn Error>> {
    // The installer runs this step itself for an EXE install. npm does not, so close
    // what still runs from the platform package (for example a Shim the stopped
    // Desktop left behind) before npm replaces those locked executables. The shared
    // Node runtime is not a target.
    #[cfg(target_os = "windows")]
    crate::prepare_install::prepare(&npm.npm_package_root)?;
    let mut command = Command::new(&npm.node_path);
    command
        .arg(&npm.npm_cli_path)
        .args(["install", "--global", "--no-audit", "--no-fund"])
        .arg(format!("{NPM_PACKAGE_NAME}@{}", request.version));
    configure_background_command(&mut command);
    if let Some(log) = operation_log(request, "npm-install.log") {
        command.stdout(log.try_clone()?).stderr(log);
    }
    run_checked(&mut command, "npm update")
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

pub(crate) fn install(request: &UpdateRequest) -> Result<(), Box<dyn Error>> {
    match &request.installation {
        Installation::Npm(npm) => install_npm(request, npm),
        Installation::WindowsInstaller(windows) => install_windows(request, windows),
        Installation::MacosDmg(macos) => install_macos(request, macos),
    }
}

pub(crate) fn relaunch(request: &UpdateRequest) -> Result<(), Box<dyn Error>> {
    let mut command = match &request.installation {
        Installation::Npm(npm) => {
            let mut command = Command::new(&npm.node_path);
            command.arg(&npm.npm_launcher_path);
            command
        }
        Installation::WindowsInstaller(windows) => {
            let mut command = Command::new(windows.install_root.join("bin/codexhost-start.exe"));
            configure_background_command(&mut command);
            command
        }
        Installation::MacosDmg(macos) => {
            let mut command = Command::new("/usr/bin/open");
            command.arg(&macos.app_path);
            command
        }
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.spawn()?;
    Ok(())
}

#[cfg(all(test, any(target_os = "windows", target_os = "macos")))]
mod tests {
    use super::DistributionMetadata;

    #[test]
    fn distribution_metadata_rejects_unknown_fields() {
        let metadata = br#"{"schemaVersion":1,"version":"1.2.3","distribution":"npm","target":"macos-arm64","extra":true}"#;
        assert!(serde_json::from_slice::<DistributionMetadata>(metadata).is_err());
    }
}
