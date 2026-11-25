use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use codexhost_platform::{process_instance, process_snapshot};
use serde::{Deserialize, Serialize};

const LOCK_FILE: &str = "desktop-shell-instance.lock";
const RECORD_FILE: &str = "desktop-shell-instance.json";
const MAX_RECORD_BYTES: u64 = 16 * 1024;
const MAX_REQUEST_BYTES: u64 = 4 * 1024;
const IO_TIMEOUT: Duration = Duration::from_millis(500);
const READ_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Activation {
    Onboarding,
    Show,
}

#[derive(Debug, Serialize, Deserialize)]
struct InstanceRecord {
    pid: u32,
    started_at_micros: u64,
    port: u16,
    nonce: String,
}

impl InstanceRecord {
    fn has_valid_identity(&self) -> bool {
        self.pid != 0
            && self.started_at_micros != 0
            && self.port != 0
            && self.nonce.len() == 64
            && self.nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct ActivationRequest {
    nonce: String,
    action: Activation,
}

#[derive(Clone, Copy)]
struct ProcessOwner {
    pid: u32,
    started_at_micros: u64,
}

#[derive(Clone, Copy)]
struct RetryPolicy {
    timeout: Duration,
    interval: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(3),
            interval: Duration::from_millis(25),
        }
    }
}

pub(crate) enum Claim {
    Primary {
        instance: PrimaryInstance,
        activations: Receiver<Activation>,
    },
    Forwarded,
}

pub(crate) struct PrimaryInstance {
    _lock: File,
    record_path: PathBuf,
    owner: ProcessOwner,
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    server: Mutex<Option<JoinHandle<()>>>,
}

impl PrimaryInstance {
    #[cfg(test)]
    fn address(&self) -> SocketAddr {
        self.address
    }

    pub(crate) fn shutdown(&self) {
        let server = self
            .server
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        let Some(server) = server else {
            return;
        };
        self.stop.store(true, Ordering::Release);
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_millis(100));
        let _ = server.join();
        remove_record_if_owned(&self.record_path, self.owner);
    }
}

impl Drop for PrimaryInstance {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub(crate) fn claim(
    data_dir: &Path,
    activation: Activation,
) -> Result<Claim, Box<dyn std::error::Error>> {
    claim_with(data_dir, activation, RetryPolicy::default(), || {}).map_err(|error| error.into())
}

fn claim_with(
    data_dir: &Path,
    activation: Activation,
    retry: RetryPolicy,
    mut on_wait: impl FnMut(),
) -> Result<Claim, String> {
    let data_dir = normalize_data_dir(data_dir)?;
    let lock_path = data_dir.join(LOCK_FILE);
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|error| format!("Cannot open {}: {error}", lock_path.display()))?;
    claim_with_lock(data_dir, lock, activation, retry, &mut on_wait)
}

fn claim_with_lock(
    data_dir: PathBuf,
    lock: File,
    activation: Activation,
    retry: RetryPolicy,
    on_wait: &mut impl FnMut(),
) -> Result<Claim, String> {
    let deadline = Instant::now()
        .checked_add(retry.timeout)
        .ok_or("Desktop shell retry deadline overflowed")?;
    loop {
        if try_lock(&lock)? {
            let (instance, activations) = start_primary(data_dir, lock)?;
            return Ok(Claim::Primary {
                instance,
                activations,
            });
        }

        let last_problem = match read_live_record(&data_dir) {
            RecordState::Live(record) => match activate(&record, activation) {
                Ok(()) => return Ok(Claim::Forwarded),
                Err(error) => Some(error),
            },
            RecordState::Missing => None,
            RecordState::Invalid(error) | RecordState::Stopped(error) => Some(error),
        };

        let now = Instant::now();
        if now >= deadline {
            let detail = last_problem
                .map(|error| format!(" Last error: {error}"))
                .unwrap_or_default();
            return Err(format!(
                "Another CodexHost window is starting for this data directory but did not become ready.{detail}"
            ));
        }
        on_wait();
        thread::sleep(retry.interval.min(deadline - now));
    }
}

