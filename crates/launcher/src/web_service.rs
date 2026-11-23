//! Independent Web process supervision. Web owns settings and access URLs.
use std::env;
use std::error::Error;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use codexhost_platform::{
    configure_background_command, configure_detached_service_command, node_entrypoint_path,
    spawn_supervised,
};
use serde::{Deserialize, Serialize};

use crate::host_service::{clean, lifecycle_lock, publish_status, readiness};

const SETTINGS_CHANGED_EXIT_CODE: i32 = 42;
const READY: &str = "web-service-ready.json";
// Ensure and stop hold the lifecycle lock while waiting for the supervisor.
const READY_LOCK: &str = "web-service-ready.lock";
const STOP: &str = "web-service.stop";
pub(super) const FAILURE: &str = "web-service-failure.txt";

#[derive(Deserialize, Serialize)]
pub(super) struct WebAccess {
    pub address: String,
    #[serde(rename = "loginUrl")]
    pub login_url: String,
}

#[derive(Deserialize, Serialize)]
pub(super) struct ReadyOwner {
    pid: u32,
    started_at_micros: u64,
    executable: PathBuf,
    web_pid: u32,
    // Lets a recovered startup verify that a surviving Node child is really
    // this record's Web and not a recycled PID. Records published before this
    // field existed carry 0 and their orphans cannot be verified.
    #[serde(default)]
    web_started_at_micros: u64,
    pub version: String,
    pub runtime: PathBuf,
    #[serde(flatten)]
    pub access: WebAccess,
}

impl ReadyOwner {
    /// `Ok(true)` only when a live process with the recorded start time still
    /// has this record's supervisor as its parent. `Ok(false)` means the
    /// process is confirmed absent or replaced. An error means presence could
    /// not be inspected and must not be treated as an exit.
    pub fn web_running(&self) -> Result<bool, Box<dyn Error>> {
        match codexhost_platform::observe_process_identity(self.web_pid) {
            Ok(Some(identity)) => Ok(identity.parent_id == self.pid
                && (self.web_started_at_micros == 0
                    || identity.started_at_micros == self.web_started_at_micros)),
            Ok(None) => Ok(false),
            Err(error) => Err(format!(
                "Web child presence is unconfirmed for PID {}: {error}",
                self.web_pid
            )
            .into()),
        }
    }
}

