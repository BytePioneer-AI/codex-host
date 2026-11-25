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

fn install_npm(
    request: &UpdateRequest,
    npm: &NpmInstallation,
    specs: &[String],
) -> Result<(), Box<dyn Error>> {
    // The installer runs this step itself for an EXE install. npm does not, so close
    // what still runs from the platform package (for example a Shim the stopped
    // Desktop left behind) before npm replaces those locked executables. The shared
    // Node runtime is not a target.
    #[cfg(target_os = "windows")]
    crate::prepare_install::prepare(&npm.npm_package_root)?;
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
        ])
        .args(specs);
    configure_background_command(&mut command);
    if let Some(log) = operation_log(request, "npm-install.log") {
        command.stdout(log.try_clone()?).stderr(log);
    }
    run_checked(&mut command, "npm update")?;
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
pub(crate) fn install(request: &UpdateRequest, npm_specs: &[String]) -> Result<(), Box<dyn Error>> {
    match &request.installation {
        Installation::Npm(npm) => install_npm(request, npm, npm_specs),
        Installation::WindowsInstaller(windows) => install_windows(request, windows),
        Installation::MacosDmg(macos) => install_macos(request, macos),
        Installation::LinuxArchive(linux) => install_linux(request, linux),
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
            result.unwrap();
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