fn normalize_data_dir(data_dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(data_dir).map_err(|error| {
        format!(
            "Cannot create CodexHost data directory {}: {error}",
            data_dir.display()
        )
    })?;
    data_dir.canonicalize().map_err(|error| {
        format!(
            "Cannot normalize CodexHost data directory {}: {error}",
            data_dir.display()
        )
    })
}

fn try_lock(lock: &File) -> Result<bool, String> {
    match lock.try_lock() {
        Ok(()) => Ok(true),
        Err(TryLockError::WouldBlock) => Ok(false),
        Err(TryLockError::Error(error)) => {
            Err(format!("Cannot lock the desktop shell instance: {error}"))
        }
    }
}

fn start_primary(
    data_dir: PathBuf,
    lock: File,
) -> Result<(PrimaryInstance, Receiver<Activation>), String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("Cannot start the desktop shell activation listener: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("Cannot read the desktop shell activation address: {error}"))?;
    let process = process_snapshot(std::process::id())
        .map_err(|error| format!("Cannot identify the desktop shell process: {error}"))?;
    if process.started_at_micros == 0 {
        return Err("Desktop shell process start time is unavailable".into());
    }
    let record = InstanceRecord {
        pid: process.id,
        started_at_micros: process.started_at_micros,
        port: address.port(),
        nonce: random_nonce()?,
    };
    let record_path = data_dir.join(RECORD_FILE);
    write_record(&record_path, &record)?;

    let (sender, receiver) = mpsc::channel();
    let stop = Arc::new(AtomicBool::new(false));
    let server_stop = Arc::clone(&stop);
    let nonce = record.nonce.clone();
    let server = thread::Builder::new()
        .name("shell-instance".into())
        .spawn(move || serve(listener, nonce, sender, server_stop));
    let server = match server {
        Ok(server) => server,
        Err(error) => {
            remove_record_if_owned(
                &record_path,
                ProcessOwner {
                    pid: record.pid,
                    started_at_micros: record.started_at_micros,
                },
            );
            return Err(format!(
                "Cannot start the desktop shell activation thread: {error}"
            ));
        }
    };

    Ok((
        PrimaryInstance {
            _lock: lock,
            record_path,
            owner: ProcessOwner {
                pid: record.pid,
                started_at_micros: record.started_at_micros,
            },
            address,
            stop,
            server: Mutex::new(Some(server)),
        },
        receiver,
    ))
}

fn random_nonce() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Cannot generate the desktop shell activation nonce: {error}"))?;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut nonce = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        nonce.push(HEX[usize::from(byte >> 4)] as char);
        nonce.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    Ok(nonce)
}

fn write_record(path: &Path, record: &InstanceRecord) -> Result<(), String> {
    let data_dir = path
        .parent()
        .ok_or("Desktop shell instance record has no parent directory")?;
    let mut file = tempfile::NamedTempFile::new_in(data_dir)
        .map_err(|error| format!("Cannot create the desktop shell instance record: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| {
                format!("Cannot restrict the desktop shell instance record: {error}")
            })?;
    }
    serde_json::to_writer(&mut file, record)
        .map_err(|error| format!("Cannot encode the desktop shell instance record: {error}"))?;
    writeln!(file)
        .map_err(|error| format!("Cannot write the desktop shell instance record: {error}"))?;
    file.as_file()
        .sync_all()
        .map_err(|error| format!("Cannot sync the desktop shell instance record: {error}"))?;
    file.persist(path).map_err(|error| {
        format!(
            "Cannot publish the desktop shell instance record: {}",
            error.error
        )
    })?;
    Ok(())
}

enum RecordState {
    Live(InstanceRecord),
    Missing,
    Invalid(String),
    Stopped(String),
}

fn read_live_record(data_dir: &Path) -> RecordState {
    let path = data_dir.join(RECORD_FILE);
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return RecordState::Missing,
        Err(error) => {
            return RecordState::Invalid(format!("Cannot inspect {}: {error}", path.display()));
        }
    };
    if metadata.len() > MAX_RECORD_BYTES {
        return RecordState::Invalid(format!("{} is too large", path.display()));
    }
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return RecordState::Invalid(format!("Cannot read {}: {error}", path.display()));
        }
    };
    let record = match serde_json::from_slice::<InstanceRecord>(&bytes) {
        Ok(record) if record.has_valid_identity() => record,
        Ok(_) => {
            return RecordState::Invalid(format!("{} has an invalid identity", path.display()));
        }
        Err(error) => {
            return RecordState::Invalid(format!("Cannot parse {}: {error}", path.display()));
        }
    };
    if process_instance(record.pid, record.started_at_micros).is_some() {
        RecordState::Live(record)
    } else {
        RecordState::Stopped(format!(
            "Desktop shell PID {} is no longer the recorded process",
            record.pid
        ))
    }
}

