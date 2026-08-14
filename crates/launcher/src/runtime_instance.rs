use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use codexhost_platform::atomic_replace_file;
use fs2::FileExt;
use serde::{Deserialize, Serialize};

const RUNTIME_DESCRIPTOR_VERSION: u8 = 1;
const RUNTIME_DESCRIPTOR_FILE: &str = "desktop-runtime-v1.json";
const LAUNCHER_GUARD_FILE: &str = "launcher-v1.lock";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartupState {
    RecoverStale,
    CleanLaunch,
    Attach,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StartupObservation {
    pub desktop_running: bool,
    pub descriptor_present: bool,
    pub control_endpoint_ready: bool,
}

pub fn classify_startup(observation: StartupObservation) -> StartupState {
    if observation.desktop_running {
        return StartupState::Attach;
    }
    if observation.descriptor_present && !observation.control_endpoint_ready {
        return StartupState::RecoverStale;
    }
    StartupState::CleanLaunch
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeDescriptor {
    pub schema_version: u8,
    pub launcher_pid: u32,
    pub control_port: u16,
    pub nonce: String,
}

impl RuntimeDescriptor {
    pub fn new(launcher_pid: u32, control_port: u16, nonce: String) -> Result<Self, String> {
        let descriptor = Self {
            schema_version: RUNTIME_DESCRIPTOR_VERSION,
            launcher_pid,
            control_port,
            nonce,
        };
        descriptor.validate()?;
        Ok(descriptor)
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        let descriptor = serde_json::from_slice::<Self>(bytes)
            .map_err(|error| format!("invalid runtime descriptor: {error}"))?;
        descriptor.validate()?;
        Ok(descriptor)
    }

    fn validate(&self) -> Result<(), String> {
        if self.schema_version != RUNTIME_DESCRIPTOR_VERSION {
            return Err(format!(
                "unsupported runtime descriptor version {}",
                self.schema_version
            ));
        }
        if self.launcher_pid == 0 {
            return Err("runtime descriptor Launcher PID must be non-zero".into());
        }
        if self.control_port == 0 {
            return Err("runtime descriptor Controller port must be non-zero".into());
        }
        if self.nonce.len() != 32
            || !self
                .nonce
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(
                "runtime descriptor nonce must be 32 lowercase hexadecimal characters".into(),
            );
        }
        Ok(())
    }
}

pub fn random_nonce() -> io::Result<String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|error| io::Error::other(format!("secure random source failed: {error}")))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn default_descriptor_path() -> io::Result<PathBuf> {
    #[cfg(target_os = "windows")]
    let root = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "LOCALAPPDATA is unavailable"))?;

    #[cfg(target_os = "macos")]
    let root = env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join("Library").join("Application Support"))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is unavailable"))?;

    #[cfg(target_os = "linux")]
    let root = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is unavailable"))?;

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let root = env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is unavailable"))?;

    Ok(root.join("codexhost").join(RUNTIME_DESCRIPTOR_FILE))
}

pub fn default_guard_path() -> io::Result<PathBuf> {
    default_descriptor_path().map(|path| path.with_file_name(LAUNCHER_GUARD_FILE))
}

pub struct LauncherGuard {
    _file: File,
}

