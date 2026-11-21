//! Ownership and shutdown of a published Desktop generation on Unix.
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use codexhost_platform::{ProcessSnapshot, observe_process_identity, process_snapshot};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::desktop_lifecycle_storage::Store;
use crate::runtime_instance::{
    RuntimeDescriptor, random_nonce, read_descriptor, remove_matching_descriptor,
    try_acquire_launcher_guard,
};

const RECORD: &str = "owner.json";
const KEY: &str = "shutdown.key";
const LEGACY: &str = "Desktop control endpoint has no verified lifecycle record; quit the previous Controller before retrying";
const TIMEOUT: Duration = Duration::from_secs(10);
const WIRE_TIMEOUT: Duration = Duration::from_secs(5);
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug, PartialEq, Eq)]
enum Presence {
    Same,
    Gone,
    Reused,
}

impl Instance {
    fn presence(&self) -> Result<Presence> {
        let Some(identity) = observe_process_identity(self.pid)? else {
            return Ok(Presence::Gone);
        };
        if identity.started_at_micros != self.started_at_micros {
            return Ok(Presence::Reused);
        }
        let snapshot = match process_snapshot(self.pid) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                // The process can exit between the identity and image queries. Do not
                // confuse an unreadable image with an absent process.
                return match observe_process_identity(self.pid)? {
                    None => Ok(Presence::Gone),
                    Some(current) if current.started_at_micros != self.started_at_micros => {
                        Ok(Presence::Reused)
                    }
                    Some(_) => Err(error.into()),
                };
            }
        };
        if snapshot.started_at_micros != self.started_at_micros {
            return Ok(Presence::Reused);
        }
        if snapshot.executable != self.executable {
            return Err("Desktop process executable identity changed".into());
        }
        Ok(Presence::Same)
    }
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Owner {
    schema_version: u8,
    generation: String,
    port: u16,
    data: PathBuf,
    launcher: Instance,
    controller: Instance,
    controller_entry: PathBuf,
    desktop: Instance,
}

