use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

const REQUEST_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct UpdateRequest {
    pub(crate) schema_version: u8,
    pub(crate) version: String,
    pub(crate) wait_pid: u32,
    pub(crate) wait_executable: PathBuf,
    #[serde(default)]
    pub(crate) launch_via_launcher: bool,
    #[cfg(any(target_os = "windows", test))]
    pub(crate) wait_started_at_micros: Option<String>,
    pub(crate) runtime_descriptor_path: PathBuf,
    pub(crate) status_path: PathBuf,
    pub(crate) installation: Installation,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum Installation {
    Npm(NpmInstallation),
    WindowsInstaller(WindowsInstallation),
    MacosDmg(MacOsInstallation),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NpmInstallation {
    pub(crate) node_path: PathBuf,
    pub(crate) npm_cli_path: PathBuf,
    pub(crate) npm_launcher_path: PathBuf,
    #[cfg(any(target_os = "windows", test))]
    pub(crate) prefix: Option<PathBuf>,
    #[cfg(any(target_os = "windows", test))]
    pub(crate) package_root: Option<PathBuf>,
    #[cfg(any(target_os = "windows", test))]
    pub(crate) installed_version: Option<String>,
    #[cfg(any(target_os = "windows", test))]
    pub(crate) prepared: Option<Box<crate::npm_prepared::Materials>>,
    #[cfg(any(target_os = "windows", test))]
    pub(crate) recovery: Option<Box<crate::npm_prepared::Materials>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WindowsInstallation {
    pub(crate) installer_path: PathBuf,
    pub(crate) artifact_sha256: String,
    pub(crate) install_root: PathBuf,
    #[cfg(any(target_os = "windows", test))]
    pub(crate) recovery: Option<Box<crate::installer_recovery::Materials>>,
    #[cfg(any(target_os = "windows", test))]
    pub(crate) installed_version: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MacOsInstallation {
    pub(crate) dmg_path: PathBuf,
    pub(crate) artifact_sha256: String,
    pub(crate) app_path: PathBuf,
}

impl Installation {
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::Npm(_) => "npm",
            Self::WindowsInstaller(_) => "windows-installer",
            Self::MacosDmg(_) => "macos-dmg",
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

impl UpdateRequest {
    pub(crate) fn parse(path: &Path) -> Result<Self, Box<dyn Error>> {
        require_absolute_file(path, "update request")?;
        let request = serde_json::from_slice::<Self>(&fs::read(path)?)?;
        request.validate()?;
        Ok(request)
    }

    #[cfg(any(target_os = "windows", test))]
    pub(crate) fn matches_wait_instance(
        &self,
        current: &codexhost_platform::ProcessSnapshot,
    ) -> bool {
        current.id == self.wait_pid
            && self.wait_started_at_micros.as_deref()
                == Some(current.started_at_micros.to_string().as_str())
            && crate::windows_installation::same_path(&current.executable, &self.wait_executable)
    }

    fn validate_common(&self) -> Result<(), String> {
        if self.schema_version != REQUEST_SCHEMA_VERSION {
            return Err(format!(
                "unsupported update request schema version {}",
                self.schema_version
            ));
        }
        if self.launch_via_launcher && !cfg!(target_os = "windows") {
            return Err("Launcher delegation is only used for Windows Desktop updates".into());
        }
        validate_version(&self.version)?;
        if self.wait_pid == 0 || self.wait_pid == std::process::id() {
            return Err("wait PID must identify the live Launcher".into());
        }
        require_absolute_file(&self.wait_executable, "Launcher executable")?;
        #[cfg(target_os = "windows")]
        if self
            .wait_started_at_micros
            .as_deref()
            .and_then(|value| value.parse::<u64>().ok())
            .is_none_or(|value| value == 0)
        {
            return Err("Windows update request is missing a valid owner creation time".into());
        }
        require_absolute_path(&self.runtime_descriptor_path, "runtime descriptor path")?;
        require_absolute_path(&self.status_path, "update status path")?;
        Ok(())
    }

    fn validate_installer_files(windows: &WindowsInstallation) -> Result<(), String> {
        require_absolute_file(&windows.installer_path, "Windows installer")?;
        require_absolute_path(&windows.install_root, "Windows install root")?;
        if !valid_sha256(&windows.artifact_sha256) {
            return Err("Windows installer SHA-256 must be lowercase hexadecimal".into());
        }
        Ok(())
    }

    #[cfg(any(target_os = "windows", test))]
    fn validate_windows_installer(
        &self,
        windows: &WindowsInstallation,
        architecture: &str,
    ) -> Result<(), String> {
        Self::validate_installer_files(windows)?;
        crate::windows_installation::validate_installer(
            windows,
            architecture,
            &self.wait_executable,
        )
        .map_err(|e| e.to_string())?;
        crate::installer_recovery::preflight(
            windows,
            self.status_path
                .parent()
                .ok_or("missing operation directory")?,
            &self.version,
            architecture,
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // Test-only entry uses the same schema/common/material validators without
    // claiming host OS or native handoff. No production argument can select it.
    #[cfg(test)]
    pub(crate) fn parse_windows_fixture(path: &Path) -> Result<Self, Box<dyn Error>> {
        require_absolute_file(path, "update request")?;
        let request = serde_json::from_slice::<Self>(&fs::read(path)?)?;
        request.validate_common()?;
        let Installation::WindowsInstaller(windows) = &request.installation else {
            return Err("fixture must be an installer".into());
        };
        request.validate_windows_installer(windows, "x64")?;
        Ok(request)
    }

    fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        match &self.installation {
            Installation::Npm(npm) => {
                require_absolute_file(&npm.node_path, "npm Node.js executable")?;
                require_absolute_file(&npm.npm_cli_path, "npm CLI")?;
                require_absolute_file(&npm.npm_launcher_path, "npm codexhost launcher")?;
                #[cfg(target_os = "windows")]
                {
                    crate::windows_installation::validate_npm(
                        npm,
                        crate::windows_installation::architecture(),
                        &self.wait_executable,
                    )
                    .map_err(|error| error.to_string())?;
                    crate::npm_prepared::validate(
                        npm.prepared
                            .as_ref()
                            .ok_or("Windows npm request has no prepared offline materials")?,
                        self.status_path
                            .parent()
                            .ok_or("missing operation directory")?,
                        npm.prefix.as_ref().ok_or("missing npm prefix")?,
                    )
                    .map_err(|error| error.to_string())?;
                    crate::npm_prepared::validate_recovery(
                        npm.recovery
                            .as_ref()
                            .ok_or("Windows npm request has no old-version offline materials")?,
                        self.status_path
                            .parent()
                            .ok_or("missing operation directory")?,
                        npm.prefix.as_ref().ok_or("missing npm prefix")?,
                    )
                    .map_err(|error| error.to_string())?;
                    crate::npm_prepared::preflight(npm).map_err(|error| error.to_string())?;
                }
            }
            Installation::WindowsInstaller(windows) => {
                if !cfg!(target_os = "windows") {
                    return Err("Windows installer updates require Windows".into());
                }
                #[cfg(target_os = "windows")]
                self.validate_windows_installer(
                    windows,
                    crate::windows_installation::architecture(),
                )?;
                #[cfg(not(target_os = "windows"))]
                Self::validate_installer_files(windows)?;
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
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{UpdateRequest, valid_sha256, validate_version};

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
}
