#![deny(unsafe_code)]

use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io;
use std::path::{Path, PathBuf};

mod desktop_launch;
mod installation;
mod process;
mod process_supervision;
#[cfg(target_os = "windows")]
#[allow(unsafe_code)]
mod windows_process;

pub use desktop_launch::launch_desktop;
#[cfg(target_os = "macos")]
pub use desktop_launch::{DesktopSession, launch_desktop_session};
pub use installation::discover_codex_desktop;
pub use process::{ProcessSnapshot, desktop_process_ids, parent_process_id, process_exists};
#[cfg(target_os = "macos")]
pub use process::{desktop_process_tree, process_snapshot, process_snapshots};
pub use process_supervision::{ChildProcessGuard, SupervisedChild, spawn_supervised};

pub const CRATE_NAME: &str = "codexhost-platform";
pub const CODEX_CLI_PATH_ENV: &str = "CODEX_CLI_PATH";
pub const STOCK_CODEX_PATH_ENV: &str = "CODEXHOST_STOCK_CODEX_PATH";
pub const PROBE_PACKAGE_NAME_ENV: &str = "CODEXHOST_PROBE_PACKAGE_NAME";
pub const PROBE_PACKAGE_FAMILY_ENV: &str = "CODEXHOST_PROBE_PACKAGE_FAMILY";
pub const PROBE_DESKTOP_VERSION_ENV: &str = "CODEXHOST_PROBE_DESKTOP_VERSION";
pub const PROBE_INSTALL_ROOT_ENV: &str = "CODEXHOST_PROBE_INSTALL_ROOT";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopLaunchMode {
    LaunchServices,
    DirectExecutable,
}

impl DesktopLaunchMode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::LaunchServices => "launch-services",
            Self::DirectExecutable => "direct-executable",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopIdentity {
    WindowsPackage {
        package_name: String,
        package_family_name: String,
    },
    MacOsBundle {
        bundle_identifier: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopInstallation {
    pub identity: DesktopIdentity,
    pub version: String,
    pub install_root: PathBuf,
    pub desktop_executable: PathBuf,
    pub packaged_codex_cli: PathBuf,
    pub executable_codex_cli: PathBuf,
}

#[derive(Debug)]
pub enum PlatformError {
    Unsupported(&'static str),
    NotFound(String),
    Invalid(String),
    Io(io::Error),
}

impl Display for PlatformError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported(message) => write!(formatter, "{message}"),
            Self::NotFound(message) => write!(formatter, "{message}"),
            Self::Invalid(message) => write!(formatter, "{message}"),
            Self::Io(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for PlatformError {}

impl From<io::Error> for PlatformError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

pub fn canonical_existing_file(path: &Path) -> Result<PathBuf, PlatformError> {
    if !path.is_file() {
        return Err(PlatformError::NotFound(format!(
            "executable path '{}' does not exist or is not a file",
            path.display()
        )));
    }
    path.canonicalize().map_err(PlatformError::Io)
}

fn comparable_path(path: &Path) -> Result<String, PlatformError> {
    let canonical = canonical_existing_file(path)?;
    let value = canonical.to_string_lossy().replace('/', "\\");
    Ok(if cfg!(target_os = "windows") {
        value.to_lowercase()
    } else {
        value
    })
}

pub fn validate_proxy_target(shim: &Path, target: &Path) -> Result<PathBuf, PlatformError> {
    let shim_identity = comparable_path(shim)?;
    let target_identity = comparable_path(target)?;
    if shim_identity == target_identity {
        return Err(PlatformError::Invalid(format!(
            "official Codex CLI resolves to the Shim itself: {}",
            target.display()
        )));
    }
    canonical_existing_file(target)
}

#[cfg(test)]
fn temporary_directory(prefix: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_ID: AtomicU64 = AtomicU64::new(0);
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "{prefix}-{}-{}-{unique}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir(&directory).expect("create unique temp directory");
    directory
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{CRATE_NAME, PlatformError, temporary_directory, validate_proxy_target};

    fn temporary_file(name: &str) -> std::path::PathBuf {
        let path = temporary_directory("codexhost-platform").join(name);
        fs::write(&path, b"test").expect("create temp file");
        path
    }

    #[test]
    fn exposes_the_platform_crate_identity() {
        assert_eq!(CRATE_NAME, "codexhost-platform");
    }

    #[test]
    fn rejects_proxy_recursion() {
        let shim = temporary_file("shim.exe");
        let error = validate_proxy_target(&shim, &shim).expect_err("same path must fail");
        assert!(matches!(error, PlatformError::Invalid(_)));
    }

    #[test]
    fn accepts_distinct_existing_target() {
        let shim = temporary_file("shim.exe");
        let target = shim.parent().expect("parent").join("codex.exe");
        fs::write(&target, b"target").expect("create target");
        assert_eq!(
            validate_proxy_target(&shim, &target).expect("distinct target"),
            target.canonicalize().expect("canonical target")
        );
    }

    #[test]
    fn rejects_missing_target() {
        let shim = temporary_file("shim.exe");
        let target = shim.parent().expect("parent").join("missing.exe");
        assert!(matches!(
            validate_proxy_target(&shim, &target),
            Err(PlatformError::NotFound(_))
        ));
    }
}
