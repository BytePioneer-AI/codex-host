//! Unix Desktop ownership. Only a live supervisor may stop a managed child natively.
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use codexhost_platform::{
    ProcessIdentity, ProcessSnapshot, observe_process_identity, process_snapshot,
};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::desktop_lifecycle_storage::Store;
use crate::runtime_instance::{
    RuntimeDescriptor, random_nonce, read_descriptor, remove_matching_descriptor,
    try_acquire_launcher_guard,
};

const RECORD: &str = "owner.json";
const STOP: &str = "stop-request";
const POLL: Duration = Duration::from_millis(25);
const WIRE_TIMEOUT: Duration = Duration::from_secs(5);
pub(super) type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Instance {
    pid: u32,
    started_at_micros: u64,
    executable: PathBuf,
}

impl From<&ProcessSnapshot> for Instance {
    fn from(snapshot: &ProcessSnapshot) -> Self {
        Self {
            pid: snapshot.id,
            started_at_micros: snapshot.started_at_micros,
            executable: snapshot.executable.clone(),
        }
    }
}

impl Instance {
    // Both a missing PID and a reused PID mean the original instance ended. Do not
    // read /proc/PID/exe here: Linux can tear it down before reporting a zombie.
    fn live(&self) -> Result<Option<ProcessIdentity>> {
        Ok(observe_process_identity(self.pid)?
            .filter(|id| id.started_at_micros == self.started_at_micros))
    }