pub fn try_acquire_launcher_guard(path: &Path) -> io::Result<Option<LauncherGuard>> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "guard path has no parent"))?;
    fs::create_dir_all(parent)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    match file.try_lock_exclusive() {
        Ok(()) => Ok(Some(LauncherGuard { _file: file })),
        Err(error)
            if error.kind() == io::ErrorKind::WouldBlock || error.raw_os_error() == Some(33) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

pub fn read_descriptor(path: &Path) -> io::Result<Option<RuntimeDescriptor>> {
    match fs::read(path) {
        Ok(bytes) => RuntimeDescriptor::parse(&bytes)
            .map(Some)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn write_descriptor(path: &Path, descriptor: &RuntimeDescriptor) -> io::Result<()> {
    descriptor
        .validate()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "descriptor has no parent"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".{RUNTIME_DESCRIPTOR_FILE}.{}.tmp",
        std::process::id()
    ));
    let bytes = serde_json::to_vec(descriptor).map_err(io::Error::other)?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
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

pub fn remove_matching_descriptor(path: &Path, expected: &RuntimeDescriptor) -> io::Result<bool> {
    let Some(current) = read_descriptor(path)? else {
        return Ok(false);
    };
    if current != *expected {
        return Ok(false);
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

pub struct RuntimeDescriptorGuard {
    path: PathBuf,
    descriptor: RuntimeDescriptor,
}

impl RuntimeDescriptorGuard {
    pub fn publish(path: PathBuf, descriptor: RuntimeDescriptor) -> io::Result<Self> {
        write_descriptor(&path, &descriptor)?;
        Ok(Self { path, descriptor })
    }
}

impl Drop for RuntimeDescriptorGuard {
    fn drop(&mut self) {
        let _ = remove_matching_descriptor(&self.path, &self.descriptor);
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn descriptor(control_port: u16) -> RuntimeDescriptor {
        RuntimeDescriptor::new(10, control_port, "0123456789abcdef0123456789abcdef".into())
            .expect("valid descriptor")
    }

    fn fixture_path(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        env::temp_dir().join(format!(
            "codexhost-{label}-{}-{unique}/runtime.json",
            std::process::id()
        ))
    }

    #[test]
    fn classifies_only_the_three_startup_states() {
        assert_eq!(
            classify_startup(StartupObservation {
                desktop_running: true,
                descriptor_present: false,
                control_endpoint_ready: false,
            }),
            StartupState::Attach
        );
        assert_eq!(
            classify_startup(StartupObservation {
                desktop_running: false,
                descriptor_present: true,
                control_endpoint_ready: false,
            }),
            StartupState::RecoverStale
        );
        assert_eq!(
            classify_startup(StartupObservation {
                desktop_running: false,
                descriptor_present: false,
                control_endpoint_ready: false,
            }),
            StartupState::CleanLaunch
        );
    }

    #[test]
    fn strict_descriptor_is_minimal_and_rejects_unknown_fields_and_bad_nonce() {
        let descriptor = descriptor(43124);
        let encoded = serde_json::to_value(&descriptor).expect("encode descriptor");
        assert_eq!(encoded.as_object().expect("descriptor object").len(), 4);
        assert!(encoded.get("desktop_pid").is_none());
        assert!(encoded.get("inspector_port").is_none());

        let unknown = br#"{"schema_version":1,"launcher_pid":1,"control_port":4,"nonce":"0123456789abcdef0123456789abcdef","extra":true}"#;
        assert!(RuntimeDescriptor::parse(unknown).is_err());
        assert!(RuntimeDescriptor::new(1, 4, "not-a-nonce".into()).is_err());
    }

    #[test]
    fn descriptor_replacement_and_matching_cleanup_preserve_newer_owner() {
        let path = fixture_path("runtime-state");
        let first = descriptor(20);
        let second = descriptor(30);
        write_descriptor(&path, &first).expect("write first descriptor");
        write_descriptor(&path, &second).expect("replace descriptor");
        assert_eq!(
            read_descriptor(&path).expect("read descriptor"),
            Some(second.clone())
        );
        assert!(!remove_matching_descriptor(&path, &first).expect("preserve newer descriptor"));
        assert!(path.exists());
        assert!(remove_matching_descriptor(&path, &second).expect("remove owner descriptor"));
        fs::remove_dir_all(path.parent().expect("fixture parent")).expect("remove fixture");
    }

    #[test]
    fn launcher_guard_allows_only_one_live_owner() {
        let path = fixture_path("launcher-guard");
        let first = try_acquire_launcher_guard(&path)
            .expect("acquire first guard")
            .expect("first guard owner");
        assert!(
            try_acquire_launcher_guard(&path)
                .expect("contended guard")
                .is_none()
        );
        drop(first);
        assert!(
            try_acquire_launcher_guard(&path)
                .expect("reacquire guard")
                .is_some()
        );
        fs::remove_dir_all(path.parent().expect("fixture parent")).expect("remove fixture");
    }

    #[test]
    fn descriptor_guard_removes_only_its_published_value() {
        let path = fixture_path("runtime-guard");
        let value = descriptor(40);
        {
            let _guard = RuntimeDescriptorGuard::publish(path.clone(), value)
                .expect("publish descriptor guard");
            assert!(path.exists());
        }
        assert!(!path.exists());
        fs::remove_dir_all(path.parent().expect("fixture parent")).expect("remove fixture");
    }
}
