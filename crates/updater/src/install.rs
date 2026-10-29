#[cfg(target_os = "macos")]
use std::env;
use std::error::Error;
#[cfg(any(target_os = "windows", target_os = "macos", test))]
use std::fs::{self, File};
#[cfg(any(target_os = "windows", target_os = "macos", test))]
use std::io::Read;
#[cfg(any(target_os = "windows", target_os = "macos", test))]
use std::path::Path;
use std::process::{Child, Command, Stdio};

use codexhost_platform::configure_background_command;
#[cfg(any(target_os = "windows", target_os = "macos", test))]
use serde::Deserialize;
#[cfg(any(target_os = "windows", target_os = "macos", test))]
use sha2::{Digest, Sha256};

#[cfg(any(target_os = "windows", target_os = "macos", test))]
use crate::request::validate_version;
use crate::request::{
    Installation, MacOsInstallation, NpmInstallation, UpdateRequest, WindowsInstallation,
};
#[cfg(target_os = "macos")]
use crate::status::unix_seconds;

#[cfg(any(not(target_os = "windows"), test))]
const NPM_PACKAGE_NAME: &str = "@codexhost/cli";
#[cfg(any(target_os = "windows", target_os = "macos", test))]
const DISTRIBUTION_FILE: &str = "codexhost-distribution.json";

#[cfg(any(target_os = "windows", target_os = "macos", test))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DistributionMetadata {
    pub(crate) schema_version: u8,
    pub(crate) version: String,
    pub(crate) distribution: String,
    pub(crate) target: String,
}

#[cfg(any(target_os = "windows", target_os = "macos", test))]
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

#[cfg(any(target_os = "windows", target_os = "macos", test))]
pub(crate) fn verify_artifact(path: &Path, expected: &str) -> Result<(), Box<dyn Error>> {
    let actual = sha256_file(path)?;
    if actual != expected {
        return Err(
            format!("update artifact SHA-256 mismatch: expected {expected}, got {actual}").into(),
        );
    }
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "macos", test))]
fn distribution_metadata(path: &Path) -> Result<DistributionMetadata, Box<dyn Error>> {
    let metadata = serde_json::from_slice::<DistributionMetadata>(&fs::read(path)?)?;
    if metadata.schema_version != 1 || metadata.target.is_empty() {
        return Err("installed distribution metadata is invalid".into());
    }
    validate_version(&metadata.version)?;
    Ok(metadata)
}

#[cfg(any(target_os = "windows", target_os = "macos", test))]
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

#[cfg(not(target_os = "windows"))]
fn run_checked(command: &mut Command, label: &str) -> Result<(), Box<dyn Error>> {
    let status = command.status()?;
    if !status.success() {
        return Err(format!("{label} failed with {status}").into());
    }
    Ok(())
}

#[cfg(any(not(target_os = "windows"), test))]
fn npm_install_arguments(
    version: &str,
    prefix: Option<&std::path::Path>,
) -> Vec<std::ffi::OsString> {
    let mut args = ["install", "--global", "--no-audit", "--no-fund"]
        .into_iter()
        .map(std::ffi::OsString::from)
        .collect::<Vec<_>>();
    if let Some(prefix) = prefix {
        args.push("--prefix".into());
        args.push(prefix.as_os_str().to_owned());
    }
    args.push(format!("{NPM_PACKAGE_NAME}@{version}").into());
    args
}

