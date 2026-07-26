#![forbid(unsafe_code)]

#[cfg(feature = "gate-tools")]
mod capture;

#[cfg(feature = "gate-tools")]
pub use capture::ProbeCapture;

#[cfg(feature = "gate-tools")]
pub const PROBE_OUTPUT_ENV: &str = "CODEXHOST_PROBE_OUTPUT";
#[cfg(feature = "gate-tools")]
pub const DESKTOP_VERSION_ENV: &str = "CODEXHOST_DESKTOP_VERSION";
#[cfg(feature = "gate-tools")]
pub const INSTALL_ROOT_ENV: &str = "CODEXHOST_INSTALL_ROOT";
#[cfg(feature = "gate-tools")]
pub const LAUNCH_MODE_ENV: &str = "CODEXHOST_LAUNCH_MODE";
