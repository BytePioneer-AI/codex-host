use std::env;
use std::error::Error;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process;
use std::thread;
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use codexhost_platform::terminate_process_by_id;
use codexhost_platform::{
    atomic_replace_file, parent_process_id, process_executable_path, process_exists,
};

const OWNER_DIRECTORY_NAME: &str = "local-host-runtime-owner-v1";
const OWNER_RECORD_NAME: &str = "owner";
const MAPPING_STORE_LOCK_PATH: [&str; 2] = ["mapping-store", "store.lock"];
const OWNER_READ_GRACE: Duration = Duration::from_millis(500);
const HANDOFF_GRACE: Duration = Duration::from_secs(4);
const FORCE_GRACE: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(20);

#[derive(Clone, Debug, PartialEq, Eq)]
struct OwnerRecord {
    process_id: u32,
    desktop_process_id: u32,
    child_process_id: Option<u32>,
}

impl OwnerRecord {
    fn encode(&self) -> String {
        format!(
            "version=1\nprocess_id={}\ndesktop_process_id={}\nchild_process_id={}\n",
            self.process_id,
            self.desktop_process_id,
            self.child_process_id
                .map_or_else(String::new, |value| value.to_string()),
        )
    }

    fn decode(value: &str) -> Option<Self> {
        let field = |name: &str| {
            value
                .lines()
                .find_map(|line| line.strip_prefix(&format!("{name}=")))
        };
        if field("version")? != "1" {
            return None;
        }
        Some(Self {
            process_id: field("process_id")?.parse().ok()?,
            desktop_process_id: field("desktop_process_id")?.parse().ok()?,
            child_process_id: field("child_process_id").and_then(|value| value.parse().ok()),
        })
    }
}

pub(crate) struct LocalRuntimeLease {
    directory: PathBuf,
    record: OwnerRecord,
}