fn remove_file(file: &Path) -> Result<(), Box<dyn Error>> {
    match fs::remove_file(file) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn publish_ready_record(data: &Path, record: &ReadyOwner) -> Result<(), Box<dyn Error>> {
    let _guard = lifecycle_lock(data, READY_LOCK)?;
    publish_status(&data.join(READY), &serde_json::to_string(record)?)
}

pub(super) fn owner(data: &Path) -> Result<Option<ReadyOwner>, Box<dyn Error>> {
    let bytes = match fs::read(data.join(READY)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    // A corrupt record cannot be acted on. Treat it as absent so both ensure
    // and stop reach the cleanup that discards it under the ready lock,
    // instead of failing on every retry.
    let Ok(record) = serde_json::from_slice::<ReadyOwner>(&bytes) else {
        return Ok(None);
    };
    // A supervisor that cannot be inspected is not known to have exited:
    // report the failure instead of treating it as absent, so ensure and stop
    // never race a live Web on the strength of a failed query.
    match codexhost_platform::observe_process_identity(record.pid) {
        Ok(Some(identity)) if identity.started_at_micros == record.started_at_micros => {
            Ok(Some(record))
        }
        Ok(_) => Ok(None),
        Err(error) => Err(format!(
            "Web supervisor presence is unconfirmed for PID {}: {error}",
            record.pid
        )
        .into()),
    }
}

pub(super) struct Options {
    pub node: PathBuf,
    pub host_node: PathBuf,
    pub runtime: PathBuf,
    pub host_runtime: PathBuf,
    pub data: PathBuf,
    pub ready: Option<PathBuf>,
}

impl Options {
    pub fn host_arguments(&self, action: &str) -> Vec<String> {
        vec![
            action.into(),
            "--node".into(),
            self.host_node.to_string_lossy().into_owned(),
            "--host-runtime".into(),
            self.host_runtime.to_string_lossy().into_owned(),
            "--data".into(),
            self.data.to_string_lossy().into_owned(),
        ]
    }
}

pub(super) fn ensure(
    options: &Options,
    expected_runtime: Option<&Path>,
) -> Result<(), Box<dyn Error>> {
    crate::service_update::ensure_start_allowed(&options.data)?;
    crate::host_service::run(&options.host_arguments("ensure"))?;
    let started = Instant::now();
    while let Some(record) = owner(&options.data)? {
        // A failed child query is not an exit: keep waiting within the
        // timeout instead of racing the live Web with a second supervisor.
        if record.web_running()? {
            return Ok(());
        }
        if started.elapsed() > Duration::from_secs(40) {
            return Err("Web readiness timed out".into());
        }
        thread::sleep(Duration::from_millis(25));
    }
    stop_orphaned_web_service(&options.data, expected_runtime)?;
    let launches = options.data.join("service-launches");
    fs::create_dir_all(&launches)?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let ready = launches.join(format!("web-{}-{nonce}.ready", std::process::id()));
    let mut command = Command::new(env::current_exe()?);
    clean(&mut command);
    command
        .current_dir(&options.data)
        .arg("web-service")
        .arg("serve")
        .arg("--node")
        .arg(&options.node)
        .arg("--host-node")
        .arg(&options.host_node)
        .arg("--host-runtime")
        .arg(&options.host_runtime)
        .arg("--data")
        .arg(&options.data)
        .arg("--web-runtime")
        .arg(&options.runtime)
        .arg("--ready-file")
        .arg(&ready);
    configure_detached_service_command(&mut command)?;
    let mut supervisor = command.spawn()?;
    let started = Instant::now();
    let result = loop {
        if let Some(result) = readiness(&ready) {
            if result.is_err() {
                supervisor.wait()?;
            }
            break result;
        }
        if let Some(status) = supervisor.try_wait()? {
            break readiness(&ready).unwrap_or_else(|| {
                Err(format!("Web supervisor exited before readiness: {status}").into())
            });
        }
        if started.elapsed() > Duration::from_secs(40) {
            break Err("Web readiness timed out; startup outcome is unknown".into());
        }
        thread::sleep(Duration::from_millis(25));
    };
    remove_file(&ready)?;
    result
}

fn serve(options: &Options) -> Result<(), Box<dyn Error>> {
    let ready = options
        .ready
        .as_ref()
        .ok_or("Internal Web startup requires --ready-file")?;
    let _independent = codexhost_platform::register_independent_service()?;
    let supervisor = codexhost_platform::process_snapshot(std::process::id())?;
    let node_ready = options.data.join("web-service-node-ready.json");
    let stop = options.data.join(STOP);
    remove_file(&stop)?;
    remove_file(&options.data.join(FAILURE))?;
    let mut delay = Duration::from_secs(1);
    let mut announced = false;
    let outcome = (|| -> Result<(), Box<dyn Error>> {
        loop {
            remove_file(&node_ready)?;
            let mut command = Command::new(&options.node);
            clean(&mut command);
            command
                .current_dir(&options.data)
                .arg("--disable-warning=UNDICI-EHPA")
                .arg(node_entrypoint_path(&options.runtime))
                .arg("--background")
                .arg("--ready-file")
                .arg(&node_ready)
                .arg("--ch-data")
                .arg(&options.data)
                .arg("--ch-node")
                .arg(&options.host_node)
                .arg("--ch-host-runtime")
                .arg(&options.host_runtime)
                .arg("--ch-plugins")
                .arg(
                    options
                        .host_runtime
                        .parent()
                        .ok_or("Host Runtime has no parent")?
                        .join("plugins"),
                )
                .arg("--ch-launcher")
                .arg(env::current_exe()?)
                .env("CODEXHOST_DATA_DIR", &options.data)
                .envs(codexhost_platform::proxy_environment())
                .stderr(Stdio::piped());
            configure_background_command(&mut command);
            let mut child = spawn_supervised(&mut command)?;
            let mut stderr = child.take_stderr().expect("piped Web stderr");
            let diagnostics = thread::spawn(move || {
                let mut tail = Vec::new();
                let mut buffer = [0; 8192];
                loop {
                    let count = stderr.read(&mut buffer)?;
                    if count == 0 {
                        break;
                    }
                    tail.extend_from_slice(&buffer[..count]);
                    if tail.len() > 8192 {
                        tail.drain(..tail.len() - 8192);
                    }
                }
                Ok::<_, std::io::Error>(String::from_utf8_lossy(&tail).into_owned())
            });
            let started = Instant::now();
            let mut published = false;
            loop {
                if stop.exists() {
                    break;
                }
                if !published && node_ready.exists() {
                    let access: WebAccess = serde_json::from_slice(&fs::read(&node_ready)?)?;
                    publish_ready_record(
                        &options.data,
                        &ReadyOwner {
                            pid: supervisor.id,
                            started_at_micros: supervisor.started_at_micros,
                            executable: supervisor.executable.clone(),
                            web_pid: child.id(),
                            web_started_at_micros: codexhost_platform::process_identity(child.id())
                                .map(|process| process.started_at_micros)
                                .unwrap_or(0),
                            version: env!("CARGO_PKG_VERSION").into(),
                            runtime: options.runtime.clone(),
                            access,
                        },
                    )?;
                    if !announced {
                        publish_status(ready, "ready\n")?;
                        announced = true;
                    }
                    published = true;
                }
                if child.try_wait()?.is_some() {
                    break;
                }
                child.has_live_processes()?;
                thread::sleep(Duration::from_millis(100));
            }
            if child.has_live_processes()? {
                child.terminate()?;
            }
            let status = match child.wait_for_tree_exit(Duration::from_secs(2)) {
                Ok(status) => status,
                Err(_) => {
                    child.force_terminate()?;
                    child.wait_for_tree_exit(Duration::from_secs(5))?
                }
            };
            let diagnostic = diagnostics.join().expect("Web stderr reader")?;
            remove_file(&node_ready)?;
            if stop.exists() {
                break;
            }
            if status.code() == Some(SETTINGS_CHANGED_EXIT_CODE) {
                continue;
            }
            let failure = if diagnostic.is_empty() {
                format!("Web exited: {status}")
            } else {
                diagnostic
            };
            publish_status(&options.data.join(FAILURE), &failure)?;
            if !published {
                if !announced {
                    publish_status(ready, &failure)?;
                }
                break;
            }
            if started.elapsed() >= Duration::from_secs(60) {
                delay = Duration::from_secs(1);
            }
            let until = Instant::now() + delay;
            while Instant::now() < until && !stop.exists() {
                thread::sleep(Duration::from_millis(100));
            }
            if stop.exists() {
                break;
            }
            delay = (delay * 2).min(Duration::from_secs(30));
        }
        Ok(())
    })();
    if let Err(error) = &outcome {
        publish_status(&options.data.join(FAILURE), &error.to_string())?;
        if !announced {
            publish_status(ready, &error.to_string())?;
        }
    }
    remove_ready_record_if_owned(&options.data, &supervisor)?;
    remove_file(&node_ready)?;
    remove_file(&stop)?;
    outcome
}

// A Web supervisor that failed before publishing, or whose record a newer
// service replaced, must not erase the identity of a live Web service. PID
// reuse is excluded by the started_at_micros comparison.
fn remove_ready_record_if_owned(
    data: &Path,
    supervisor: &codexhost_platform::ProcessSnapshot,
) -> Result<(), Box<dyn Error>> {
    let _guard = lifecycle_lock(data, READY_LOCK)?;
    let file = data.join(READY);
    let bytes = match fs::read(&file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if serde_json::from_slice::<ReadyOwner>(&bytes).is_ok_and(|record| {
        record.pid == supervisor.id && record.started_at_micros == supervisor.started_at_micros
    }) {
        remove_file(&file)?;
    }
    Ok(())
}

// A supervisor can exit (crash, forced restart of CodeHost) while its Node
// Web child keeps running and holds the fixed port. The ready record then
// names a dead supervisor, so `owner` reports no service and the next
// startup would launch a new Web that cannot bind the port. When the record
// identifies a still-live Web child of this installation, stop it first;
// otherwise the stale record is dropped and the port conflict is reported
// against whatever actually listens. The ready lock spans read, judgment,
// and deletion: a supervisor that publishes a new record while this cleanup
// waits must not lose it, and the record is kept until the orphan's exit is
// confirmed so stop and ensure retries can still act on it. Callers that
// act on behalf of an update pass `expected_runtime`; records belonging to
// another installation sharing this data directory are left to their own
// installation.
fn stop_orphaned_web_service(
    data: &Path,
    expected_runtime: Option<&Path>,
) -> Result<bool, Box<dyn Error>> {
    let _guard = lifecycle_lock(data, READY_LOCK)?;
    let file = data.join(READY);
    let bytes = match fs::read(&file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let record: ReadyOwner = match serde_json::from_slice(&bytes) {
        Ok(record) => record,
        Err(_) => {
            // A corrupt record cannot be acted on; drop it so the next
            // startup can publish a fresh one.
            remove_file(&file)?;
            return Ok(false);
        }
    };
    // A supervisor that could not be inspected is not known to have exited;
    // report the failure so the record stays available for retries.
    match codexhost_platform::observe_process_identity(record.pid) {
        Ok(Some(identity)) if identity.started_at_micros == record.started_at_micros => {
            return Ok(false);
        }
        // Absent or replaced: the record names a supervisor that is gone.
        Ok(_) => {}
        Err(error) => return Err(format!(
            "Web supervisor presence is unconfirmed for PID {}; the stale record is kept: {error}",
            record.pid
        )
        .into()),
    }
    // Callers that act on behalf of an update must only release a Web whose
    // recorded runtime is verifiably this installation's. When either side
    // cannot be canonicalized (for example both runtime directories were
    // deleted), ownership cannot be proven and the record is kept with an
    // explicit error instead of silently matching another installation.
    if let Some(expected) = expected_runtime {
        let recorded = record.runtime.canonicalize().map_err(|error| {
            format!(
                "cannot canonicalize the recorded Web runtime {}: {error}",
                record.runtime.display()
            )
        })?;
        let expected = expected.canonicalize().map_err(|error| {
            format!(
                "cannot canonicalize the expected Web runtime {}: {error}",
                expected.display()
            )
        })?;
        if recorded != expected {
            // Another installation sharing this data directory owns this
            // orphan; leave the record for that installation.
            return Ok(false);
        }
    }
    if record.web_started_at_micros == 0 {
        remove_file(&file)?;
        return Ok(false);
    }
    let identity = match codexhost_platform::observe_process_identity(record.web_pid) {
        Ok(Some(identity)) => identity,
        Ok(None) => {
            // The child is confirmed gone; the record is no longer retryable.
            remove_file(&file)?;
            return Ok(false);
        }
        Err(error) => return Err(format!(
            "Web child presence is unconfirmed for PID {}; the record is kept for retry: {error}",
            record.web_pid
        )
        .into()),
    };
    if identity.started_at_micros != record.web_started_at_micros {
        remove_file(&file)?;
        return Ok(false);
    }
    // Terminate only the verified Node instance. Unix signal delivery here is
    // scoped to this single identity (SIGTERM, then SIGKILL); it does not
    // claim an atomic cross-platform reclaim of the whole process tree.
    codexhost_platform::terminate_process_identity(&identity, false)?;
    let started = Instant::now();
    let mut forced = false;
    loop {
        match codexhost_platform::observe_process_identity(record.web_pid) {
            Ok(None) => break,
            Ok(Some(current)) if current.started_at_micros != record.web_started_at_micros => {
                break;
            }
            // A failed query is not an exit; keep waiting within the bound.
            Ok(Some(_)) => {}
            Err(_) => {}
        }
        if !forced && started.elapsed() > Duration::from_secs(5) {
            codexhost_platform::terminate_process_identity(&identity, true)?;
            forced = true;
        }
        if started.elapsed() > Duration::from_secs(10) {
            // Keep the record: a retry of stop or ensure must still be able
            // to terminate the Web that holds the port.
            return Err("The orphaned Web process did not exit".into());
        }
        thread::sleep(Duration::from_millis(25));
    }
    remove_file(&file)?;
    Ok(true)
}

// Slow runners (macOS) can take far longer than a local machine to notice
// the stop file and exit; a generous upper bound only widens the window —
// shutdown completion is still observed, never assumed.
pub(super) const STOP_WAIT: Duration = Duration::from_secs(60);

pub(super) fn stop(
    options: &Options,
    expected_runtime: Option<&Path>,
) -> Result<bool, Box<dyn Error>> {
    let Some(record) = owner(&options.data)? else {
        return stop_orphaned_web_service(&options.data, expected_runtime);
    };
    publish_status(&options.data.join(STOP), "stop\n")?;
    let started = Instant::now();
    loop {
        match codexhost_platform::observe_process_identity(record.pid) {
            Ok(Some(identity)) if identity.started_at_micros == record.started_at_micros => {}
            // Absent or replaced: the supervisor is confirmed gone.
            Ok(_) => break,
            // A failed query is not an exit; keep retrying within the bound
            // instead of reporting a shutdown that could not be confirmed.
            Err(_) => {}
        }
        if started.elapsed() > STOP_WAIT {
            return Err("Web shutdown timed out".into());
        }
        thread::sleep(Duration::from_millis(25));
    }
    // The supervisor may have died abnormally instead of exiting cleanly
    // after the stop request; re-check under the ready lock for a Web child
    // it left behind holding the port.
    stop_orphaned_web_service(&options.data, expected_runtime)?;
    Ok(true)
}

pub fn run(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    let action = arguments.first().map(String::as_str).unwrap_or("");
    let arguments = arguments.get(1..).unwrap_or_default();
    let mut node = None;
    let mut host_node = None;
    let mut runtime = None;
    let mut host_runtime = None;
    let mut data = None;
    let mut ready = None;
    for pair in arguments.chunks(2) {
        if pair.len() != 2 {
            return Err("Web service option requires a value".into());
        }
        let value = PathBuf::from(&pair[1]);
        if !value.is_absolute() {
            return Err("Web service paths must be absolute".into());
        }
        match pair[0].as_str() {
            "--node" => node = Some(value),
            "--host-node" => host_node = Some(value),
            "--web-runtime" => runtime = Some(value),
            "--host-runtime" => host_runtime = Some(value),
            "--data" => data = Some(value),
            "--ready-file" => ready = Some(value),
            _ => return Err("Unknown Web service option".into()),
        }
    }
    let options = Options {
        node: node.ok_or("--node is required")?,
        host_node: host_node.ok_or("--host-node is required")?,
        runtime: runtime.ok_or("--web-runtime is required")?,
        host_runtime: host_runtime.ok_or("--host-runtime is required")?,
        data: data.ok_or("--data is required")?,
        ready,
    };
    let _guard = match action {
        "ensure" | "stop" => Some(lifecycle_lock(&options.data, "web-service-lifecycle.lock")?),
        _ => None,
    };
    match action {
        "ensure" => ensure(&options, None),
        "serve" => serve(&options),
        "stop" => stop(&options, None).map(|_| ()),
        _ => Err("usage: codexhost web-service <ensure|stop> --node <file> --host-node <file> --web-runtime <file> --host-runtime <file> --data <directory>".into()),
    }
}

#[cfg(test)]
#[path = "web_service_tests.rs"]
mod tests;