fn activate(record: &InstanceRecord, action: Activation) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    allow_forwarded_window_activation(record.pid);

    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, record.port));
    let mut stream = TcpStream::connect_timeout(&address, IO_TIMEOUT)
        .map_err(|error| format!("Cannot contact the existing desktop shell: {error}"))?;
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .and_then(|()| stream.set_write_timeout(Some(IO_TIMEOUT)))
        .map_err(|error| {
            format!("Cannot configure the desktop shell activation request: {error}")
        })?;
    let mut request = serde_json::to_vec(&ActivationRequest {
        nonce: record.nonce.clone(),
        action,
    })
    .map_err(|error| format!("Cannot encode the desktop shell activation request: {error}"))?;
    request.push(b'\n');
    stream
        .write_all(&request)
        .map_err(|error| format!("Cannot send the desktop shell activation request: {error}"))?;
    let mut response = String::new();
    BufReader::new(&stream)
        .read_line(&mut response)
        .map_err(|error| format!("Cannot read the desktop shell activation response: {error}"))?;
    if response.trim() == "ok" {
        Ok(())
    } else {
        Err("The existing desktop shell rejected the activation request".into())
    }
}

#[cfg(target_os = "windows")]
fn allow_forwarded_window_activation(process_id: u32) {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn AllowSetForegroundWindow(process_id: u32) -> i32;
    }
    // SAFETY: the call only takes the recorded process ID and has no pointers.
    unsafe {
        AllowSetForegroundWindow(process_id);
    }
}

fn serve(
    listener: TcpListener,
    nonce: String,
    activations: mpsc::Sender<Activation>,
    stop: Arc<AtomicBool>,
) {
    while !stop.load(Ordering::Acquire) {
        let Ok((stream, _)) = listener.accept() else {
            return;
        };
        if stop.load(Ordering::Acquire) {
            return;
        }
        let _ = handle_activation(stream, &nonce, &activations, &stop);
    }
}

fn handle_activation(
    mut stream: TcpStream,
    nonce: &str,
    activations: &mpsc::Sender<Activation>,
    stop: &AtomicBool,
) -> Result<(), String> {
    stream
        .set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|error| format!("Cannot configure the activation connection: {error}"))?;
    let Some(request) = read_activation_request(&mut stream, stop)? else {
        return Ok(());
    };
    let accepted = request.len() as u64 <= MAX_REQUEST_BYTES
        && serde_json::from_str::<ActivationRequest>(&request)
            .ok()
            .filter(|request| request.nonce == nonce)
            .is_some_and(|request| activations.send(request.action).is_ok());
    stream
        .write_all(if accepted { b"ok\n" } else { b"denied\n" })
        .map_err(|error| format!("Cannot write the activation response: {error}"))
}

fn read_activation_request(
    stream: &mut TcpStream,
    stop: &AtomicBool,
) -> Result<Option<String>, String> {
    let deadline = Instant::now() + IO_TIMEOUT;
    let max_bytes = (MAX_REQUEST_BYTES as usize).saturating_add(1);
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 1024];

    loop {
        if stop.load(Ordering::Acquire) {
            return Ok(None);
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return Ok(None);
        };
        if remaining.is_zero() {
            return Ok(None);
        }

        // Slice read timeouts so shutdown and total request deadline cannot be stalled by slow-drip writes.
        let slice_timeout = remaining
            .min(READ_POLL_INTERVAL)
            .max(Duration::from_millis(1));
        stream
            .set_read_timeout(Some(slice_timeout))
            .map_err(|error| format!("Cannot configure the activation connection: {error}"))?;

        let to_read = chunk.len().min(max_bytes - bytes.len());
        match stream.read(&mut chunk[..to_read]) {
            Ok(0) => break,
            Ok(read) => {
                let data = &chunk[..read];
                if let Some(newline) = data.iter().position(|&byte| byte == b'\n') {
                    bytes.extend_from_slice(&data[..=newline]);
                    break;
                }
                bytes.extend_from_slice(data);
                if bytes.len() >= max_bytes {
                    break;
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                ) =>
            {
                continue;
            }
            Err(error) => return Err(format!("Cannot read the activation request: {error}")),
        }
    }

    let request = String::from_utf8(bytes)
        .map_err(|error| format!("Cannot read the activation request: {error}"))?;
    Ok(Some(request))
}

