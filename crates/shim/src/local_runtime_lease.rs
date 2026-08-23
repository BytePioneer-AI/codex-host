use std::env;
use std::error::Error;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::process;
use std::thread;
use std::time::{Duration, Instant};

use codexhost_platform::{
    PlatformError, ProcessSnapshot, atomic_replace_file, process_exists, process_snapshot,
    terminate_process_group_instance, terminate_process_instance,
};
use fs2::FileExt;

const OWNER_DIRECTORY_NAME: &str = "local-host-runtime-owner-v1";
const OWNER_LOCK_NAME: &str = "local-host-runtime-owner.lock";
const OWNER_RECORD_NAME: &str = "owner";
const MAPPING_STORE_LOCK_PATH: [&str; 2] = ["mapping-store", "store.lock"];
const OWNER_READ_GRACE: Duration = Duration::from_millis(500);
const VERSION_ONE_STARTUP_GRACE: Duration = Duration::from_secs(4);
const HANDOFF_GRACE: Duration = Duration::from_secs(4);
const FORCE_GRACE: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(20);

#[derive(Clone, Debug, PartialEq, Eq)]
struct OwnerRecord {
    process_id: u32,
    process_started_at_micros: u64,
    desktop_process_id: u32,
    child_process_id: Option<u32>,
    child_process_started_at_micros: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct VersionOneOwnerRecord {
    process_id: u32,
    desktop_process_id: u32,
    child_process_id: Option<u32>,
}

struct VersionOneMigrationCandidate {
    record: VersionOneOwnerRecord,
    shim_snapshot: ProcessSnapshot,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum StoredOwnerRecord {
    Exact(OwnerRecord),
    VersionOne(VersionOneOwnerRecord),
}

impl OwnerRecord {
    fn encode(&self) -> String {
        format!(
            "version=1\nprocess_id={}\nprocess_started_at_micros={}\ndesktop_process_id={}\nchild_process_id={}\nchild_process_started_at_micros={}\n",
            self.process_id,
            self.process_started_at_micros,
            self.desktop_process_id,
            self.child_process_id
                .map_or_else(String::new, |value| value.to_string()),
            self.child_process_started_at_micros
                .map_or_else(String::new, |value| value.to_string()),
        )
    }

    fn decode(value: &str) -> Option<StoredOwnerRecord> {
        let field = |name: &str| {
            value
                .lines()
                .find_map(|line| line.strip_prefix(&format!("{name}=")))
        };
        let version = field("version")?;
        let process_id = field("process_id")?.parse().ok()?;
        let desktop_process_id = field("desktop_process_id")?.parse().ok()?;
        let child_process_id = field("child_process_id").and_then(|value| value.parse().ok());
        // The released v1 shape has no start identities. Development builds of this follow-up
        // briefly emitted start identities under v1, so accept those as exact records too.
        if version == "1" && field("process_started_at_micros").is_none() {
            return Some(StoredOwnerRecord::VersionOne(VersionOneOwnerRecord {
                process_id,
                desktop_process_id,
                child_process_id,
            }));
        }
        if version != "2" && version != "1" {
            return None;
        }
        let child_process_started_at_micros =
            field("child_process_started_at_micros").and_then(|value| value.parse().ok());
        if child_process_id.is_some() != child_process_started_at_micros.is_some() {
            return None;
        }
        Some(StoredOwnerRecord::Exact(Self {
            process_id,
            process_started_at_micros: field("process_started_at_micros")?.parse().ok()?,
            desktop_process_id,
            child_process_id,
            child_process_started_at_micros,
        }))
    }
}

pub(crate) struct LocalRuntimeLease {
    data_directory: PathBuf,
    directory: PathBuf,
    record: OwnerRecord,
    mutation_lock: Option<OwnerMutationLock>,
    active: bool,
}

struct OwnerMutationLock {
    _file: File,
}

impl OwnerMutationLock {
    fn open(data_directory: &Path) -> io::Result<File> {
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(data_directory.join(OWNER_LOCK_NAME))
    }