impl LocalRuntimeLease {
    pub(crate) fn acquire(data_directory: &Path) -> Result<Self, Box<dyn Error>> {
        fs::create_dir_all(data_directory)?;
        let directory = data_directory.join(OWNER_DIRECTORY_NAME);
        let process_id = process::id();
        let desktop_process_id = parent_process_id(process_id)?.ok_or_else(|| {
            io::Error::other("codexhost Shim parent process identity is unavailable")
        })?;
        let record = OwnerRecord {
            process_id,
            desktop_process_id,
            child_process_id: None,
        };

        loop {
            match fs::create_dir(&directory) {
                Ok(()) => {
                    let lease = Self { directory, record };
                    if let Err(error) = lease.write_record() {
                        let _ = fs::remove_dir_all(&lease.directory);
                        return Err(error);
                    }
                    if let Err(error) = retire_legacy_mapping_store_owner(
                        data_directory,
                        lease.record.desktop_process_id,
                    ) {
                        drop(lease);
                        return Err(error);
                    }
                    return Ok(lease);
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }

            let Some(owner) = read_owner_with_grace(&directory)? else {
                fs::remove_dir_all(&directory)?;
                continue;
            };
            if owner.process_id == process_id {
                return Err("current codexhost Shim already owns the local Host Runtime".into());
            }
            if !owner_is_codexhost_shim(&owner)? {
                remove_owner_if_matches(&directory, &owner)?;
                continue;
            }

            if is_live_other_desktop(owner.desktop_process_id, desktop_process_id) {
                return Err(format!(
                    "another Codex Desktop process owns the local Host Runtime (Shim PID {}, Desktop PID {})",
                    owner.process_id, owner.desktop_process_id,
                )
                .into());
            }

            stop_owner(&owner)?;
            remove_owner_if_matches(&directory, &owner)?;
        }
    }

    pub(crate) fn set_child_process_id(
        &mut self,
        child_process_id: u32,
    ) -> Result<(), Box<dyn Error>> {
        if read_owner(&self.directory).as_ref() != Some(&self.record) {
            return Err("local Host Runtime ownership changed before child startup".into());
        }
        self.record.child_process_id = Some(child_process_id);
        self.write_record()
    }

    fn write_record(&self) -> Result<(), Box<dyn Error>> {
        let target = self.directory.join(OWNER_RECORD_NAME);
        let temporary = self.directory.join(format!(
            "{OWNER_RECORD_NAME}.tmp-{}",
            self.record.process_id
        ));
        fs::write(&temporary, self.record.encode())?;
        atomic_replace_file(&temporary, &target)?;
        Ok(())
    }
}

impl Drop for LocalRuntimeLease {
    fn drop(&mut self) {
        let _ = remove_owner_if_matches(&self.directory, &self.record);
    }
}

fn read_owner(directory: &Path) -> Option<OwnerRecord> {
    fs::read_to_string(directory.join(OWNER_RECORD_NAME))
        .ok()
        .and_then(|value| OwnerRecord::decode(&value))
}

fn read_owner_with_grace(directory: &Path) -> Result<Option<OwnerRecord>, Box<dyn Error>> {
    let deadline = Instant::now() + OWNER_READ_GRACE;
    loop {
        if let Some(owner) = read_owner(directory) {
            return Ok(Some(owner));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        thread::sleep(POLL_INTERVAL);
    }
}

fn remove_owner_if_matches(directory: &Path, expected: &OwnerRecord) -> io::Result<()> {
    if read_owner(directory).as_ref() == Some(expected) {
        fs::remove_dir_all(directory)?;
    }
    Ok(())
}

fn owner_is_codexhost_shim(owner: &OwnerRecord) -> Result<bool, Box<dyn Error>> {
    if !process_exists(owner.process_id) {
        return Ok(false);
    }
    let owner_executable = process_executable_path(owner.process_id)?;
    let current_executable = env::current_exe()?;
    // npm upgrades and candidate packages can move the same Shim to another absolute path.
    // The lease's PID and Desktop lineage are the trust boundary; the basename rejects PID reuse
    // by an unrelated executable without making in-place upgrades impossible.
    Ok(owner_executable.file_name() == current_executable.file_name())
}

fn retire_legacy_mapping_store_owner(
    data_directory: &Path,
    current_desktop_process_id: u32,
) -> Result<(), Box<dyn Error>> {
    let lock_path = MAPPING_STORE_LOCK_PATH
        .iter()
        .fold(data_directory.to_path_buf(), |path, segment| {
            path.join(segment)
        });
    let Some(runtime_process_id) = legacy_lock_process_id(&lock_path) else {
        return Ok(());
    };
    if !process_exists(runtime_process_id) {
        return Ok(());
    }
    let runtime_executable = match process_executable_path(runtime_process_id) {
        Ok(path) => path,
        Err(_) if !process_exists(runtime_process_id) => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if !runtime_executable
        .file_name()
        .is_some_and(|name| is_node_executable_name(&name.to_string_lossy()))
    {
        return Ok(());
    }

    let Some(shim_process_id) = parent_process_id(runtime_process_id)? else {
        return Ok(());
    };
    let shim_executable = match process_executable_path(shim_process_id) {
        Ok(path) => path,
        Err(_) if !process_exists(shim_process_id) => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let current_executable = env::current_exe()?;
    if shim_executable.file_name() != current_executable.file_name() {
        return Ok(());
    }
    let Some(legacy_desktop_process_id) = parent_process_id(shim_process_id)? else {
        return Ok(());
    };
    if is_live_other_desktop(legacy_desktop_process_id, current_desktop_process_id) {
        return Err(format!(
            "another Codex Desktop process owns the legacy local Host Runtime (Shim PID {shim_process_id}, Desktop PID {legacy_desktop_process_id})",
        )
        .into());
    }

    let legacy_owner = OwnerRecord {
        process_id: shim_process_id,
        desktop_process_id: legacy_desktop_process_id,
        child_process_id: Some(runtime_process_id),
    };
    eprintln!(
        "codexhost shim: retiring legacy local Host Runtime owned by Shim PID {shim_process_id}"
    );
    stop_owner(&legacy_owner)
}

fn is_live_other_desktop(process_id: u32, current_desktop_process_id: u32) -> bool {
    if process_id == current_desktop_process_id {
        return false;
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if process_id == 1 {
        // A surviving legacy Shim is reparented to launchd/systemd after its Desktop exits.
        // PID 1 is not another Codex Desktop.
        return false;
    }
    // Refuse takeover whenever the recorded/observed parent is still alive. Executable-name
    // matching is not sufficient: another Desktop channel or build may use a different basename.
    process_exists(process_id)
}

fn legacy_lock_process_id(path: &Path) -> Option<u32> {
    let contents = fs::read_to_string(path).ok()?;
    let after_key = contents.split_once("\"pid\"")?.1;
    let after_colon = after_key.split_once(':')?.1.trim_start();
    let digits = after_colon
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>();
    (!digits.is_empty()).then(|| digits.parse().ok()).flatten()
}

fn is_node_executable_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("node") || name.eq_ignore_ascii_case("node.exe")
}

fn stop_owner(owner: &OwnerRecord) -> Result<(), Box<dyn Error>> {
    terminate(owner.process_id, false)?;
    if wait_for_owner_exit(owner, HANDOFF_GRACE) {
        return Ok(());
    }
    terminate(owner.process_id, true)?;
    if let Some(child_process_id) = owner.child_process_id {
        terminate_child_group(child_process_id)?;
    }
    if wait_for_owner_exit(owner, FORCE_GRACE) {
        return Ok(());
    }
    Err(format!(
        "previous local Host Runtime did not exit (Shim PID {}, child PID {:?})",
        owner.process_id, owner.child_process_id,
    )
    .into())
}

fn wait_for_owner_exit(owner: &OwnerRecord, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        let owner_alive = process_exists(owner.process_id);
        let child_alive = owner.child_process_id.is_some_and(process_exists);
        if !owner_alive && !child_alive {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(POLL_INTERVAL);
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn terminate(process_id: u32, force: bool) -> Result<(), Box<dyn Error>> {
    use nix::errno::Errno;
    use nix::sys::signal::{Signal, kill};
    use nix::unistd::Pid;

    let process_id = i32::try_from(process_id)?;
    let signal = if force {
        Signal::SIGKILL
    } else {
        Signal::SIGTERM
    };
    match kill(Pid::from_raw(process_id), signal) {
        Ok(()) | Err(Errno::ESRCH) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(target_os = "windows")]
fn terminate(process_id: u32, _force: bool) -> Result<(), Box<dyn Error>> {
    if !process_exists(process_id) {
        return Ok(());
    }
    terminate_process_by_id(process_id)?;
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn terminate(_process_id: u32, _force: bool) -> Result<(), Box<dyn Error>> {
    Err("local Host Runtime ownership requires Windows, macOS, or Linux".into())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn terminate_child_group(process_id: u32) -> Result<(), Box<dyn Error>> {
    use nix::errno::Errno;
    use nix::sys::signal::{Signal, kill, killpg};
    use nix::unistd::Pid;

    let process_id = i32::try_from(process_id)?;
    let process_id = Pid::from_raw(process_id);
    match killpg(process_id, Signal::SIGKILL) {
        Ok(()) | Err(Errno::ESRCH) => {}
        Err(error) => return Err(error.into()),
    }
    match kill(process_id, Signal::SIGKILL) {
        Ok(()) | Err(Errno::ESRCH) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(target_os = "windows")]
fn terminate_child_group(process_id: u32) -> Result<(), Box<dyn Error>> {
    terminate(process_id, true)
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn terminate_child_group(_process_id: u32) -> Result<(), Box<dyn Error>> {
    Ok(())
}