fn remove_record_if_owned(path: &Path, owner: ProcessOwner) {
    if fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<InstanceRecord>(&bytes).ok())
        .is_some_and(|record| {
            record.pid == owner.pid && record.started_at_micros == owner.started_at_micros
        })
    {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::TryRecvError;

    struct AliasedTempDir {
        _root: tempfile::TempDir,
        alias: PathBuf,
        canonical: PathBuf,
    }

    fn test_retry() -> RetryPolicy {
        RetryPolicy {
            timeout: Duration::from_secs(1),
            interval: Duration::from_millis(5),
        }
    }

    fn test_base() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../target/shell-instance-tests")
    }

    #[cfg(unix)]
    fn aliased_temp_dir() -> AliasedTempDir {
        use std::os::unix::fs::symlink;

        let base = test_base();
        fs::create_dir_all(&base).unwrap();
        let root = tempfile::Builder::new()
            .prefix("instance-")
            .tempdir_in(base)
            .unwrap();
        let canonical_root = root.path().canonicalize().unwrap();

        #[cfg(target_os = "macos")]
        if let Ok(relative) = canonical_root.strip_prefix("/private/tmp") {
            let alias = Path::new("/tmp").join(relative);
            if alias.is_dir() {
                return AliasedTempDir {
                    _root: root,
                    alias,
                    canonical: canonical_root,
                };
            }
        }

        let actual = canonical_root.join("actual");
        let alias = canonical_root.join("alias");
        fs::create_dir_all(&actual).unwrap();
        symlink("actual", &alias).unwrap();
        AliasedTempDir {
            _root: root,
            alias,
            canonical: actual,
        }
    }

    #[cfg(windows)]
    fn aliased_temp_dir() -> AliasedTempDir {
        let base = test_base();
        fs::create_dir_all(&base).unwrap();
        let root = tempfile::Builder::new()
            .prefix("instance-")
            .tempdir_in(base)
            .unwrap();
        let canonical = root.path().join("data");
        fs::create_dir_all(root.path().join("nested")).unwrap();
        let alias = root.path().join("nested/../data");
        AliasedTempDir {
            _root: root,
            alias,
            canonical,
        }
    }

    #[test]
    fn same_data_directory_forwards_onboarding_and_show_requests() {
        let temp = aliased_temp_dir();
        let alias_data = temp.alias.join("data");
        let canonical_data = temp.canonical.join("data");
        let Claim::Primary {
            instance,
            activations,
        } = claim_with(&alias_data, Activation::Show, test_retry(), || {}).unwrap()
        else {
            panic!("the first claim must own the data directory");
        };
        assert!(instance.address().ip().is_loopback());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(canonical_data.join(RECORD_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }

        assert!(matches!(
            claim_with(&canonical_data, Activation::Onboarding, test_retry(), || {}).unwrap(),
            Claim::Forwarded
        ));
        assert_eq!(
            activations.recv_timeout(Duration::from_secs(1)).unwrap(),
            Activation::Onboarding
        );
        assert!(matches!(
            claim_with(&alias_data, Activation::Show, test_retry(), || {}).unwrap(),
            Claim::Forwarded
        ));
        assert_eq!(
            activations.recv_timeout(Duration::from_secs(1)).unwrap(),
            Activation::Show
        );

        instance.shutdown();
        assert!(!canonical_data.join(RECORD_FILE).exists());
        assert!(canonical_data.join(LOCK_FILE).is_file());
        // Calling shutdown before Drop (as RunEvent::Exit does) must remain idempotent.
        drop(instance);
        assert!(!canonical_data.join(RECORD_FILE).exists());
        assert!(canonical_data.join(LOCK_FILE).is_file());
    }

    #[test]
    fn different_data_directories_have_independent_instances() {
        let first = aliased_temp_dir();
        let second = aliased_temp_dir();
        let Claim::Primary {
            instance: first_instance,
            activations: first_activations,
        } = claim_with(
            &first.alias.join("data"),
            Activation::Show,
            test_retry(),
            || {},
        )
        .unwrap()
        else {
            panic!("the first data directory must start an instance");
        };
        let Claim::Primary {
            instance: second_instance,
            activations: second_activations,
        } = claim_with(
            &second.canonical.join("data"),
            Activation::Onboarding,
            test_retry(),
            || {},
        )
        .unwrap()
        else {
            panic!("the second data directory must start an instance");
        };
        assert_ne!(
            first_instance.address().port(),
            second_instance.address().port()
        );

        assert!(matches!(
            claim_with(
                &first.canonical.join("data"),
                Activation::Onboarding,
                test_retry(),
                || {},
            )
            .unwrap(),
            Claim::Forwarded
        ));
        assert_eq!(
            first_activations
                .recv_timeout(Duration::from_secs(1))
                .unwrap(),
            Activation::Onboarding
        );
        assert!(matches!(
            second_activations.try_recv(),
            Err(TryRecvError::Empty)
        ));
    }

    #[test]
    fn waits_for_a_delayed_record_and_then_forwards() {
        let temp = aliased_temp_dir();
        let alias_data = temp.alias.join("data");
        let canonical_data = temp.canonical.join("data");
        let normalized = normalize_data_dir(&alias_data).unwrap();
        let lock_path = normalized.join(LOCK_FILE);
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .unwrap();
        assert!(try_lock(&lock).unwrap());

        let (waited_sender, waited_receiver) = mpsc::channel();
        let secondary = thread::spawn(move || {
            claim_with(&canonical_data, Activation::Show, test_retry(), || {
                let _ = waited_sender.send(());
            })
        });
        waited_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("the second claim must enter the retry window");
        assert!(!normalized.join(RECORD_FILE).exists());

        let (instance, activations) = start_primary(normalized, lock).unwrap();
        assert!(matches!(
            secondary.join().unwrap().unwrap(),
            Claim::Forwarded
        ));
        assert_eq!(
            activations.recv_timeout(Duration::from_secs(1)).unwrap(),
            Activation::Show
        );
        drop(instance);
    }

    #[test]
    fn replaces_a_stale_record_after_its_lock_is_released() {
        let temp = aliased_temp_dir();
        let data_dir = temp.canonical.join("data");
        let normalized = normalize_data_dir(&data_dir).unwrap();
        fs::write(normalized.join(LOCK_FILE), []).unwrap();
        let (stale_pid, stale_started) = exited_process_identity();
        let stale = InstanceRecord {
            pid: stale_pid,
            started_at_micros: stale_started,
            port: 9,
            nonce: "0".repeat(64),
        };
        write_record(&normalized.join(RECORD_FILE), &stale).unwrap();

        let Claim::Primary { instance, .. } =
            claim_with(&data_dir, Activation::Show, test_retry(), || {}).unwrap()
        else {
            panic!("the released lock must let a new process become primary");
        };
        let current: InstanceRecord =
            serde_json::from_slice(&fs::read(normalized.join(RECORD_FILE)).unwrap()).unwrap();
        assert_eq!(current.pid, std::process::id());
        assert_ne!(current.nonce, stale.nonce);
        assert_ne!(
            (current.pid, current.started_at_micros),
            (stale.pid, stale.started_at_micros)
        );
        drop(instance);
    }

    #[test]
    fn removes_only_the_record_owned_by_the_same_process_instance() {
        let temp = aliased_temp_dir();
        let data_dir = normalize_data_dir(&temp.alias.join("data")).unwrap();
        let current = process_snapshot(std::process::id()).unwrap();
        let record = InstanceRecord {
            pid: current.id,
            started_at_micros: current.started_at_micros,
            port: 1,
            nonce: "0".repeat(64),
        };
        let path = data_dir.join(RECORD_FILE);
        write_record(&path, &record).unwrap();
        remove_record_if_owned(
            &path,
            ProcessOwner {
                pid: current.id,
                started_at_micros: current.started_at_micros + 1,
            },
        );
        assert!(path.is_file());
        remove_record_if_owned(
            &path,
            ProcessOwner {
                pid: current.id,
                started_at_micros: current.started_at_micros,
            },
        );
        assert!(!path.exists());
    }

    #[test]
    fn slow_drip_client_does_not_block_subsequent_activations() {
        let temp = aliased_temp_dir();
        let data_dir = temp.canonical.join("data");
        let Claim::Primary {
            instance,
            activations,
        } = claim_with(&data_dir, Activation::Show, test_retry(), || {}).unwrap()
        else {
            panic!("the first claim must own the data directory");
        };

        let mut drip_stream = TcpStream::connect(instance.address()).unwrap();
        drip_stream.write_all(b"{").unwrap();
        let stop_drip = Arc::new(AtomicBool::new(false));
        let stop_drip_thread = Arc::clone(&stop_drip);
        let drip = thread::spawn(move || {
            for _ in 0..50 {
                if stop_drip_thread.load(Ordering::Acquire) {
                    break;
                }
                thread::sleep(Duration::from_millis(40));
                if drip_stream.write_all(b" ").is_err() {
                    break;
                }
            }
        });

        thread::sleep(Duration::from_millis(50));
        let started = Instant::now();
        let forwarded = claim_with(
            &data_dir,
            Activation::Onboarding,
            RetryPolicy {
                timeout: Duration::from_millis(1500),
                interval: Duration::from_millis(10),
            },
            || {},
        );
        let elapsed = started.elapsed();

        stop_drip.store(true, Ordering::Release);
        let _ = drip.join();

        assert!(
            matches!(forwarded, Ok(Claim::Forwarded)),
            "subsequent activation should succeed despite slow-drip client: {}",
            match forwarded {
                Ok(_) => "unexpected primary claim".into(),
                Err(error) => error,
            }
        );
        assert!(
            elapsed < Duration::from_millis(1500),
            "slow-drip client blocked subsequent activation for {elapsed:?}"
        );
        assert_eq!(
            activations.recv_timeout(Duration::from_secs(1)).unwrap(),
            Activation::Onboarding
        );
        instance.shutdown();
    }

    #[test]
    fn shutdown_is_not_blocked_by_incomplete_client_connection() {
        let temp = aliased_temp_dir();
        let data_dir = temp.canonical.join("data");
        let Claim::Primary { instance, .. } =
            claim_with(&data_dir, Activation::Show, test_retry(), || {}).unwrap()
        else {
            panic!("the first claim must own the data directory");
        };

        let mut open_stream = TcpStream::connect(instance.address()).unwrap();
        open_stream.write_all(b"{").unwrap();
        let stop_client = Arc::new(AtomicBool::new(false));
        let stop_client_thread = Arc::clone(&stop_client);
        let client = thread::spawn(move || {
            for _ in 0..10 {
                if stop_client_thread.load(Ordering::Acquire) {
                    break;
                }
                thread::sleep(Duration::from_millis(150));
                if open_stream.write_all(b" ").is_err() {
                    break;
                }
            }
        });

        thread::sleep(Duration::from_millis(50));
        let started = Instant::now();
        instance.shutdown();
        let elapsed = started.elapsed();

        stop_client.store(true, Ordering::Release);
        let _ = client.join();

        assert!(
            elapsed < Duration::from_millis(500),
            "shutdown blocked for {elapsed:?} while a client held an incomplete connection"
        );
    }

    #[cfg(unix)]
    fn exited_process_identity() -> (u32, u64) {
        use std::process::Command;

        let mut child = Command::new("sh").args(["-c", "sleep 5"]).spawn().unwrap();
        let identity = process_snapshot(child.id()).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        (identity.id, identity.started_at_micros)
    }

    #[cfg(windows)]
    fn exited_process_identity() -> (u32, u64) {
        let current = process_snapshot(std::process::id()).unwrap();
        (current.id, current.started_at_micros + 1)
    }
}