fn install_npm(
    request: &UpdateRequest,
    npm: &NpmInstallation,
    before_write: &mut dyn FnMut() -> Result<(), Box<dyn Error>>,
) -> Result<(), Box<dyn Error>> {
    #[cfg(target_os = "windows")]
    {
        let arch = crate::windows_installation::architecture();
        crate::windows_installation::validate_npm(npm, arch, &request.wait_executable)?;
        let prefix = npm.prefix.as_deref().ok_or("missing Windows npm prefix")?;
        let materials = npm
            .prepared
            .as_ref()
            .ok_or("missing Windows npm offline materials")?;
        crate::npm_prepared::validate(
            materials,
            request
                .status_path
                .parent()
                .ok_or("missing operation directory")?,
            prefix,
        )?;
        crate::npm_prepared::validate_recovery(
            npm.recovery.as_ref().ok_or("missing old npm materials")?,
            request
                .status_path
                .parent()
                .ok_or("missing operation directory")?,
            prefix,
        )?;
        crate::npm_prepared::preflight(npm)?;
        crate::npm_prepared::install(
            &npm.node_path,
            &npm.npm_cli_path,
            materials,
            prefix,
            before_write,
        )?;
        verify_npm_target(prefix, &request.version, arch)
            .map_err(|error| crate::npm_prepared::install_failure(error.to_string(), true))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut command = Command::new(&npm.node_path);
        command
            .arg(&npm.npm_cli_path)
            .args(npm_install_arguments(&request.version, None));
        before_write()?;
        run_checked(&mut command, "npm update")
    }
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn verify_npm_target(
    prefix: &Path,
    version: &str,
    architecture: &str,
) -> Result<(), Box<dyn Error>> {
    let name = format!("@codexhost/cli-win32-{architecture}");
    for (package, expected) in [
        (
            prefix.join("node_modules/@codexhost/cli"),
            "@codexhost/cli".to_owned(),
        ),
        (prefix.join("node_modules").join(&name), name.clone()),
    ] {
        let file = package.join("package.json");
        crate::windows_installation::owned_file(prefix, &file)?;
        let manifest: serde_json::Value = serde_json::from_slice(&fs::read(file)?)?;
        if manifest["name"] != expected || manifest["version"] != version {
            return Err("npm installed package version does not match the target".into());
        }
    }
    crate::windows_installation::metadata(
        &prefix.join("node_modules").join(name),
        version,
        "npm",
        architecture,
    )
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn windows_installer_arguments(
    windows: &WindowsInstallation,
) -> Vec<std::ffi::OsString> {
    let mut directory = std::ffi::OsString::from("/DIR=");
    directory.push(&windows.install_root);
    let mut args = [
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        "/NOCLOSEAPPLICATIONS",
        "/NORESTARTAPPLICATIONS",
        "/RESTARTEXITCODE=3010",
        "/SP-",
    ]
    .into_iter()
    .map(std::ffi::OsString::from)
    .collect::<Vec<_>>();
    args.push(directory);
    args
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn install_windows_with_runner(
    request: &UpdateRequest,
    windows: &WindowsInstallation,
    architecture: &str,
    before_write: &mut dyn FnMut() -> Result<(), Box<dyn Error>>,
    run: impl FnOnce(&mut Command, &str) -> Result<(), Box<dyn Error>>,
) -> Result<(), Box<dyn Error>> {
    crate::windows_installation::validate_installer(
        windows,
        architecture,
        &request.wait_executable,
    )?;
    verify_artifact(&windows.installer_path, &windows.artifact_sha256)?;
    if windows.recovery.is_some() {
        crate::installer_recovery::preflight(
            windows,
            request
                .status_path
                .parent()
                .ok_or("missing installer operation")?,
            &request.version,
            architecture,
        )?;
    }
    let mut command = Command::new(&windows.installer_path);
    command.args(windows_installer_arguments(windows));
    if windows.recovery.is_some() {
        let mut log = std::ffi::OsString::from("/LOG=");
        log.push(
            request
                .status_path
                .parent()
                .ok_or("missing operation")?
                .join("install-inno.log"),
        );
        command.arg(log);
        command.arg(crate::installer_recovery::replacement_argument(
            &request
                .status_path
                .parent()
                .ok_or("missing operation")?
                .join("previous-files.txt"),
        ));
    }
    configure_background_command(&mut command);
    before_write()?;
    let result = run(&mut command, "Windows installer");
    let tool_stopped = result.is_ok()
        || result
            .as_ref()
            .err()
            .and_then(|e| e.downcast_ref::<crate::installer_recovery::ToolFailure>())
            .is_some_and(crate::installer_recovery::ToolFailure::may_restore);
    let result = result.and_then(|()| {
        verify_distribution(
            &windows.install_root.join("app").join(DISTRIBUTION_FILE),
            &request.version,
            "installer",
        )?;
        if windows.recovery.is_some() {
            crate::installer_recovery::verify_target(
                windows,
                request.status_path.parent().ok_or("missing operation")?,
                &request.version,
                architecture,
            )?;
        }
        Ok(())
    });
    result.map_err(|error| {
        if tool_stopped {
            crate::installer_recovery::stopped_failure(error)
        } else {
            error
        }
    })
}

#[cfg(target_os = "windows")]
fn install_windows(
    request: &UpdateRequest,
    windows: &WindowsInstallation,
    before_write: &mut dyn FnMut() -> Result<(), Box<dyn Error>>,
) -> Result<(), Box<dyn Error>> {
    if windows.recovery.is_none() {
        return Err("original installer recovery capability unavailable; manual original-directory repair required".into());
    }
    install_windows_with_runner(
        request,
        windows,
        crate::windows_installation::architecture(),
        before_write,
        crate::installer_recovery::run_installer,
    )
}

#[cfg(not(target_os = "windows"))]
fn install_windows(
    _request: &UpdateRequest,
    _windows: &WindowsInstallation,
    _before_write: &mut dyn FnMut() -> Result<(), Box<dyn Error>>,
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

pub(crate) fn install(
    request: &UpdateRequest,
    mut before_write: impl FnMut() -> Result<(), Box<dyn Error>>,
) -> Result<(), Box<dyn Error>> {
    match &request.installation {
        Installation::Npm(npm) => install_npm(request, npm, &mut before_write),
        Installation::WindowsInstaller(windows) => {
            install_windows(request, windows, &mut before_write)
        }
        Installation::MacosDmg(macos) => install_macos(request, macos),
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn relaunch(request: &UpdateRequest) -> Result<Child, Box<dyn Error>> {
    Ok(relaunch_command(request, cfg!(target_os = "windows")).spawn()?)
}

#[cfg(target_os = "windows")]
pub(crate) fn relaunch_in_job(request: &UpdateRequest, key: &str) -> std::io::Result<Child> {
    relaunch_command(request, true)
        .args(["--update-job", key])
        .spawn()
}

fn relaunch_command(request: &UpdateRequest, windows: bool) -> Command {
    let mut command = match &request.installation {
        Installation::Npm(npm) => {
            let mut command = Command::new(&npm.node_path);
            command.arg(&npm.npm_launcher_path);
            if windows {
                command.args(["launch", "--preserve-external-desktop"]);
                configure_background_command(&mut command);
            }
            command
        }
        Installation::WindowsInstaller(windows) => {
            let mut command = Command::new(windows.install_root.join("bin/codexhost.exe"));
            command.args(["launch", "--preserve-external-desktop"]);
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
    command
}

#[cfg(all(test, target_os = "windows"))]
#[path = "windows_installer_recovery_tests.rs"]
mod installer_recovery_tests;

#[cfg(test)]
#[path = "relaunch_tests.rs"]
mod relaunch_tests;

#[cfg(all(test, any(target_os = "windows", target_os = "macos")))]
mod tests {
    use super::DistributionMetadata;

    #[test]
    fn npm_preserves_existing_unix_arguments_and_pins_windows_prefix() {
        let unix = super::npm_install_arguments("1.2.3", None);
        assert_eq!(
            unix,
            [
                "install",
                "--global",
                "--no-audit",
                "--no-fund",
                "@codexhost/cli@1.2.3"
            ]
            .map(std::ffi::OsString::from)
        );
        let prefix = std::path::Path::new("C:/中文 空格/original-prefix");
        let windows = super::npm_install_arguments("1.2.3", Some(prefix));
        assert_eq!(windows[4], "--prefix");
        assert_eq!(windows[5], prefix.as_os_str());
        assert_eq!(windows[6], "@codexhost/cli@1.2.3");
    }

    #[test]
    fn distribution_metadata_rejects_unknown_fields() {
        let metadata = br#"{"schemaVersion":1,"version":"1.2.3","distribution":"npm","target":"macos-arm64","extra":true}"#;
        assert!(serde_json::from_slice::<DistributionMetadata>(metadata).is_err());
    }
}
