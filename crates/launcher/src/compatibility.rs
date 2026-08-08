use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use codexhost_platform::{DesktopIdentity, DesktopInstallation, atomic_replace_file};
use serde::{Deserialize, Serialize};

pub const MAX_CONTROLLER_READINESS_LINE_BYTES: usize = 513;
const CONTROLLER_READINESS_SCHEMA_VERSION: u8 = 1;
const ACKNOWLEDGEMENT_SCHEMA_VERSION: u8 = 1;
const ACKNOWLEDGEMENT_FILE: &str = "compatibility-warning-v1.json";
const MAX_ACKNOWLEDGEMENT_BYTES: usize = 2_048;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CompatibilityCapability {
    TitleIsolation,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CompatibilityReason {
    UnreviewedTitleServiceIdentity,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CompatibilityWarning {
    pub capability: CompatibilityCapability,
    pub reason: CompatibilityReason,
    pub observed_identity: String,
}

impl CompatibilityWarning {
    fn validate(&self) -> Result<(), String> {
        let mut bytes = self.observed_identity.bytes();
        let Some(first) = bytes.next() else {
            return Err("compatibility warning identity is empty".into());
        };
        if self.observed_identity.len() > 64
            || !(first.is_ascii_alphabetic() || first == b'_' || first == b'$')
            || !bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$')
        {
            return Err("compatibility warning identity is invalid".into());
        }
        Ok(())
    }

    #[must_use]
    pub fn reason_code(&self) -> &'static str {
        match self.reason {
            CompatibilityReason::UnreviewedTitleServiceIdentity => {
                "unreviewed-title-service-identity"
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ControllerReadiness {
    schema_version: u8,
    state: ReadyState,
    pub warnings: Vec<CompatibilityWarning>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum ReadyState {
    Ready,
}

impl ControllerReadiness {
    fn validate(&self) -> Result<(), String> {
        if self.schema_version != CONTROLLER_READINESS_SCHEMA_VERSION {
            return Err(format!(
                "unsupported Desktop Controller readiness version {}",
                self.schema_version
            ));
        }
        if self.warnings.len() > 1 {
            return Err("Desktop Controller readiness has too many warnings".into());
        }
        for warning in &self.warnings {
            warning.validate()?;
        }
        Ok(())
    }
}

pub fn parse_controller_readiness_line(bytes: &[u8]) -> Result<ControllerReadiness, String> {
    if bytes.is_empty() || bytes.len() > MAX_CONTROLLER_READINESS_LINE_BYTES {
        return Err("Desktop Controller readiness line has an invalid size".into());
    }
    if !bytes.ends_with(b"\n") || bytes[..bytes.len() - 1].contains(&b'\n') {
        return Err(
            "Desktop Controller readiness must be exactly one newline-terminated line".into(),
        );
    }
    let payload = &bytes[..bytes.len() - 1];
    if payload.contains(&b'\r') {
        return Err("Desktop Controller readiness contains an invalid carriage return".into());
    }
    let readiness = serde_json::from_slice::<ControllerReadiness>(payload)
        .map_err(|error| format!("invalid Desktop Controller readiness: {error}"))?;
    readiness.validate()?;
    Ok(readiness)
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", deny_unknown_fields, rename_all = "kebab-case")]
enum AcknowledgedDesktopIdentity {
    WindowsPackage {
        package_name: String,
        package_family_name: String,
    },
    MacOsBundle {
        bundle_identifier: String,
    },
}

impl From<&DesktopIdentity> for AcknowledgedDesktopIdentity {
    fn from(identity: &DesktopIdentity) -> Self {
        match identity {
            DesktopIdentity::WindowsPackage {
                package_name,
                package_family_name,
            } => Self::WindowsPackage {
                package_name: package_name.clone(),
                package_family_name: package_family_name.clone(),
            },
            DesktopIdentity::MacOsBundle { bundle_identifier } => Self::MacOsBundle {
                bundle_identifier: bundle_identifier.clone(),
            },
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CompatibilityAcknowledgementKey {
    desktop_identity: AcknowledgedDesktopIdentity,
    desktop_version: String,
    desktop_build: String,
    desktop_asar_integrity: String,
    codexhost_version: String,
    warning: CompatibilityWarning,
}

impl CompatibilityAcknowledgementKey {
    pub fn new(
        installation: &DesktopInstallation,
        warning: &CompatibilityWarning,
    ) -> Result<Self, String> {
        warning.validate()?;
        for (label, value, maximum) in [
            ("Desktop version", installation.version.as_str(), 64_usize),
            ("Desktop build", installation.build.as_str(), 64),
            ("codexhost version", env!("CARGO_PKG_VERSION"), 64),
        ] {
            if value.is_empty() || value.len() > maximum || !value.is_ascii() {
                return Err(format!(
                    "{label} is invalid for compatibility acknowledgement"
                ));
            }
        }
        if installation.asar_integrity.len() != 71
            || !installation.asar_integrity.starts_with("sha256:")
            || !installation.asar_integrity[7..]
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(
                "Desktop ASAR integrity is invalid for compatibility acknowledgement".into(),
            );
        }
        Ok(Self {
            desktop_identity: (&installation.identity).into(),
            desktop_version: installation.version.clone(),
            desktop_build: installation.build.clone(),
            desktop_asar_integrity: installation.asar_integrity.clone(),
            codexhost_version: env!("CARGO_PKG_VERSION").into(),
            warning: warning.clone(),
        })
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CompatibilityAcknowledgement {
    schema_version: u8,
    key: CompatibilityAcknowledgementKey,
}

fn safe_regular_file(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.file_type().is_file()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

pub fn default_acknowledgement_path() -> io::Result<PathBuf> {
    #[cfg(target_os = "windows")]
    let root = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "LOCALAPPDATA is unavailable"))?;

    #[cfg(target_os = "macos")]
    let root = env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join("Library").join("Application Support"))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is unavailable"))?;

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let root = env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is unavailable"))?;

    Ok(root.join("codexhost").join(ACKNOWLEDGEMENT_FILE))
}

pub fn acknowledgement_matches(path: &Path, expected: &CompatibilityAcknowledgementKey) -> bool {
    if !safe_regular_file(path).unwrap_or(false) {
        return false;
    }
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    if bytes.len() > MAX_ACKNOWLEDGEMENT_BYTES {
        return false;
    }
    let Ok(value) = serde_json::from_slice::<CompatibilityAcknowledgement>(&bytes) else {
        return false;
    };
    value.schema_version == ACKNOWLEDGEMENT_SCHEMA_VERSION && value.key == *expected
}

pub fn write_acknowledgement(path: &Path, key: &CompatibilityAcknowledgementKey) -> io::Result<()> {
    if path.exists() && !safe_regular_file(path)? {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "compatibility acknowledgement is not a regular file",
        ));
    }
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "compatibility acknowledgement has no parent",
        )
    })?;
    fs::create_dir_all(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    }
    let temporary = parent.join(format!(
        ".{ACKNOWLEDGEMENT_FILE}.{}.tmp",
        std::process::id()
    ));
    let value = CompatibilityAcknowledgement {
        schema_version: ACKNOWLEDGEMENT_SCHEMA_VERSION,
        key: key.clone(),
    };
    let bytes = serde_json::to_vec(&value).map_err(io::Error::other)?;
    if bytes.len() > MAX_ACKNOWLEDGEMENT_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "compatibility acknowledgement exceeds its size limit",
        ));
    }
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        atomic_replace_file(&temporary, path).map_err(io::Error::other)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use std::fs;

    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    use codexhost_platform::{DesktopIdentity, DesktopInstallation};

    use super::*;

    fn warning(identity: &str) -> CompatibilityWarning {
        CompatibilityWarning {
            capability: CompatibilityCapability::TitleIsolation,
            reason: CompatibilityReason::UnreviewedTitleServiceIdentity,
            observed_identity: identity.into(),
        }
    }

    fn installation(version: &str) -> DesktopInstallation {
        DesktopInstallation {
            identity: DesktopIdentity::MacOsBundle {
                bundle_identifier: "com.openai.codex".into(),
            },
            version: version.into(),
            build: "6321".into(),
            asar_integrity: format!("sha256:{}", "a".repeat(64)),
            install_root: "/Applications/ChatGPT.app".into(),
            desktop_executable: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT".into(),
            packaged_codex_cli: "/Applications/ChatGPT.app/Contents/Resources/codex".into(),
            executable_codex_cli: "/Applications/ChatGPT.app/Contents/Resources/codex".into(),
        }
    }

    fn fixture_path(label: &str) -> PathBuf {
        let directory = env::temp_dir().join(format!("{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir(&directory).expect("create compatibility fixture directory");
        directory.join("compatibility.json")
    }

    #[test]
    fn parses_only_the_strict_bounded_readiness_schema() {
        let mut valid = br#"{"schemaVersion":1,"state":"ready","warnings":[{"capability":"title-isolation","reason":"unreviewed-title-service-identity","observedIdentity":"futureClass"}]}"#.to_vec();
        valid.push(b'\n');
        assert_eq!(
            parse_controller_readiness_line(&valid)
                .expect("valid readiness")
                .warnings,
            vec![warning("futureClass")]
        );
        assert!(parse_controller_readiness_line(b"ready\n").is_err());
        let mut unknown =
            br#"{"schemaVersion":1,"state":"ready","warnings":[],"extra":true}"#.to_vec();
        unknown.push(b'\n');
        assert!(parse_controller_readiness_line(&unknown).is_err());
        assert!(
            parse_controller_readiness_line(&vec![b'a'; MAX_CONTROLLER_READINESS_LINE_BYTES + 1])
                .is_err()
        );
    }

    #[test]
    fn acknowledgement_matches_only_the_complete_fingerprint() {
        let path = fixture_path("codexhost-ack-match");
        let first = CompatibilityAcknowledgementKey::new(&installation("26.1"), &warning("abc"))
            .expect("first key");
        write_acknowledgement(&path, &first).expect("write acknowledgement");
        assert!(acknowledgement_matches(&path, &first));

        let changed = CompatibilityAcknowledgementKey::new(&installation("26.2"), &warning("abc"))
            .expect("changed key");
        assert!(!acknowledgement_matches(&path, &changed));
        fs::remove_dir_all(path.parent().expect("fixture parent"))
            .expect("remove acknowledgement fixture");
    }

    #[test]
    fn malformed_acknowledgement_is_unconfirmed() {
        let path = fixture_path("codexhost-ack-malformed");
        fs::write(&path, b"not-json").expect("write malformed acknowledgement");
        let key = CompatibilityAcknowledgementKey::new(&installation("26.1"), &warning("abc"))
            .expect("key");
        assert!(!acknowledgement_matches(&path, &key));
        fs::remove_dir_all(path.parent().expect("fixture parent"))
            .expect("remove malformed acknowledgement fixture");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_acknowledgement_is_rejected() {
        let path = fixture_path("codexhost-ack-symlink");
        let target = path.with_extension("target");
        fs::write(&target, b"{}").expect("write symlink target");
        symlink(&target, &path).expect("create acknowledgement symlink");
        let key = CompatibilityAcknowledgementKey::new(&installation("26.1"), &warning("abc"))
            .expect("key");
        assert!(!acknowledgement_matches(&path, &key));
        assert!(write_acknowledgement(&path, &key).is_err());
        fs::remove_dir_all(path.parent().expect("fixture parent")).expect("remove symlink fixture");
    }
}
