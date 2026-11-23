use std::error::Error;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

const REQUEST_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct UpdateRequest {
    pub(crate) schema_version: u8,
    pub(crate) version: String,
    pub(crate) wait_pid: u32,
    pub(crate) wait_executable: PathBuf,
    pub(crate) runtime_descriptor_path: PathBuf,
    #[serde(default)]
    pub(crate) restart_target: RestartTarget,
    #[serde(default)]
    pub(crate) data_directory: Option<PathBuf>,
    #[serde(default)]
    pub(crate) service_managed: bool,
    pub(crate) status_path: PathBuf,
    pub(crate) installation: Installation,
}

#[derive(Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RestartTarget {
    #[default]
    Desktop,
    Web,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum Installation {
    Npm(NpmInstallation),
    WindowsInstaller(WindowsInstallation),
    MacosDmg(MacOsInstallation),
    LinuxArchive(LinuxArchiveInstallation),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NpmInstallation {
    pub(crate) node_path: PathBuf,
    pub(crate) npm_cli_path: PathBuf,
    pub(crate) npm_launcher_path: PathBuf,
    /// The platform package whose executables Windows must close before npm replaces them.
    pub(crate) npm_package_root: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WindowsInstallation {
    pub(crate) installer_path: PathBuf,
    pub(crate) artifact_sha256: String,
    pub(crate) install_root: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MacOsInstallation {
    pub(crate) dmg_path: PathBuf,
    pub(crate) artifact_sha256: String,
    pub(crate) app_path: PathBuf,
}

/// A user-owned directory extracted from the release `.tar.gz`; updates replace it whole.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LinuxArchiveInstallation {
    pub(crate) archive_path: PathBuf,
    pub(crate) artifact_sha256: String,
    pub(crate) install_root: PathBuf,
}

impl Installation {
    pub(crate) fn resources_root(&self) -> PathBuf {
        match self {
            Self::Npm(npm) => npm.npm_package_root.clone(),
            Self::WindowsInstaller(windows) => windows.install_root.clone(),
            Self::MacosDmg(macos) => macos.app_path.join("Contents/Resources"),
            Self::LinuxArchive(linux) => linux.install_root.clone(),
        }
    }

    pub(crate) fn launcher_path(&self) -> PathBuf {
        let name = format!("codexhost{}", std::env::consts::EXE_SUFFIX);
        match self {
            Self::MacosDmg(macos) => macos.app_path.join("Contents/MacOS").join(name),
            _ => self.resources_root().join("bin").join(name),
        }
    }

    pub(crate) fn node_path(&self) -> PathBuf {
        match self {
            Self::Npm(npm) => npm.node_path.clone(),
            Self::WindowsInstaller(windows) => windows.install_root.join("runtime/node.exe"),
            Self::MacosDmg(macos) => macos.app_path.join("Contents/Resources/runtime/node"),
            Self::LinuxArchive(linux) => linux.install_root.join("runtime/node"),
        }
    }

    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::Npm(_) => "npm",
            Self::WindowsInstaller(_) => "windows-installer",
            Self::MacosDmg(_) => "macos-dmg",
            Self::LinuxArchive(_) => "linux-archive",
        }
    }
}

pub(crate) fn validate_version(version: &str) -> Result<(), String> {
    if version.ends_with('-') || version.ends_with('+') {
        return Err("update version has an empty semantic version identifier".into());
    }
    let (core_and_pre, build) = version.split_once('+').unwrap_or((version, ""));
    if !build.is_empty() && !valid_identifier_list(build) {
        return Err("update version has invalid build metadata".into());
    }
    let (core, prerelease) = core_and_pre.split_once('-').unwrap_or((core_and_pre, ""));
    if !prerelease.is_empty() && !valid_identifier_list(prerelease) {
        return Err("update version has an invalid prerelease".into());
    }
    let numbers = core.split('.').collect::<Vec<_>>();
    if numbers.len() != 3
        || numbers.iter().any(|part| {
            part.is_empty()
                || !part.bytes().all(|byte| byte.is_ascii_digit())
                || (part.len() > 1 && part.starts_with('0'))
        })
    {
        return Err("update version must be semantic version major.minor.patch".into());
    }
    Ok(())
}

fn valid_identifier_list(value: &str) -> bool {
    value.split('.').all(|identifier| {
        !identifier.is_empty()
            && identifier
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })
}

fn require_absolute_file(path: &Path, label: &str) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!("{label} must be an absolute path"));
    }
    if !path.is_file() {
        return Err(format!("{label} '{}' is not a file", path.display()));
    }
    Ok(())
}