    fn verify_image(&self) -> Result<()> {
        let observed = Self::from(&process_snapshot(self.pid)?);
        if observed.pid != self.pid
            || observed.started_at_micros != self.started_at_micros
            || !same_executable(&self.executable, &observed.executable)
        {
            return Err("Desktop process executable or instance identity changed".into());
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Owner {
    descriptor: RuntimeDescriptor,
    data: PathBuf,
    launcher: Instance,
    controller: Instance,
    desktop: Instance,
    key: [u8; 32],
}

impl Owner {
    fn ended(&self) -> Result<bool> {
        Ok(self.controller.live()?.is_none()
            && self.desktop.live()?.is_none()
            && self.launcher.live()?.is_none()
            && port_closed(self.descriptor.control_port)?)
    }

    fn check_scope(&self, data: &Path) -> Result<()> {
        if data.canonicalize().ok().as_ref() != Some(&self.data) {
            return Err(
                "Desktop belongs to a different CODEXHOST_DATA_DIR; no GUI action taken".into(),
            );
        }
        check_installation(&self.launcher.executable)
    }

    fn check_orphan(&self) -> Result<()> {
        if self.launcher.live()?.is_some()
            || self
                .controller
                .live()?
                .is_none_or(|id| id.parent_id == self.launcher.pid)
        {
            return Err(
                "Desktop Launcher or Controller identity does not match; no process was stopped"
                    .into(),
            );
        }
        self.controller.verify_image()?;
        if self.desktop.live()?.is_some()
            || codexhost_platform::process_snapshots()?
                .iter()
                .any(|p| p.executable == self.desktop.executable)
        {
            return Err(
                "Desktop is still running without its Launcher; orphan cleanup refused".into(),
            );
        }
        Ok(())
    }
}

#[cfg(any(target_os = "linux", test))]
fn stripped_deleted_executable(observed: &Path) -> Option<PathBuf> {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let original = observed
        .as_os_str()
        .as_bytes()
        .strip_suffix(b" (deleted)")?;
    (!observed.exists()).then(|| PathBuf::from(OsStr::from_bytes(original)))
}

fn same_executable(expected: &Path, observed: &Path) -> bool {
    if observed == expected {
        return true;
    }
    #[cfg(target_os = "linux")]
    if let Some(original) = stripped_deleted_executable(observed) {
        return original == expected;
    }
    false
}

fn check_installation(executable: &Path) -> Result<()> {
    let current = std::env::current_exe()?.canonicalize()?;
    if !same_executable(&current, executable) {
        return Err("Desktop belongs to a different installation; no GUI action taken".into());
    }
    Ok(())
}

fn transport(port: u16) -> io::Result<TcpStream> {
    TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(300),
    )
}

pub(super) fn port_closed(port: u16) -> Result<bool> {
    match transport(port) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => Ok(true),
        Err(error) => Err(format!("Desktop control listener state is unconfirmed: {error}").into()),
    }
}

pub(super) struct Lifecycle {
    descriptor: PathBuf,
    store: Option<Store>,
}

enum State {
    Empty,
    Legacy(RuntimeDescriptor),
    Owned(Box<Owner>, bool),
}

impl Lifecycle {
    pub(super) fn open(descriptor: &Path, create: bool) -> Result<Self> {
        let runtime = descriptor
            .parent()
            .ok_or("invalid Desktop runtime directory")?;
        let store = match Store::open(runtime, create) {
            Ok(store) => Some(store),
            Err(error) if !create && error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        Ok(Self {
            descriptor: descriptor.into(),
            store,
        })
    }

    fn store(&self) -> &Store {
        self.store
            .as_ref()
            .expect("operation requires lifecycle storage")
    }

    pub(super) fn lock(&self, deadline: Instant) -> Result<File> {
        Ok(self.store().lock(deadline)?)
    }

    pub(super) fn launcher_guard(&self) -> Result<Option<crate::runtime_instance::LauncherGuard>> {
        Ok(try_acquire_launcher_guard(
            &crate::runtime_instance::guard_path(&self.descriptor),
        )?)
    }

    pub(super) fn record_start(
        self,
        descriptor: RuntimeDescriptor,
        data: &Path,
        desktop: &ProcessSnapshot,
        controller: &ProcessSnapshot,
    ) -> Result<Published> {
        fs::create_dir_all(data)?;
        let launcher = process_snapshot(std::process::id())?;
        if launcher.id != descriptor.launcher_pid || controller.parent_id != launcher.id {
            return Err("Desktop Controller is not a child of this Launcher".into());
        }
        let mut key = [0; 32];
        getrandom::fill(&mut key).map_err(|error| io::Error::other(error.to_string()))?;
        let owner = Owner {
            descriptor,
            data: data.canonicalize()?,
            launcher: (&launcher).into(),
            controller: controller.into(),
            desktop: desktop.into(),
            key,
        };
        // Publish all private state before the child can open its listener.
        self.store().remove(STOP)?;
        self.store().publish(RECORD, &serde_json::to_vec(&owner)?)?;
        Ok(Published {
            lifecycle: self,
            owner,
        })
    }

    fn read(&self) -> Result<Option<Owner>> {
        let Some(bytes) = self
            .store
            .as_ref()
            .map(|store| store.read(RECORD, 24 * 1024))
            .transpose()?
            .flatten()
        else {
            return Ok(None);
        };
        let owner: Owner = serde_json::from_slice(&bytes)?;
        owner.descriptor.validate()?;
        if !owner.data.is_absolute()
            || owner.descriptor.launcher_pid != owner.launcher.pid
            || [&owner.launcher, &owner.controller, &owner.desktop]
                .iter()
                .any(|p| p.pid <= 1 || p.started_at_micros == 0 || !p.executable.is_absolute())
            || owner.launcher.pid == owner.controller.pid
            || owner.controller.pid == owner.desktop.pid
            || owner.launcher.pid == owner.desktop.pid
        {
            return Err("invalid Desktop lifecycle owner record".into());
        }
        Ok(Some(owner))
    }

    fn inspect(&self, data: &Path, guard_free: bool) -> Result<State> {
        let owner = self.read()?;
        let descriptor = read_descriptor(&self.descriptor)?;
        if let Some(owner) = owner {
            if descriptor
                .as_ref()
                .is_some_and(|value| *value != owner.descriptor)
            {
                return Err(
                    "Desktop runtime descriptor and lifecycle generation do not match".into(),
                );
            }
            if !guard_free || !owner.ended()? {
                owner.check_scope(data)?;
                let launcher = owner.launcher.live()?;
                if launcher.is_some() == guard_free {
                    return Err("Desktop Launcher ownership changed; retry after it settles".into());
                }
                if !guard_free {
                    owner.launcher.verify_image()?;
                    if owner
                        .controller
                        .live()?
                        .is_some_and(|id| id.parent_id != owner.launcher.pid)
                    {
                        return Err("Desktop Controller parent identity does not match".into());
                    }
                }
            }
            return Ok(State::Owned(Box::new(owner), descriptor.is_some()));
        }
        let Some(descriptor) = descriptor else {
            return Ok(State::Empty);
        };
        if guard_free && !port_closed(descriptor.control_port)? {
            return Err(legacy_recovery_hint(descriptor.control_port));
        }
        Ok(State::Legacy(descriptor))
    }

    pub(super) fn attachment(&self, data: &Path) -> Result<Option<RuntimeDescriptor>> {
        match self.inspect(data, false)? {
            State::Legacy(descriptor) => Ok(Some(descriptor)),
            State::Owned(owner, true) if !self.stop_requested(&owner)? => {
                Ok(Some(owner.descriptor))
            }
            _ => Ok(None),
        }
    }

    fn stop_requested(&self, owner: &Owner) -> Result<bool> {
        Ok(self.store().read(STOP, 32)?.as_deref() == Some(owner.descriptor.nonce.as_bytes()))
    }

    fn remove(&self, owner: &Owner) -> Result<()> {
        if self.read()?.as_ref() == Some(owner) {
            remove_matching_descriptor(&self.descriptor, &owner.descriptor)?;
            self.store().remove(STOP)?;
            self.store().remove(RECORD)?;
        }
        Ok(())
    }

    /// The caller holds the operation lock; guard_free means it also owns the Launcher guard.
    pub(super) fn reconcile(
        &self,
        data: &Path,
        guard_free: bool,
        deadline: Instant,
    ) -> Result<bool> {
        match self.inspect(data, guard_free)? {
            State::Empty if guard_free => return Ok(false),
            State::Empty => {
                return Err("Desktop Launcher is starting or stopping; retry shortly".into());
            }
            State::Legacy(descriptor) => {
                if !guard_free {
                    let (launcher, controller) = legacy_processes(&descriptor, data)?
                        .ok_or("Legacy Desktop Controller is not a verified child of its Launcher; retry after it settles")?;
                    crate::desktop_attachment::stop_controller(
                        &launcher,
                        &controller,
                        deadline.saturating_duration_since(Instant::now()),
                    )?;
                    let controller = Instance::from(&controller);
                    wait_until(deadline, || {
                        Ok(controller.live()?.is_none() && port_closed(descriptor.control_port)?)
                    })?;
                }
                remove_matching_descriptor(&self.descriptor, &descriptor)?;
            }
            State::Owned(owner, _) => {
                if !owner.ended()? {
                    if guard_free {
                        authenticated_stop(&owner, deadline)?;
                    } else {
                        self.store()
                            .publish(STOP, owner.descriptor.nonce.as_bytes())?;
                        wait_until(deadline, || owner.ended())?;
                    }
                }
                self.remove(&owner)?;
            }
        }
        Ok(true)
    }
}

fn legacy_recovery_hint(port: u16) -> Box<dyn std::error::Error> {
    format!("Desktop control endpoint has no verified lifecycle record (port {port}); quit Codex Desktop, then run `lsof -nP -iTCP:{port} -sTCP:LISTEN` and `ps -ww -p <PID> -o command=`. Only if it is the old codexhost Node Controller (desktop-controller.mjs with --attachment-port {port}), quit that PID manually and retry. Do not stop an unrelated listener.").into()
}

fn legacy_processes(
    descriptor: &RuntimeDescriptor,
    data: &Path,
) -> Result<Option<(ProcessSnapshot, ProcessSnapshot)>> {
    let launcher = match process_snapshot(descriptor.launcher_pid) {
        Ok(launcher) => launcher,
        Err(codexhost_platform::PlatformError::NotFound(_)) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    check_installation(&launcher.executable)?;
    let Some(controller) = crate::desktop_attachment::recorded_controller(data)? else {
        return Ok(None);
    };
    Ok((controller.parent_id == launcher.id
        && controller.started_at_micros >= launcher.started_at_micros)
        .then_some((launcher, controller)))
}

fn wait_until(deadline: Instant, mut predicate: impl FnMut() -> Result<bool>) -> Result<()> {
    loop {
        let observed = predicate();
        if matches!(observed, Ok(true)) {
            return Ok(());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return observed.and(Err(
                "Desktop shutdown timed out waiting for processes and listener to exit".into(),
            ));
        }
        // Exit can briefly make process inspection inconclusive. Never count it as gone.
        thread::sleep(POLL.min(remaining));
    }
}

pub(super) fn running_for_update(data: &Path) -> Result<bool> {
    let lifecycle = Lifecycle::open(&crate::runtime_instance::existing_descriptor_path()?, false)?;
    if lifecycle.store.is_none() && read_descriptor(&lifecycle.descriptor)?.is_none() {
        return Ok(false);
    }
    let _operation = lifecycle
        .store
        .as_ref()
        .map(|store| store.lock(Instant::now() + Duration::from_secs(40)))
        .transpose()?;
    let guard = lifecycle.launcher_guard()?;
    match lifecycle.inspect(data, guard.is_some())? {
        State::Legacy(descriptor) if guard.is_none() => {
            match legacy_processes(&descriptor, data)? {
                Some(_) => Ok(true),
                None if port_closed(descriptor.control_port)? => Ok(false),
                None => {
                    Err("Legacy Desktop Controller is not a verified child of its Launcher".into())
                }
            }
        }
        State::Owned(owner, _) if guard.is_none() => Ok(owner.desktop.live()?.is_some()),
        _ => Ok(false),
    }
}

/// Read-only status validation for `inspect`; unlike update checks, this never waits on lifecycle locks.
pub(super) fn launcher_pid_for_inspect(descriptor_path: &Path, data: &Path) -> Result<Option<u32>> {
    let lifecycle = Lifecycle::open(descriptor_path, false)?;
    if let Some(owner) = lifecycle.read()? {
        if data.canonicalize().ok().as_ref() != Some(&owner.data)
            || read_descriptor(descriptor_path)?.as_ref() != Some(&owner.descriptor)
        {
            return Ok(None);
        }
        let (Some(launcher), Some(controller), Some(_desktop)) = (
            owner.launcher.live()?,
            owner.controller.live()?,
            owner.desktop.live()?,
        ) else {
            return Ok(None);
        };
        if controller.parent_id != launcher.id || port_closed(owner.descriptor.control_port)? {
            return Ok(None);
        }
        return Ok(Some(launcher.id));
    }

    let Some(descriptor) = read_descriptor(descriptor_path)? else {
        return Ok(None);
    };
    if port_closed(descriptor.control_port)? {
        return Ok(None);
    }
    Ok(legacy_processes(&descriptor, data)?.map(|(launcher, _)| launcher.id))
}

pub(super) fn stop_managed(data: &Path) -> Result<bool> {
    let lock_deadline = Instant::now() + Duration::from_secs(45);
    let lifecycle = Lifecycle::open(&crate::runtime_instance::default_descriptor_path()?, true)?;
    let _operation = lifecycle.lock(lock_deadline)?;
    let guard = lifecycle.launcher_guard()?;
    // A live Launcher joins any in-flight background Web startup (40s readiness budget)
    // before exiting; give supervised shutdown enough budget to outlast it.
    let wait_budget = if guard.is_some() {
        Duration::from_secs(12)
    } else {
        Duration::from_secs(55)
    };
    lifecycle.reconcile(data, guard.is_some(), Instant::now() + wait_budget)
}

pub(super) struct Published {
    lifecycle: Lifecycle,
    owner: Owner,
}

impl Published {
    pub(super) fn bootstrap(&self, mut pipe: impl Write) -> io::Result<()> {
        pipe.write_all(&self.owner.key)
    }

    pub(super) fn stopping(&self) -> Result<bool> {
        self.lifecycle.stop_requested(&self.owner)
    }
}

impl Drop for Published {
    fn drop(&mut self) {
        // A stop caller holding this lock confirms exit and cleans up instead.
        if let Ok(_lock) = self.lifecycle.lock(Instant::now())
            && matches!(self.owner.controller.live(), Ok(None))
            && matches!(self.owner.desktop.live(), Ok(None))
            && matches!(port_closed(self.owner.descriptor.control_port), Ok(true))
        {
            let _ = self.lifecycle.remove(&self.owner);
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex<const N: usize>(value: &str) -> Option<[u8; N]> {
    if value.len() != 2 * N
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return None;
    }
    let mut bytes = [0; N];
    for (index, out) in bytes.iter_mut().enumerate() {
        *out = u8::from_str_radix(&value[2 * index..2 * index + 2], 16).ok()?;
    }
    Some(bytes)
}

fn read_wire_line(stream: &mut TcpStream, maximum: usize, deadline: Instant) -> io::Result<String> {
    let mut bytes = Vec::new();
    while bytes.len() < maximum {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        stream.set_read_timeout(Some(remaining))?;
        let mut byte = [0];
        stream.read_exact(&mut byte)?;
        bytes.push(byte[0]);
        if byte[0] == b'\n' {
            return String::from_utf8(bytes)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error));
        }
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "Desktop lifecycle reply exceeded its deadline or size limit",
    ))
}

// Before authentication errors fail closed. After a verified commit, even a lost
// receipt must be followed by a process and port check.
fn authenticated_stop(owner: &Owner, deadline: Instant) -> Result<()> {
    owner.check_orphan()?;
    let mut stream = transport(owner.descriptor.control_port)?;
    stream.set_write_timeout(Some(WIRE_TIMEOUT))?;
    let client = random_nonce()?;
    writeln!(stream, "LIFECYCLE 1 {client}")?;
    let response = read_wire_line(
        &mut stream,
        112,
        deadline.min(Instant::now() + WIRE_TIMEOUT),
    )?;
    let parts: Vec<_> = response.trim_end_matches('\n').split(' ').collect();
    let invalid =
        "Desktop Controller endpoint did not prove its lifecycle identity; no process was stopped";
    let ["identity", server, proof] = parts.as_slice() else {
        return Err(invalid.into());
    };
    let proof = unhex::<32>(proof)
        .filter(|_| unhex::<16>(server).is_some())
        .ok_or(invalid)?;
    let mac = |role: &str| {
        let mut mac = Hmac::<Sha256>::new_from_slice(&owner.key).expect("valid HMAC key");
        mac.update(
            format!(
                "{role}:{}:{}:{client}:{server}",
                owner.descriptor.nonce, owner.controller.pid
            )
            .as_bytes(),
        );
        mac
    };
    mac("identity").verify_slice(&proof).map_err(|_| invalid)?;
    owner.check_orphan()?;
    let receipt =
        writeln!(stream, "stop {}", hex(&mac("stop").finalize().into_bytes())).and_then(|()| {
            read_wire_line(&mut stream, 16, deadline.min(Instant::now() + WIRE_TIMEOUT))
        });
    wait_until(deadline, || owner.ended()).map_err(|error| match receipt {
        Ok(line) if line == "stopping\n" => error,
        Ok(_) => format!("Desktop Controller did not acknowledge shutdown: {error}").into(),
        Err(receipt) => {
            format!("Desktop Controller shutdown receipt lost ({receipt}): {error}").into()
        }
    })
}

#[cfg(test)]
#[path = "desktop_lifecycle_tests.rs"]
mod tests;
