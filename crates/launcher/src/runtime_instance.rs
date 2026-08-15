#[cfg(not(target_os = "linux"))]
use std::env;
#[cfg(not(target_os = "linux"))]
use std::fs::OpenOptions;
use std::fs::{self, File};
#[cfg(target_os = "linux")]
use std::io::Read;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
use crate::secure_storage::{
    SecureFileOpen, open_secure_file, remove_secure_file, replace_secure_file, runtime_directory,
};

#[cfg(not(target_os = "linux"))]
use codexhost_platform::atomic_replace_file;
use fs2::FileExt;
use serde::{Deserialize, Serialize};

const RUNTIME_DESCRIPTOR_VERSION: u8 = 1;
const RUNTIME_DESCRIPTOR_FILE: &str = "desktop-runtime-v1.json";
const LAUNCHER_GUARD_FILE: &str = "launcher-v1.lock";
#[cfg(target_os = "linux")]
const MAX_RUNTIME_DESCRIPTOR_BYTES: usize = 4 * 1024;

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

#[cfg(target_os = "linux")]
pub fn default_descriptor_path() -> io::Result<PathBuf> {
    Ok(runtime_directory()?.join(RUNTIME_DESCRIPTOR_FILE))
}

#[cfg(target_os = "windows")]
pub fn default_descriptor_path() -> io::Result<PathBuf> {
    let root = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "LOCALAPPDATA is unavailable"))?;
    Ok(root.join("codexhost").join(RUNTIME_DESCRIPTOR_FILE))
}

#[cfg(target_os = "macos")]
pub fn default_descriptor_path() -> io::Result<PathBuf> {
    let root = env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join("Library").join("Application Support"))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is unavailable"))?;
    Ok(root.join("codexhost").join(RUNTIME_DESCRIPTOR_FILE))
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn default_descriptor_path() -> io::Result<PathBuf> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "runtime descriptor paths support Windows, macOS, and Linux only",
    ))
}

pub fn default_guard_path() -> io::Result<PathBuf> {
    default_descriptor_path().map(|path| path.with_file_name(LAUNCHER_GUARD_FILE))
}

pub struct LauncherGuard {
    _file: File,
}

pub fn try_acquire_launcher_guard(path: &Path) -> io::Result<Option<LauncherGuard>> {
    #[cfg(not(target_os = "linux"))]
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "guard path has no parent"))?;
    #[cfg(target_os = "linux")]
    path.parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "runtime path has no parent"))?;
    #[cfg(not(target_os = "linux"))]
    fs::create_dir_all(parent)?;
    #[cfg(target_os = "linux")]
    let file = open_secure_file(path, SecureFileOpen::ReadWriteCreate)?;
    #[cfg(not(target_os = "linux"))]
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

#[cfg(target_os = "linux")]
fn read_bounded_descriptor(file: &mut File) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    (&mut *file)
        .take((MAX_RUNTIME_DESCRIPTOR_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_RUNTIME_DESCRIPTOR_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "runtime descriptor exceeds 4 KiB",
        ));
    }
    Ok(bytes)
}