    fn acquire(data_directory: &Path) -> io::Result<Self> {
        let file = Self::open(data_directory)?;
        file.lock_exclusive()?;
        Ok(Self { _file: file })
    }

    fn try_acquire(data_directory: &Path) -> io::Result<Option<Self>> {
        let file = Self::open(data_directory)?;
        match file.try_lock_exclusive() {
            Ok(()) => Ok(Some(Self { _file: file })),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(None),
            Err(error) => Err(error),
        }
    }
}

impl Drop for OwnerMutationLock {
    fn drop(&mut self) {
        // Child publication is the ownership handoff boundary. Release it explicitly instead of
        // relying on platform-specific file-close timing before a contender observes that boundary.
        let _ = FileExt::unlock(&self._file);
    }
}

impl LocalRuntimeLease {
    pub(crate) fn acquire(data_directory: &Path) -> Result<Self, Box<dyn Error>> {
        fs::create_dir_all(data_directory)?;
        // Serialize observation, retirement, removal, and publication as one cross-process
        // mutation. Without this lock, a delayed contender can delete a newer contender's lease.
        let mutation_lock = OwnerMutationLock::acquire(data_directory)?;
        let directory = data_directory.join(OWNER_DIRECTORY_NAME);
        let process_id = process::id();
        let process_snapshot = process_snapshot(process_id)?;
        let desktop_process_id = process_snapshot.parent_id;
        if desktop_process_id == 0 {
            return Err(
                io::Error::other("codexhost Shim parent process identity is unavailable").into(),
            );
        }
        let record = OwnerRecord {
            process_id,
            process_started_at_micros: process_snapshot.started_at_micros,
            desktop_process_id,
            child_process_id: None,
            child_process_started_at_micros: None,
        };

        loop {
            match fs::create_dir(&directory) {
                Ok(()) => {
                    let mut lease = Self {
                        data_directory: data_directory.to_path_buf(),
                        directory,
                        record,
                        // Keep the transaction closed to contenders until the caller has spawned
                        // the Host Runtime and atomically published that exact child instance.
                        mutation_lock: Some(mutation_lock),
                        active: true,
                    };
                    let lease_lock = lease
                        .mutation_lock
                        .as_ref()
                        .expect("new local Host Runtime lease owns the mutation lock");
                    if let Err(error) = lease.write_record(lease_lock) {
                        lease.active = false;
                        let _ = fs::remove_dir_all(&lease.directory);
                        return Err(error);
                    }
                    if let Err(error) = retire_legacy_mapping_store_owner(
                        data_directory,
                        lease.record.desktop_process_id,
                    ) {
                        let _ =
                            remove_owner_if_matches(lease_lock, &lease.directory, &lease.record);
                        lease.active = false;
                        return Err(error);
                    }
                    return Ok(lease);
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }

            let Some(stored_owner) = read_stored_owner_with_grace(&directory)? else {
                fs::remove_dir_all(&directory)?;
                continue;
            };
            let owner = match &stored_owner {
                StoredOwnerRecord::Exact(owner) => owner.clone(),
                StoredOwnerRecord::VersionOne(owner) => {
                    let Some(owner) = migrate_version_one_owner(&mutation_lock, &directory, owner)?
                    else {
                        remove_stored_owner_if_matches(&mutation_lock, &directory, &stored_owner)?;
                        continue;
                    };
                    owner
                }
            };
            if owner.process_id == process_id {
                return Err("current codexhost Shim already owns the local Host Runtime".into());
            }
            if !owner_is_codexhost_shim(&owner)? {
                remove_owner_if_matches(&mutation_lock, &directory, &owner)?;
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
            remove_owner_if_matches(&mutation_lock, &directory, &owner)?;
        }
    }

    pub(crate) fn set_child_process_id(
        &mut self,
        child_process_id: u32,
    ) -> Result<(), Box<dyn Error>> {
        let mutation_lock = self
            .mutation_lock
            .as_ref()
            .ok_or("local Host Runtime child identity was already published")?;
        if read_owner(&self.directory).as_ref() != Some(&self.record) {
            return Err("local Host Runtime ownership changed before child startup".into());
        }
        let child_snapshot = process_snapshot(child_process_id)?;
        self.record.child_process_id = Some(child_process_id);
        self.record.child_process_started_at_micros = Some(child_snapshot.started_at_micros);
        self.write_record(mutation_lock)?;
        self.mutation_lock.take();
        Ok(())
    }

    fn write_record(&self, mutation_lock: &OwnerMutationLock) -> Result<(), Box<dyn Error>> {
        write_owner_record(mutation_lock, &self.directory, &self.record)?;
        Ok(())
    }
}

impl Drop for LocalRuntimeLease {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        if let Some(mutation_lock) = self.mutation_lock.take() {
            let _ = remove_owner_if_matches(&mutation_lock, &self.directory, &self.record);
            return;
        }
        // A replacement owns this lock while it waits for us to exit. Blocking here would make
        // its graceful handoff wait on our Drop while our Drop waits on the replacement.
        let Ok(Some(mutation_lock)) = OwnerMutationLock::try_acquire(&self.data_directory) else {
            return;
        };
        let _ = remove_owner_if_matches(&mutation_lock, &self.directory, &self.record);
    }
}

fn read_owner(directory: &Path) -> Option<OwnerRecord> {
    match read_stored_owner(directory)? {
        StoredOwnerRecord::Exact(owner) => Some(owner),
        StoredOwnerRecord::VersionOne(_) => None,
    }
}

fn read_stored_owner(directory: &Path) -> Option<StoredOwnerRecord> {
    fs::read_to_string(directory.join(OWNER_RECORD_NAME))
        .ok()
        .and_then(|value| OwnerRecord::decode(&value))
}

fn read_stored_owner_with_grace(
    directory: &Path,
) -> Result<Option<StoredOwnerRecord>, Box<dyn Error>> {
    let deadline = Instant::now() + OWNER_READ_GRACE;
    loop {
        if let Some(owner) = read_stored_owner(directory) {
            return Ok(Some(owner));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        thread::sleep(POLL_INTERVAL);
    }
}

fn remove_owner_if_matches(
    _mutation_lock: &OwnerMutationLock,
    directory: &Path,
    expected: &OwnerRecord,
) -> io::Result<()> {
    if read_stored_owner(directory).as_ref() == Some(&StoredOwnerRecord::Exact(expected.clone())) {
        fs::remove_dir_all(directory)?;
    }
    Ok(())
}

fn remove_stored_owner_if_matches(
    _mutation_lock: &OwnerMutationLock,
    directory: &Path,
    expected: &StoredOwnerRecord,
) -> io::Result<()> {
    if read_stored_owner(directory).as_ref() == Some(expected) {
        fs::remove_dir_all(directory)?;
    }
    Ok(())
}

fn write_owner_record(
    _mutation_lock: &OwnerMutationLock,
    directory: &Path,
    record: &OwnerRecord,
) -> io::Result<()> {
    let target = directory.join(OWNER_RECORD_NAME);
    let temporary = directory.join(format!("{OWNER_RECORD_NAME}.tmp-{}", record.process_id));
    fs::write(&temporary, record.encode())?;
    atomic_replace_file(&temporary, &target).map_err(|error| match error {
        PlatformError::Io(error) => error,
        PlatformError::NotFound(message) => io::Error::new(io::ErrorKind::NotFound, message),
        error => io::Error::other(error),
    })?;
    Ok(())
}

fn write_migrated_owner_record(
    mutation_lock: &OwnerMutationLock,
    directory: &Path,
    record: &OwnerRecord,
) -> Result<bool, Box<dyn Error>> {
    match write_owner_record(mutation_lock, directory, record) {
        Ok(()) => Ok(true),
        // A released v1 Shim does not use the mutation lock. Its Drop may remove the verified
        // directory between the equality check and publication; let acquisition observe again.
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn executable_file_name_matches(observed: &Path, expected: &Path) -> bool {
    let (Some(observed), Some(expected)) = (observed.file_name(), expected.file_name()) else {
        return false;
    };
    if observed == expected {
        return true;
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::ffi::OsStrExt;

        observed.as_bytes().strip_suffix(b" (deleted)") == Some(expected.as_bytes())
    }
    #[cfg(not(target_os = "linux"))]
    false
}

fn ensure_no_live_version_one_child(owner: &VersionOneOwnerRecord) -> Result<(), Box<dyn Error>> {
    let Some(child_process_id) = owner.child_process_id else {
        return Ok(());
    };
    if current_process_snapshot(child_process_id)?.is_some() {
        return Err(format!(
            "version-one local Host Runtime child PID {child_process_id} remains live without a verified Shim process instance; refusing unsafe takeover",
        )
        .into());
    }
    Ok(())
}

fn validate_version_one_shim_snapshot(
    owner: &VersionOneOwnerRecord,
    snapshot: &ProcessSnapshot,
    current_executable: &Path,
) -> Result<bool, Box<dyn Error>> {
    if !executable_file_name_matches(&snapshot.executable, current_executable) {
        return Ok(false);
    }
    if snapshot.parent_id != owner.desktop_process_id && snapshot.parent_id != 1 {
        return Err(format!(
            "live version-one local Host Runtime owner PID {} no longer belongs to its recorded Desktop PID {}; refusing unsafe takeover",
            owner.process_id, owner.desktop_process_id,
        )
        .into());
    }
    Ok(true)
}

fn stabilize_version_one_owner(
    directory: &Path,
    initial: &VersionOneOwnerRecord,
) -> Result<Option<VersionOneMigrationCandidate>, Box<dyn Error>> {
    let current_executable = env::current_exe()?;
    let Some(initial_snapshot) = current_process_snapshot(initial.process_id)? else {
        ensure_no_live_version_one_child(initial)?;
        return Ok(None);
    };
    if !validate_version_one_shim_snapshot(initial, &initial_snapshot, &current_executable)? {
        ensure_no_live_version_one_child(initial)?;
        return Ok(None);
    }
    if initial.child_process_id.is_some() {
        return Ok(Some(VersionOneMigrationCandidate {
            record: initial.clone(),
            shim_snapshot: initial_snapshot,
        }));
    }

    // Released Shims publish an empty owner record, spawn the child, and then replace the record
    // without taking OWNER_LOCK_NAME. Do not overwrite that startup write with a child-less exact
    // record. Pin the live Shim instance before waiting and keep validating that exact PID/start
    // identity until its final publication, or fail closed while the released owner remains live.
    let deadline = Instant::now() + VERSION_ONE_STARTUP_GRACE;
    loop {
        let Some(StoredOwnerRecord::VersionOne(current)) = read_stored_owner(directory) else {
            return Ok(None);
        };
        if current.process_id != initial.process_id
            || current.desktop_process_id != initial.desktop_process_id
        {
            return Ok(None);
        }
        let Some(shim_snapshot) =
            recorded_process_snapshot(initial_snapshot.id, initial_snapshot.started_at_micros)?
        else {
            ensure_no_live_version_one_child(&current)?;
            return Ok(None);
        };
        if !validate_version_one_shim_snapshot(&current, &shim_snapshot, &current_executable)? {
            ensure_no_live_version_one_child(&current)?;
            return Ok(None);
        }
        if current.child_process_id.is_some() {
            return Ok(Some(VersionOneMigrationCandidate {
                record: current,
                shim_snapshot,
            }));
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "live version-one local Host Runtime owner PID {} did not publish its child process identity; refusing unsafe takeover",
                initial.process_id,
            )
            .into());
        }
        thread::sleep(POLL_INTERVAL);
    }
}

fn migrate_version_one_owner(
    mutation_lock: &OwnerMutationLock,
    directory: &Path,
    legacy: &VersionOneOwnerRecord,
) -> Result<Option<OwnerRecord>, Box<dyn Error>> {
    let Some(candidate) = stabilize_version_one_owner(directory, legacy)? else {
        return Ok(None);
    };
    let legacy = candidate.record;
    // v1 cannot itself distinguish PID reuse. While the mutation is serialized, validate the
    // live Shim and its lineage before waiting, snapshot the recorded child while its lineage is
    // still provable, and publish both exact instances before sending any signal. Once captured,
    // the child snapshot remains authoritative if the Shim exits and the child is reparented.
    let child_snapshot = match legacy.child_process_id {
        Some(child_process_id) => match current_process_snapshot(child_process_id)? {
            Some(snapshot) if snapshot.parent_id == legacy.process_id => Some(snapshot),
            Some(_) => {
                return Err(format!(
                    "live version-one local Host Runtime child PID {child_process_id} no longer belongs to Shim PID {}; refusing unsafe takeover",
                    legacy.process_id,
                )
                .into());
            }
            None => None,
        },
        None => None,
    };
    let migrated =
        migrated_owner_record(&legacy, &candidate.shim_snapshot, child_snapshot.as_ref());

    let expected = StoredOwnerRecord::VersionOne(legacy.clone());
    if read_stored_owner(directory).as_ref() != Some(&expected) {
        return Ok(None);
    }
    if !write_migrated_owner_record(mutation_lock, directory, &migrated)? {
        return Ok(None);
    }
    Ok(Some(migrated))
}

fn migrated_owner_record(
    legacy: &VersionOneOwnerRecord,
    shim_snapshot: &ProcessSnapshot,
    child_snapshot: Option<&ProcessSnapshot>,
) -> OwnerRecord {
    OwnerRecord {
        process_id: legacy.process_id,
        process_started_at_micros: shim_snapshot.started_at_micros,
        desktop_process_id: shim_snapshot.parent_id,
        child_process_id: child_snapshot.as_ref().map(|snapshot| snapshot.id),
        child_process_started_at_micros: child_snapshot
            .as_ref()
            .map(|snapshot| snapshot.started_at_micros),
    }
}

fn owner_is_codexhost_shim(owner: &OwnerRecord) -> Result<bool, Box<dyn Error>> {
    let Some(owner_snapshot) =
        recorded_process_snapshot(owner.process_id, owner.process_started_at_micros)?
    else {
        return Ok(false);
    };
    let current_executable = env::current_exe()?;
    // npm upgrades and candidate packages can move the same Shim to another absolute path.
    // PID plus start time is the process-instance identity. The basename additionally rejects a
    // corrupt lease without making an in-place npm upgrade impossible.
    Ok(executable_file_name_matches(
        &owner_snapshot.executable,
        &current_executable,
    ))
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
    let runtime_snapshot = match process_snapshot(runtime_process_id) {
        Ok(snapshot) => snapshot,
        Err(_) if !process_exists(runtime_process_id) => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if !runtime_snapshot
        .executable
        .file_name()
        .is_some_and(|name| is_node_executable_name(&name.to_string_lossy()))
    {
        return Ok(());
    }

    let shim_process_id = runtime_snapshot.parent_id;
    let shim_snapshot = match process_snapshot(shim_process_id) {
        Ok(snapshot) => snapshot,
        Err(_) if !process_exists(shim_process_id) => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let current_executable = env::current_exe()?;
    if !executable_file_name_matches(&shim_snapshot.executable, &current_executable) {
        return Ok(());
    }
    let legacy_desktop_process_id = shim_snapshot.parent_id;
    if is_live_other_desktop(legacy_desktop_process_id, current_desktop_process_id) {
        return Err(format!(
            "another Codex Desktop process owns the legacy local Host Runtime (Shim PID {shim_process_id}, Desktop PID {legacy_desktop_process_id})",
        )
        .into());
    }

    let legacy_owner = OwnerRecord {
        process_id: shim_process_id,
        process_started_at_micros: shim_snapshot.started_at_micros,
        desktop_process_id: legacy_desktop_process_id,
        child_process_id: Some(runtime_process_id),
        child_process_started_at_micros: Some(runtime_snapshot.started_at_micros),
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
    terminate_recorded_process(owner.process_id, owner.process_started_at_micros, false)?;
    if wait_for_owner_exit(owner, HANDOFF_GRACE)? {
        return Ok(());
    }
    if let (Some(child_process_id), Some(child_process_started_at_micros)) = (
        owner.child_process_id,
        owner.child_process_started_at_micros,
    ) && let Some(child_snapshot) =
        recorded_process_snapshot(child_process_id, child_process_started_at_micros)?
    {
        terminate_process_group_instance(&child_snapshot, true)?;
    }
    terminate_recorded_process(owner.process_id, owner.process_started_at_micros, true)?;
    if wait_for_owner_exit(owner, FORCE_GRACE)? {
        return Ok(());
    }
    Err(format!(
        "previous local Host Runtime did not exit (Shim PID {}, child PID {:?})",
        owner.process_id, owner.child_process_id,
    )
    .into())
}

fn wait_for_owner_exit(owner: &OwnerRecord, timeout: Duration) -> Result<bool, Box<dyn Error>> {
    let deadline = Instant::now() + timeout;
    loop {
        let owner_alive =
            recorded_process_snapshot(owner.process_id, owner.process_started_at_micros)?.is_some();
        let child_alive = match (
            owner.child_process_id,
            owner.child_process_started_at_micros,
        ) {
            (Some(process_id), Some(started_at_micros)) => {
                recorded_process_snapshot(process_id, started_at_micros)?.is_some()
            }
            _ => false,
        };
        if !owner_alive && !child_alive {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        thread::sleep(POLL_INTERVAL);
    }
}

fn current_process_snapshot(process_id: u32) -> Result<Option<ProcessSnapshot>, Box<dyn Error>> {
    match process_snapshot(process_id) {
        Ok(snapshot) => Ok(Some(snapshot)),
        Err(PlatformError::NotFound(_)) => Ok(None),
        Err(_) if !process_exists(process_id) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn recorded_process_snapshot(
    process_id: u32,
    started_at_micros: u64,
) -> Result<Option<ProcessSnapshot>, Box<dyn Error>> {
    match process_snapshot(process_id) {
        Ok(snapshot) if snapshot.started_at_micros == started_at_micros => Ok(Some(snapshot)),
        Ok(_) | Err(PlatformError::NotFound(_)) => Ok(None),
        Err(_) if !process_exists(process_id) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn terminate_recorded_process(
    process_id: u32,
    started_at_micros: u64,
    force: bool,
) -> Result<(), Box<dyn Error>> {
    if let Some(snapshot) = recorded_process_snapshot(process_id, started_at_micros)? {
        terminate_process_instance(&snapshot, force)?;
    }
    Ok(())
}

// Separate Windows handles and Linux open file descriptions contend even within one process, so
// this focused unit test covers both platforms. Each boundary observation uses a freshly opened
// contender, matching separate replacement processes and avoiding reuse of a failed flock attempt.
// macOS treats these flock acquisitions as process-scoped;
// `replacement_waits_for_the_local_runtime_owner_mutation_lock` provides the cross-process
// integration coverage there.
#[cfg(test)]
mod tests {
    use super::*;

    fn decode_released_version_one_owner(value: &str) -> Option<VersionOneOwnerRecord> {
        let field = |name: &str| {
            value
                .lines()
                .find_map(|line| line.strip_prefix(&format!("{name}=")))
        };
        if field("version")? != "1" {
            return None;
        }
        Some(VersionOneOwnerRecord {
            process_id: field("process_id")?.parse().ok()?,
            desktop_process_id: field("desktop_process_id")?.parse().ok()?,
            child_process_id: field("child_process_id").and_then(|value| value.parse().ok()),
        })
    }

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    fn contender_can_acquire(data_directory: &Path) -> bool {
        let contender = OwnerMutationLock::open(data_directory).expect("open contender owner lock");
        let acquired = contender.try_lock_exclusive().is_ok();
        if acquired {
            FileExt::unlock(&contender).expect("release contender owner lock");
        }
        acquired
    }

    fn temporary_data_directory() -> PathBuf {
        static NEXT_DIRECTORY: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let sequence = NEXT_DIRECTORY.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        env::temp_dir().join(format!(
            "codexhost-local-runtime-lease-{}-{sequence}",
            process::id()
        ))
    }

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    #[test]
    fn holds_the_mutation_lock_until_child_identity_is_published() {
        let data_directory = temporary_data_directory();
        let mut lease = LocalRuntimeLease::acquire(&data_directory).expect("acquire owner lease");
        let contender_acquired_before_publish = contender_can_acquire(&data_directory);

        lease
            .set_child_process_id(process::id())
            .expect("publish child identity");
        let contender_acquired_after_publish = contender_can_acquire(&data_directory);

        drop(lease);
        fs::remove_dir_all(&data_directory).expect("remove owner lease fixture");

        assert!(
            !contender_acquired_before_publish,
            "a contender acquired ownership before the child identity was published"
        );
        assert!(
            contender_acquired_after_publish,
            "ownership mutation lock remained held after child identity publication"
        );
    }

    #[test]
    fn exact_owner_records_remain_readable_by_released_version_one_shims() {
        let record = OwnerRecord {
            process_id: 101,
            process_started_at_micros: 202,
            desktop_process_id: 303,
            child_process_id: Some(404),
            child_process_started_at_micros: Some(505),
        };

        let decoded = decode_released_version_one_owner(&record.encode())
            .expect("released v1 Shim should accept an exact owner record");

        assert_eq!(
            decoded,
            VersionOneOwnerRecord {
                process_id: record.process_id,
                desktop_process_id: record.desktop_process_id,
                child_process_id: record.child_process_id,
            }
        );
    }

    #[test]
    fn migrated_owner_records_preserve_observed_reparenting() {
        let legacy = VersionOneOwnerRecord {
            process_id: 101,
            desktop_process_id: 303,
            child_process_id: None,
        };
        let shim_snapshot = ProcessSnapshot {
            id: legacy.process_id,
            parent_id: 1,
            process_group_id: legacy.process_id,
            executable: PathBuf::from("codexhost-shim"),
            started_at_micros: 202,
        };

        let migrated = migrated_owner_record(&legacy, &shim_snapshot, None);

        assert_eq!(migrated.desktop_process_id, 1);
    }

    #[test]
    fn a_missing_owner_directory_retries_version_one_migration() {
        let data_directory = temporary_data_directory();
        fs::create_dir(&data_directory).expect("create owner lock fixture");
        let mutation_lock =
            OwnerMutationLock::acquire(&data_directory).expect("acquire owner mutation lock");
        let missing_owner_directory = data_directory.join(OWNER_DIRECTORY_NAME);
        let migrated = OwnerRecord {
            process_id: 101,
            process_started_at_micros: 202,
            desktop_process_id: 303,
            child_process_id: Some(404),
            child_process_started_at_micros: Some(505),
        };

        let result =
            write_migrated_owner_record(&mutation_lock, &missing_owner_directory, &migrated);

        drop(mutation_lock);
        fs::remove_dir_all(&data_directory).expect("remove owner lock fixture");
        assert!(!result.expect("missing owner directory should request another acquisition pass"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn matches_an_unlinked_linux_shim_executable() {
        assert!(executable_file_name_matches(
            Path::new("/tmp/codexhost-shim (deleted)"),
            Path::new("/opt/codexhost-shim"),
        ));
        assert!(!executable_file_name_matches(
            Path::new("/tmp/not-codexhost-shim (deleted)"),
            Path::new("/opt/codexhost-shim"),
        ));
    }
}