fn sha(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn generation(value: &RuntimeDescriptor) -> Result<String> {
    Ok(hex(&sha(&serde_json::to_vec(value)?)))
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
    store: Store,
}

impl Lifecycle {
    pub(super) fn open(descriptor: &Path) -> Result<Self> {
        Ok(Self {
            descriptor: descriptor.into(),
            store: Store::open(
                descriptor
                    .parent()
                    .ok_or("invalid Desktop runtime directory")?,
            )?,
        })
    }

    pub(super) fn lock(&self) -> Result<File> {
        Ok(self.store.lock()?)
    }

    pub(super) fn record_start(
        self,
        descriptor: &RuntimeDescriptor,
        data: &Path,
        desktop: &ProcessSnapshot,
        controller: &ProcessSnapshot,
        entry: &Path,
    ) -> Result<(Published, [u8; 64])> {
        fs::create_dir_all(data)?;
        let launcher = process_snapshot(std::process::id())?;
        if launcher.id != descriptor.launcher_pid || controller.parent_id != launcher.id {
            return Err("Desktop Controller is not a child of this Launcher".into());
        }
        let owner = Owner {
            schema_version: 1,
            generation: generation(descriptor)?,
            port: descriptor.control_port,
            data: data.canonicalize()?,
            launcher: (&launcher).into(),
            controller: controller.into(),
            controller_entry: entry.canonicalize()?,
            desktop: desktop.into(),
        };
        let bytes = serde_json::to_vec(&owner)?;
        let mut bootstrap = [0; 64];
        getrandom::fill(&mut bootstrap[..32])
            .map_err(|error| io::Error::other(error.to_string()))?;
        bootstrap[32..].copy_from_slice(&sha(&bytes));
        // A child cannot open its listener until it receives the bootstrap. A crash in
        // between the two writes can leave only a key, never an unrecorded listener.
        self.store.publish(KEY, &bootstrap[..32])?;
        self.store.publish(RECORD, &bytes)?;
        Ok((
            Published {
                lifecycle: self,
                owner,
            },
            bootstrap,
        ))
    }

    fn read(&self) -> Result<Option<(Owner, [u8; 32])>> {
        let Some(bytes) = self.store.read(RECORD, 24 * 1024)? else {
            return Ok(None);
        };
        let owner: Owner = serde_json::from_slice(&bytes)?;
        if owner.schema_version != 1
            || owner.port == 0
            || !owner.data.is_absolute()
            || !owner.controller_entry.is_absolute()
            || [&owner.launcher, &owner.controller, &owner.desktop]
                .iter()
                .any(|instance| {
                    instance.pid <= 1
                        || instance.started_at_micros == 0
                        || !instance.executable.is_absolute()
                })
            || owner.launcher.pid == owner.controller.pid
            || owner.controller.pid == owner.desktop.pid
        {
            return Err("invalid Desktop lifecycle owner record".into());
        }
        Ok(Some((owner, sha(&bytes))))
    }

    fn matching_descriptor(&self, owner: &Owner) -> Result<Option<RuntimeDescriptor>> {
        let descriptor = read_descriptor(&self.descriptor)?;
        if let Some(value) = &descriptor
            && (value.launcher_pid != owner.launcher.pid
                || value.control_port != owner.port
                || generation(value)? != owner.generation)
        {
            return Err("Desktop runtime descriptor and lifecycle generation do not match".into());
        }
        Ok(descriptor)
    }

    fn remove(&self, owner: &Owner) -> Result<()> {
        if self.read()?.is_none_or(|(current, _)| current != *owner) {
            return Ok(());
        }
        if let Some(descriptor) = self.matching_descriptor(owner)? {
            remove_matching_descriptor(&self.descriptor, &descriptor)?;
        }
        self.store.remove(RECORD)?;
        self.store.remove(KEY)?;
        Ok(())
    }

    fn check_scope(&self, owner: &Owner, data: &Path) -> Result<()> {
        if data.canonicalize().ok().as_ref() != Some(&owner.data) {
            return Err(
                "Desktop belongs to a different CODEXHOST_DATA_DIR; no GUI action taken".into(),
            );
        }
        if std::env::current_exe()?.canonicalize()? != owner.launcher.executable {
            return Err("Desktop belongs to a different installation; no GUI action taken".into());
        }
        Ok(())
    }

    pub(super) fn check_attachment_scope(&self, data: &Path) -> Result<()> {
        if let Some((owner, _)) = self.read()? {
            self.matching_descriptor(&owner)?;
            self.check_scope(&owner, data)?;
        }
        Ok(())
    }

    /// A read-only query for update preparation. An orphan is not a running Desktop.
    pub(super) fn desktop_running(&self, data: &Path) -> Result<bool> {
        let Some((owner, _)) = self.read()? else {
            if let Some(value) = read_descriptor(&self.descriptor)?
                && !port_closed(value.control_port)?
            {
                return Err(LEGACY.into());
            }
            return Ok(false);
        };
        self.matching_descriptor(&owner)?;
        self.check_scope(&owner, data)?;
        Ok(owner.desktop.presence()? == Presence::Same)
    }

    /// Called with the operation lock. No numeric PID is ever signaled here.
    /// Returns true if a residual generation was found (even when already dead).
    pub(super) fn reconcile(
        &self,
        data: &Path,
        launcher_lock_free: bool,
        for_launch: bool,
    ) -> Result<bool> {
        let Some((owner, context)) = self.read()? else {
            let Some(descriptor) = read_descriptor(&self.descriptor)? else {
                return Ok(false);
            };
            if !port_closed(descriptor.control_port)? {
                return Err(LEGACY.into());
            }
            if !launcher_lock_free || observe_process_identity(descriptor.launcher_pid)?.is_some() {
                return Err(
                    "Legacy Desktop Launcher state is unconfirmed; no GUI action taken".into(),
                );
            }
            remove_matching_descriptor(&self.descriptor, &descriptor)?;
            return Ok(true);
        };
        self.matching_descriptor(&owner)?;
        self.check_scope(&owner, data)?;
        let launcher = owner.launcher.presence()?;
        let orphan = launcher != Presence::Same;
        if orphan != launcher_lock_free || for_launch && !orphan {
            return Err("Desktop Launcher ownership changed; retry after it settles".into());
        }
        if orphan {
            require_no_desktop(&owner)?;
        }
        match owner.controller.presence()? {
            Presence::Same => {
                let observed = process_snapshot(owner.controller.pid)?;
                if !orphan && observed.parent_id != owner.launcher.pid
                    || orphan && observed.parent_id == owner.launcher.pid
                {
                    return Err("Desktop Controller parent identity does not match".into());
                }
                let key = self
                    .store
                    .read(KEY, 32)?
                    .filter(|bytes| bytes.len() == 32)
                    .ok_or("Desktop Controller lifecycle key is unavailable")?;
                authenticated_stop(&owner, &context, &key, || {
                    if owner.controller.presence()? != Presence::Same
                        || owner.launcher.presence()? != launcher
                    {
                        return Err(
                            "Desktop Launcher or Controller identity changed during verification"
                                .into(),
                        );
                    }
                    if orphan {
                        require_no_desktop(&owner)?;
                    }
                    Ok(())
                })?;
            }
            Presence::Gone if port_closed(owner.port)? => {}
            _ => {
                return Err(
                    "Desktop Controller identity does not match; no process was stopped".into(),
                );
            }
        }
        let started = Instant::now();
        loop {
            if owner.controller.presence()? != Presence::Same
                && port_closed(owner.port)?
                && owner.launcher.presence()? != Presence::Same
                && owner.desktop.presence()? != Presence::Same
            {
                self.remove(&owner)?;
                return Ok(true);
            }
            if started.elapsed() >= TIMEOUT {
                return Err(format!("Desktop shutdown timed out (Controller: {:?}, Launcher: {:?}, Desktop: {:?}, listener closed: {})", owner.controller.presence()?, owner.launcher.presence()?, owner.desktop.presence()?, port_closed(owner.port)?).into());
            }
            thread::sleep(Duration::from_millis(25));
        }
    }
}

fn require_no_desktop(owner: &Owner) -> Result<()> {
    if owner.desktop.presence()? == Presence::Same
        || codexhost_platform::process_snapshots()?
            .iter()
            .any(|process| process.executable == owner.desktop.executable)
    {
        return Err("Desktop is still running without its Launcher; orphan cleanup refused".into());
    }
    Ok(())
}

pub(super) fn running_for_update(data: &Path) -> Result<bool> {
    Lifecycle::open(&crate::runtime_instance::default_descriptor_path()?)?.desktop_running(data)
}

pub(super) fn stop_managed(data: &Path) -> Result<bool> {
    let lifecycle = Lifecycle::open(&crate::runtime_instance::default_descriptor_path()?)?;
    let _operation = lifecycle.lock()?;
    let launcher = try_acquire_launcher_guard(&crate::runtime_instance::default_guard_path()?)?;
    lifecycle.reconcile(data, launcher.is_some(), false)
}

pub(super) struct Published {
    lifecycle: Lifecycle,
    owner: Owner,
}

impl Drop for Published {
    fn drop(&mut self) {
        // The supervising Launcher still owns launcher-v1.lock here. A stop caller
        // may own the operation lock and be waiting for us; never reacquire it here.
        if matches!(self.owner.controller.presence(), Ok(Presence::Gone))
            && matches!(self.owner.desktop.presence(), Ok(Presence::Gone))
            && matches!(port_closed(self.owner.port), Ok(true))
        {
            let _ = self.lifecycle.remove(&self.owner);
        }
    }
}

fn authenticator(key: &[u8], role: &str, transcript: &str) -> Hmac<Sha256> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts keys of any size");
    mac.update(role.as_bytes());
    mac.update(b":");
    mac.update(transcript.as_bytes());
    mac
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

fn read_wire_line(stream: &mut TcpStream, maximum: usize) -> io::Result<String> {
    let deadline = Instant::now() + WIRE_TIMEOUT;
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

fn authenticated_stop(
    owner: &Owner,
    context: &[u8; 32],
    key: &[u8],
    recheck: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let mut stream = transport(owner.port)?;
    stream.set_write_timeout(Some(WIRE_TIMEOUT))?;
    let client = random_nonce()?;
    stream.write_all(format!("LIFECYCLE 1 {client}\n").as_bytes())?;
    let response = read_wire_line(&mut stream, 112)
        .map_err(|error| format!("Desktop Controller identity probe failed: {error}"))?;
    let mut parts = response.strip_suffix('\n').unwrap_or("").split(' ');
    let invalid =
        "Desktop Controller endpoint did not prove its lifecycle identity; no process was stopped";
    if parts.next() != Some("identity") {
        return Err(invalid.into());
    }
    let server = parts
        .next()
        .filter(|value| unhex::<16>(value).is_some())
        .ok_or(invalid)?;
    let proof = parts.next().and_then(unhex::<32>).ok_or(invalid)?;
    if parts.next().is_some() {
        return Err(invalid.into());
    }
    let transcript = format!(
        "{}:{}:{client}:{server}",
        hex(context),
        owner.controller.pid
    );
    authenticator(key, "identity", &transcript)
        .verify_slice(&proof)
        .map_err(|_| invalid)?;
    recheck()?;
    let proof = authenticator(key, "stop", &transcript)
        .finalize()
        .into_bytes();
    stream.write_all(format!("stop {}\n", hex(&proof)).as_bytes())?;
    if read_wire_line(&mut stream, 16)? != "stopping\n" {
        return Err("Desktop Controller did not acknowledge the shutdown request".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "desktop_lifecycle_tests.rs"]
mod tests;