pub fn read_descriptor(path: &Path) -> io::Result<Option<RuntimeDescriptor>> {
    #[cfg(target_os = "linux")]
    let bytes = match open_secure_file(path, SecureFileOpen::ReadExisting) {
        Ok(mut file) => read_bounded_descriptor(&mut file)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    #[cfg(not(target_os = "linux"))]
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    RuntimeDescriptor::parse(&bytes)
        .map(Some)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

pub fn write_descriptor(path: &Path, descriptor: &RuntimeDescriptor) -> io::Result<()> {
    descriptor
        .validate()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    #[cfg(not(target_os = "linux"))]
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "descriptor has no parent"))?;
    #[cfg(target_os = "linux")]
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "runtime path has no parent"))?;
    #[cfg(not(target_os = "linux"))]
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".{RUNTIME_DESCRIPTOR_FILE}.{}.{}.tmp",
        std::process::id(),
        random_nonce()?
    ));
    let bytes = serde_json::to_vec(descriptor).map_err(io::Error::other)?;
    let result = (|| {
        #[cfg(target_os = "linux")]
        if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "runtime descriptor path is a symbolic link",
            ));
        }
        #[cfg(target_os = "linux")]
        let mut file = open_secure_file(&temporary, SecureFileOpen::WriteNew)?;
        #[cfg(not(target_os = "linux"))]
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        #[cfg(target_os = "linux")]
        replace_secure_file(&temporary, path)?;
        #[cfg(not(target_os = "linux"))]
        atomic_replace_file(&temporary, path).map_err(io::Error::other)?;
        Ok(())
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
    #[cfg(target_os = "linux")]
    {
        use crate::secure_storage::{SecureFileOpen, open_secure_file};

        // Keep the descriptor open through unlink. `remove_secure_file`
        // compares its inode to this exact verified object, so a concurrent
        // replacement cannot turn cleanup into deletion of another file.
        let mut file = open_secure_file(path, SecureFileOpen::ReadExisting)?;
        let bytes = read_bounded_descriptor(&mut file)?;
        if RuntimeDescriptor::parse(&bytes).ok().as_ref() != Some(expected) {
            return Ok(false);
        }
        match remove_secure_file(path, &file) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }
    #[cfg(not(target_os = "linux"))]
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
    use std::env;
    use std::fs;
    #[cfg(target_os = "linux")]
    use std::os::unix::fs::{PermissionsExt, symlink};
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

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_runtime_files_ignore_umask_and_stay_private() {
        let path = fixture_path("runtime-private");
        let parent = path.parent().expect("fixture parent");
        fs::create_dir_all(parent).expect("create fixture parent");
        fs::set_permissions(parent, fs::Permissions::from_mode(0o777))
            .expect("make fixture parent permissive");
        write_descriptor(&path, &descriptor(50)).expect("write private descriptor");
        let directory_mode = fs::metadata(parent)
            .expect("runtime directory metadata")
            .permissions()
            .mode()
            & 0o777;
        let file_mode = fs::metadata(&path)
            .expect("descriptor metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(directory_mode, 0o700);
        assert_eq!(file_mode, 0o600);
        fs::remove_dir_all(parent).expect("remove fixture");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_runtime_descriptor_and_guard_reject_symlinks() {
        let path = fixture_path("runtime-symlink");
        let parent = path.parent().expect("fixture parent");
        fs::create_dir_all(parent).expect("create fixture parent");
        let target = parent.join("target");
        fs::write(&target, b"target").expect("write symlink target");
        symlink(&target, &path).expect("create descriptor symlink");
        assert!(write_descriptor(&path, &descriptor(60)).is_err());
        assert!(read_descriptor(&path).is_err());
        let guard = parent.join("guard");
        symlink(&target, &guard).expect("create guard symlink");
        assert!(try_acquire_launcher_guard(&guard).is_err());
        fs::remove_dir_all(parent).expect("remove fixture");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_runtime_parent_symlink_is_rejected() {
        let path = fixture_path("runtime-parent-symlink");
        let parent = path.parent().expect("fixture parent");
        let target = parent.with_extension("target");
        fs::create_dir(&target).expect("create parent target");
        symlink(&target, parent).expect("create parent symlink");

        assert!(write_descriptor(&path, &descriptor(70)).is_err());
        assert!(try_acquire_launcher_guard(&path.with_file_name("guard")).is_err());

        fs::remove_file(parent).expect("remove parent symlink");
        fs::remove_dir(target).expect("remove parent target");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_runtime_descriptor_read_is_bounded() {
        let path = fixture_path("runtime-oversized");
        write_descriptor(&path, &descriptor(80)).expect("write private descriptor");
        fs::write(&path, vec![b'x'; MAX_RUNTIME_DESCRIPTOR_BYTES + 1])
            .expect("replace with oversized descriptor");

        let error = read_descriptor(&path).expect_err("reject oversized descriptor");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);

        fs::remove_dir_all(path.parent().expect("fixture parent")).expect("remove fixture");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn failed_descriptor_replacement_removes_its_temporary_file() {
        let path = fixture_path("runtime-failed-replacement");
        let parent = path.parent().expect("fixture parent");
        fs::create_dir_all(parent).expect("create fixture parent");
        fs::write(&path, b"unsafe target").expect("write unsafe target");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644))
            .expect("set unsafe target mode");

        assert!(write_descriptor(&path, &descriptor(90)).is_err());
        let entries = fs::read_dir(parent)
            .expect("read fixture parent")
            .map(|entry| entry.expect("read fixture entry").file_name())
            .collect::<Vec<_>>();
        assert_eq!(entries, vec![path.file_name().expect("target file name")]);

        fs::remove_dir_all(parent).expect("remove fixture");
    }
}