fn require_absolute_path(path: &Path, label: &str) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!("{label} must be an absolute path"));
    }
    Ok(())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn normalize_lexical(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(
                    normalized.components().next_back(),
                    Some(Component::Normal(_))
                ) {
                    normalized.pop();
                }
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn resolve_path(path: &Path, depth: u8) -> PathBuf {
    const MAX_SYMLINK_DEPTH: u8 = 16;
    let mut resolved = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => {
                resolved.push(component.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if let Ok(canonical) = fs::canonicalize(&resolved) {
                    resolved = canonical;
                }
                if matches!(
                    resolved.components().next_back(),
                    Some(Component::Normal(_))
                ) {
                    resolved.pop();
                }
            }
            Component::Normal(segment) => {
                resolved.push(segment);
                if let Ok(canonical) = fs::canonicalize(&resolved) {
                    resolved = canonical;
                } else if depth < MAX_SYMLINK_DEPTH
                    && let Ok(target) = fs::read_link(&resolved)
                {
                    let next = if target.is_absolute() {
                        target
                    } else {
                        resolved
                            .parent()
                            .map_or_else(|| target.clone(), |parent| parent.join(&target))
                    };
                    resolved = resolve_path(&next, depth + 1);
                }
            }
        }
    }
    resolved
}

fn path_is_within(candidate: &Path, root: &Path) -> bool {
    if normalize_lexical(candidate).starts_with(normalize_lexical(root)) {
        return true;
    }
    resolve_path(candidate, 0).starts_with(resolve_path(root, 0))
}

pub(crate) fn validate_linux_archive_paths(
    request: &UpdateRequest,
    linux: &LinuxArchiveInstallation,
) -> Result<(), String> {
    if let Some(data) = &request.data_directory
        && path_is_within(data, &linux.install_root)
    {
        return Err("service data directory must not be inside Linux install root".into());
    }
    if path_is_within(&linux.archive_path, &linux.install_root) {
        return Err("Linux release archive must not be inside Linux install root".into());
    }
    if path_is_within(&request.status_path, &linux.install_root) {
        return Err("update status path must not be inside Linux install root".into());
    }
    Ok(())
}

impl UpdateRequest {
    pub(crate) fn parse(path: &Path) -> Result<Self, Box<dyn Error>> {
        require_absolute_file(path, "update request")?;
        let request = serde_json::from_slice::<Self>(&fs::read(path)?)?;
        request.validate()?;
        Ok(request)
    }

