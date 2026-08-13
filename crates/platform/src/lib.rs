#![deny(unsafe_code)]

use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io;
use std::path::{Path, PathBuf};

#[cfg(target_os = "windows")]
#[allow(unsafe_code)]
mod background;
#[cfg(not(target_os = "windows"))]
mod background;
mod desktop_launch;
mod installation;
#[cfg(target_os = "macos")]
mod macos_ui;
mod process;
mod process_supervision;
#[cfg(target_os = "macos")]
mod system_proxy;
#[cfg(target_os = "windows")]
#[allow(unsafe_code)]
mod windows_desktop;
#[cfg(target_os = "windows")]
#[allow(unsafe_code)]
mod windows_process;
#[cfg(target_os = "windows")]
#[allow(unsafe_code)]
mod windows_ui;

pub use background::detach_from_terminal;
pub use desktop_launch::{
    DesktopProcess, launch_desktop, launch_stock_desktop, open_latest_codexhost_release,
};
#[cfg(target_os = "macos")]
pub use desktop_launch::{DesktopSession, launch_desktop_session};
pub use installation::discover_codex_desktop;
#[cfg(target_os = "macos")]
pub use macos_ui::prompt_compatibility_warning;
pub use process::{
    ProcessSnapshot, descendant_executable_exists, desktop_process_ids, desktop_root_process_ids,
    parent_process_id, process_executable_path, process_exists, terminate_process_by_id,
};
#[cfg(target_os = "macos")]
pub use process::{desktop_process_tree, force_stop_desktop, process_snapshot, process_snapshots};
pub use process_supervision::{ChildProcessGuard, SupervisedChild, spawn_supervised};
#[cfg(target_os = "macos")]
pub use system_proxy::{SystemProxySettings, system_proxy_settings};
#[cfg(target_os = "windows")]
pub use windows_ui::{
    RunningDesktopChoice, hide_console_window, prompt_compatibility_warning,
    prompt_running_desktop, show_error_dialog,
};

pub const CRATE_NAME: &str = "codexhost-platform";
pub const CODEX_CLI_PATH_ENV: &str = "CODEX_CLI_PATH";
pub const STOCK_CODEX_PATH_ENV: &str = "CODEXHOST_STOCK_CODEX_PATH";
pub const PROBE_PACKAGE_NAME_ENV: &str = "CODEXHOST_PROBE_PACKAGE_NAME";
pub const PROBE_PACKAGE_FAMILY_ENV: &str = "CODEXHOST_PROBE_PACKAGE_FAMILY";
pub const PROBE_PACKAGE_FULL_NAME_ENV: &str = "CODEXHOST_PROBE_PACKAGE_FULL_NAME";
pub const PROBE_APP_USER_MODEL_ID_ENV: &str = "CODEXHOST_PROBE_APP_USER_MODEL_ID";
pub const PROBE_DESKTOP_VERSION_ENV: &str = "CODEXHOST_PROBE_DESKTOP_VERSION";
pub const PROBE_INSTALL_ROOT_ENV: &str = "CODEXHOST_PROBE_INSTALL_ROOT";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompatibilityChoice {
    ContinueCodexhost,
    OpenLatestRelease,
    OpenStockCodex,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompatibilityUpdateAvailability {
    Started,
    Current,
    Unavailable,
}

#[derive(Clone, Copy, Debug)]
pub struct CompatibilityPrompt<'a> {
    pub desktop_version: &'a str,
    pub codexhost_version: &'a str,
    pub capability: &'a str,
    pub reason_code: &'a str,
    pub observed_identity: Option<&'a str>,
    pub update_availability: CompatibilityUpdateAvailability,
    pub degraded: bool,
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
#[must_use]
pub fn prompt_compatibility_warning(_prompt: &CompatibilityPrompt<'_>) -> CompatibilityChoice {
    CompatibilityChoice::ContinueCodexhost
}

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
        package_full_name: String,
        app_user_model_id: String,
    },
    MacOsBundle {
        bundle_identifier: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopInstallation {
    pub identity: DesktopIdentity,
    pub version: String,
    pub build: String,
    pub asar_integrity: String,
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

#[cfg(target_os = "windows")]
pub fn configure_background_command(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
pub fn configure_background_command(_command: &mut std::process::Command) {}

pub fn atomic_replace_file(source: &Path, target: &Path) -> Result<(), PlatformError> {
    #[cfg(target_os = "windows")]
    {
        windows_process::atomic_replace_file(source, target)?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::fs::rename(source, target)?;
    }
    Ok(())
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

#[cfg(target_os = "windows")]
pub fn node_entrypoint_path(path: &Path) -> PathBuf {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    const SEPARATOR: u16 = b'\\' as u16;
    let value = path.as_os_str().encode_wide().collect::<Vec<_>>();
    let verbatim = [SEPARATOR, SEPARATOR, b'?' as u16, SEPARATOR];
    if !value.starts_with(&verbatim) {
        return path.to_path_buf();
    }
    let unc = [b'U' as u16, b'N' as u16, b'C' as u16, SEPARATOR];
    if value.get(4..8) == Some(unc.as_slice()) {
        let normalized = [SEPARATOR, SEPARATOR]
            .into_iter()
            .chain(value[8..].iter().copied())
            .collect::<Vec<_>>();
        return PathBuf::from(OsString::from_wide(&normalized));
    }
    if value.get(5) == Some(&(b':' as u16)) {
        return PathBuf::from(OsString::from_wide(&value[4..]));
    }
    path.to_path_buf()
}

#[cfg(not(target_os = "windows"))]
pub fn node_entrypoint_path(path: &Path) -> PathBuf {
    path.to_path_buf()
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

    #[cfg(target_os = "windows")]
    #[test]
    fn normalizes_verbatim_node_entrypoint_paths() {
        use std::path::Path;

        use super::node_entrypoint_path;

        assert_eq!(
            node_entrypoint_path(Path::new(r"\\?\D:\workspace\host-runtime.js")),
            Path::new(r"D:\workspace\host-runtime.js"),
        );
        assert_eq!(
            node_entrypoint_path(Path::new(r"\\?\UNC\server\share\host-runtime.js")),
            Path::new(r"\\server\share\host-runtime.js"),
        );
        assert_eq!(
            node_entrypoint_path(Path::new(r"D:\workspace\host-runtime.js")),
            Path::new(r"D:\workspace\host-runtime.js"),
        );
    }
}