    fn validate(&self) -> Result<(), String> {
        if self.schema_version != REQUEST_SCHEMA_VERSION {
            return Err(format!(
                "unsupported update request schema version {}",
                self.schema_version
            ));
        }
        validate_version(&self.version)?;
        if self.wait_pid == 0 || self.wait_pid == std::process::id() {
            return Err("wait PID must identify the live Launcher".into());
        }
        require_absolute_file(&self.wait_executable, "Launcher executable")?;
        require_absolute_path(&self.runtime_descriptor_path, "runtime descriptor path")?;
        require_absolute_path(&self.status_path, "update status path")?;
        if let Some(data) = &self.data_directory {
            require_absolute_path(data, "service data directory")?;
        } else if self.restart_target == RestartTarget::Web || self.service_managed {
            return Err("service updates require an explicit data directory".into());
        }
        match &self.installation {
            Installation::Npm(npm) => {
                require_absolute_file(&npm.node_path, "npm Node.js executable")?;
                require_absolute_file(&npm.npm_cli_path, "npm CLI")?;
                require_absolute_file(&npm.npm_launcher_path, "npm codexhost launcher")?;
                require_absolute_path(&npm.npm_package_root, "npm platform package root")?;
            }
            Installation::WindowsInstaller(windows) => {
                if !cfg!(target_os = "windows") {
                    return Err("Windows installer updates require Windows".into());
                }
                require_absolute_file(&windows.installer_path, "Windows installer")?;
                require_absolute_path(&windows.install_root, "Windows install root")?;
                if !valid_sha256(&windows.artifact_sha256) {
                    return Err("Windows installer SHA-256 must be lowercase hexadecimal".into());
                }
            }
            Installation::MacosDmg(macos) => {
                if !cfg!(target_os = "macos") {
                    return Err("macOS DMG updates require macOS".into());
                }
                require_absolute_file(&macos.dmg_path, "macOS DMG")?;
                require_absolute_path(&macos.app_path, "macOS application path")?;
                if macos.app_path.extension().and_then(|value| value.to_str()) != Some("app") {
                    return Err("macOS application path must end in .app".into());
                }
                if !valid_sha256(&macos.artifact_sha256) {
                    return Err("macOS DMG SHA-256 must be lowercase hexadecimal".into());
                }
            }
            Installation::LinuxArchive(linux) => {
                if !cfg!(target_os = "linux") {
                    return Err("Linux archive updates require Linux".into());
                }
                require_absolute_file(&linux.archive_path, "Linux release archive")?;
                require_absolute_path(&linux.install_root, "Linux install root")?;
                if linux.install_root.parent().is_none() {
                    return Err("Linux install root must have a parent directory".into());
                }
                validate_linux_archive_paths(self, linux)?;
                if !valid_sha256(&linux.artifact_sha256) {
                    return Err("Linux archive SHA-256 must be lowercase hexadecimal".into());
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use super::{
        Installation, LinuxArchiveInstallation, RestartTarget, UpdateRequest, valid_sha256,
        validate_linux_archive_paths, validate_version,
    };

    #[test]
    fn accepts_release_semver_and_rejects_ambiguous_versions() {
        for version in ["1.2.3", "0.1.0-test.2", "2.0.0-beta.1+build.7"] {
            validate_version(version).expect("valid semantic version");
        }
        for version in ["1.2", "01.2.3", "1.2.3/../../tmp", "1.2.3-"] {
            assert!(validate_version(version).is_err(), "accepted {version}");
        }
    }

    #[test]
    fn accepts_only_lowercase_sha256() {
        assert!(valid_sha256(&"ab".repeat(32)));
        assert!(!valid_sha256(&"AB".repeat(32)));
        assert!(!valid_sha256("abcd"));
    }

    #[test]
    fn request_rejects_unknown_installation_fields() {
        let request = br#"{"schema_version":1,"version":"1.2.3","wait_pid":2,"wait_executable":"/tmp/launcher","runtime_descriptor_path":"/tmp/desktop-runtime-v1.json","status_path":"/tmp/status","installation":{"kind":"npm","node_path":"/tmp/node","npm_cli_path":"/tmp/npm","npm_launcher_path":"/tmp/codexhost.js","extra":true}}"#;
        assert!(serde_json::from_slice::<UpdateRequest>(request).is_err());
    }

    #[test]
    fn legacy_requests_default_to_desktop_and_service_requests_require_absolute_data() {
        let root = std::env::temp_dir();
        let executable = std::env::current_exe().unwrap();
        let mut value = serde_json::json!({
            "schema_version":1, "version":"1.2.3", "wait_pid":if std::process::id() == 1 {2} else {1},
            "wait_executable":executable, "runtime_descriptor_path":root.join("desktop.json"),
            "status_path":root.join("status.json"), "installation": {
                "kind":"npm", "node_path":executable, "npm_cli_path":executable,
                "npm_launcher_path":executable, "npm_package_root":root,
            }
        });
        let legacy: UpdateRequest = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(legacy.restart_target, RestartTarget::Desktop);
        assert!(!legacy.service_managed);
        legacy.validate().unwrap();
        value["restart_target"] = "web".into();
        assert!(
            serde_json::from_value::<UpdateRequest>(value.clone())
                .unwrap()
                .validate()
                .is_err()
        );
        value["data_directory"] = "relative/data".into();
        assert!(
            serde_json::from_value::<UpdateRequest>(value.clone())
                .unwrap()
                .validate()
                .is_err()
        );
        value["data_directory"] = serde_json::to_value(root.join("service-data")).unwrap();
        serde_json::from_value::<UpdateRequest>(value.clone())
            .unwrap()
            .validate()
            .unwrap();
        value["restart_target"] = "desktop".into();
        value["service_managed"] = true.into();
        value.as_object_mut().unwrap().remove("data_directory");
        assert!(
            serde_json::from_value::<UpdateRequest>(value)
                .unwrap()
                .validate()
                .is_err()
        );
    }

    fn linux_archive_request(
        install_root: &Path,
        archive_path: &Path,
        status_path: &Path,
        data_directory: Option<PathBuf>,
    ) -> (UpdateRequest, LinuxArchiveInstallation) {
        let executable = std::env::current_exe().unwrap();
        let linux = LinuxArchiveInstallation {
            archive_path: archive_path.to_path_buf(),
            artifact_sha256: "ab".repeat(32),
            install_root: install_root.to_path_buf(),
        };
        let request = UpdateRequest {
            schema_version: 1,
            version: "1.2.3".into(),
            wait_pid: if std::process::id() == 1 { 2 } else { 1 },
            wait_executable: executable,
            runtime_descriptor_path: install_root
                .parent()
                .unwrap()
                .join("desktop-runtime-v1.json"),
            restart_target: RestartTarget::Desktop,
            data_directory,
            service_managed: false,
            status_path: status_path.to_path_buf(),
            installation: Installation::LinuxArchive(LinuxArchiveInstallation {
                archive_path: linux.archive_path.clone(),
                artifact_sha256: linux.artifact_sha256.clone(),
                install_root: linux.install_root.clone(),
            }),
        };
        (request, linux)
    }

    #[test]
    fn linux_archive_rejects_paths_inside_install_root_and_allows_siblings() {
        let root =
            std::env::temp_dir().join(format!("codexhost-linux-path-check-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let install_root = root.join("codexhost");
        fs::create_dir_all(&install_root).unwrap();
        let archive = root.join("update.tar.gz");
        fs::write(&archive, "fixture").unwrap();
        let status = root.join("updates/status.json");
        let sibling_data = root.join("codexhost-data");

        let (valid_request, valid_linux) =
            linux_archive_request(&install_root, &archive, &status, Some(sibling_data));
        validate_linux_archive_paths(&valid_request, &valid_linux).unwrap();

        for (data, arch, stat, expected) in [
            (
                Some(install_root.clone()),
                archive.clone(),
                status.clone(),
                "service data directory",
            ),
            (
                Some(install_root.join("data")),
                archive.clone(),
                status.clone(),
                "service data directory",
            ),
            (
                Some(install_root.join("sub/../data")),
                archive.clone(),
                status.clone(),
                "service data directory",
            ),
            (
                None,
                install_root.join("downloads/update.tar.gz"),
                status.clone(),
                "Linux release archive",
            ),
            (
                None,
                archive.clone(),
                install_root.join("updates/status.json"),
                "update status path",
            ),
        ] {
            let (request, linux) = linux_archive_request(&install_root, &arch, &stat, data);
            let error = validate_linux_archive_paths(&request, &linux).unwrap_err();
            assert!(
                error.contains(expected),
                "expected '{expected}' in '{error}'"
            );
            #[cfg(target_os = "linux")]
            if arch.is_file() {
                assert!(request.validate().is_err());
            }
        }

        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn linux_archive_rejects_symlinked_paths_resolving_into_install_root() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "codexhost-linux-symlink-check-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let install_root = root.join("codexhost");
        let inside_dir = install_root.join("nested");
        fs::create_dir_all(&inside_dir).unwrap();
        let archive = root.join("update.tar.gz");
        fs::write(&archive, "fixture").unwrap();
        let status = root.join("updates/status.json");

        let linked_dir = root.join("linked-dir");
        symlink(&inside_dir, &linked_dir).unwrap();

        // Existing symlink pointing into install_root.
        let (request, linux) =
            linux_archive_request(&install_root, &archive, &status, Some(linked_dir.clone()));
        assert!(validate_linux_archive_paths(&request, &linux).is_err());

        // Non-existent child under a symlinked parent pointing into install_root.
        let (request, linux) = linux_archive_request(
            &install_root,
            &archive,
            &linked_dir.join("future/status.json"),
            None,
        );
        assert!(validate_linux_archive_paths(&request, &linux).is_err());

        // Symlinked archive file inside install_root.
        let archive_in_install = inside_dir.join("release.tar.gz");
        fs::write(&archive_in_install, "fixture").unwrap();
        let linked_archive = root.join("linked-archive.tar.gz");
        symlink(&archive_in_install, &linked_archive).unwrap();
        let (request, linux) = linux_archive_request(&install_root, &linked_archive, &status, None);
        assert!(validate_linux_archive_paths(&request, &linux).is_err());

        // Broken symlink targeting a not-yet-created directory inside install_root.
        let broken_link = root.join("broken-data-link");
        symlink(install_root.join("future-data"), &broken_link).unwrap();
        let (request, linux) =
            linux_archive_request(&install_root, &archive, &status, Some(broken_link));
        assert!(validate_linux_archive_paths(&request, &linux).is_err());

        // Symlinked install_root pointing to the real directory containing data_directory.
        let linked_install = root.join("current-install");
        symlink(&install_root, &linked_install).unwrap();
        let (request, linux) =
            linux_archive_request(&linked_install, &archive, &status, Some(inside_dir.clone()));
        assert!(validate_linux_archive_paths(&request, &linux).is_err());

        fs::remove_dir_all(&root).unwrap();
    }
}
