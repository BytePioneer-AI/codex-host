//! Native lifecycle for the independent Host. TypeScript owns protocol and Harness semantics.
use std::env;
use std::error::Error;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use codexhost_platform::{
    configure_detached_service_command, node_entrypoint_path, spawn_supervised,
};
use fs2::FileExt;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
struct ReadyOwner {
    pid: u32,
    started_at_micros: u64,
    executable: PathBuf,
    #[serde(default)]
    runtime: PathBuf,
}
fn owner_snapshot(data: &Path) -> Option<codexhost_platform::ProcessSnapshot> {
    let record = fs::read(data.join("shared-host-ready.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ReadyOwner>(&bytes).ok())?;
    let live = codexhost_platform::process_snapshot(record.pid).ok()?;
    (live.started_at_micros == record.started_at_micros && live.executable == record.executable)
        .then_some(live)
}
fn owner_ready(data: &Path) -> bool {
    owner_snapshot(data).is_some()
}
fn publish_ready(data: &Path, pid: u32, runtime: &Path) -> Result<(), Box<dyn Error>> {
    let live = codexhost_platform::process_snapshot(pid)?;
    let bytes = serde_json::to_vec(&ReadyOwner {
        pid,
        started_at_micros: live.started_at_micros,
        executable: live.executable,
        runtime: runtime.to_owned(),
    })?;
    let temporary = data.join(format!("shared-host-ready-{}.tmp", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    codexhost_platform::atomic_replace_file(&temporary, &data.join("shared-host-ready.json"))?;
    Ok(())
}

struct Options {
    node: PathBuf,
    runtime: PathBuf,
    data: PathBuf,
    ready: Option<PathBuf>,
    extras: Vec<String>,
}

fn options(arguments: &[String]) -> Result<Options, Box<dyn Error>> {
    let mut node = None;
    let mut runtime = None;
    let mut data = None;
    let mut ready = None;
    let mut extras = Vec::new();
    for pair in arguments.chunks(2) {
        if pair.len() != 2 {
            return Err("Host option requires a value".into());
        }
        let value = PathBuf::from(&pair[1]);
        if !value.is_absolute() {
            return Err("Host paths must be absolute".into());
        }
        match pair[0].as_str() {
            "--node" => node = Some(value),
            "--host-runtime" => runtime = Some(value),
            "--data" => data = Some(value),
            "--ready-file" => ready = Some(value),
            "--plugins" | "--codex-home" | "--stock-codex" => extras.extend_from_slice(pair),
            _ => return Err("Unknown Host option".into()),
        }
    }
    let options = Options {
        node: node.ok_or("--node is required")?,
        runtime: runtime.ok_or("--host-runtime is required")?,
        data: data.ok_or("--data is required")?,
        ready,
        extras,
    };
    if !options.node.is_file() || !options.runtime.is_file() {
        return Err("Host runtime or Node executable is missing".into());
    }
    Ok(options)
}

fn clean(command: &mut Command) {
    for (key, _) in env::vars_os() {
        let upper = key.to_string_lossy().to_ascii_uppercase();
        if upper.starts_with("CODEXHOST_") || upper == "NODE_OPTIONS" || upper == "NODE_PATH" {
            command.env_remove(key);
        }
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
}

// Readers must never see the empty/truncated intermediate file of fs::write.
fn publish_status(file: &Path, message: &str) -> Result<(), Box<dyn Error>> {
    let temporary = file.with_extension(format!("{}.tmp", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> Result<(), Box<dyn Error>> {
        let mut handle = options.open(&temporary)?;
        handle.write_all(message.as_bytes())?;
        handle.sync_all()?;
        drop(handle);
        codexhost_platform::atomic_replace_file(&temporary, file)?;
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result
}

fn readiness(file: &Path) -> Option<Result<(), Box<dyn Error>>> {
    fs::read_to_string(file).ok().map(|status| {
        if status == "ready\n" {
            Ok(())
        } else {
            Err(status.into())
        }
    })
}

fn ensure(arguments: &[String], options: Options) -> Result<(), Box<dyn Error>> {
    if owner_ready(&options.data) {
        return Ok(());
    }
    let launches = options.data.join("service-launches");
    fs::create_dir_all(&launches)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&launches, fs::Permissions::from_mode(0o700))?;
    }
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let ready = launches.join(format!("{}-{nonce}.ready", std::process::id()));
    let mut command = Command::new(env::current_exe()?);
    command
        .current_dir(&options.data)
        .arg("host")
        .arg("serve")
        .args(arguments)
        .arg("--ready-file")
        .arg(&ready);
    clean(&mut command);
    configure_detached_service_command(&mut command)?;
    let mut supervisor = command.spawn()?;
    let started = Instant::now();
    let result = loop {
        if let Some(result) = readiness(&ready) {
            break result;
        }
        if let Some(status) = supervisor.try_wait()? {
            break readiness(&ready).unwrap_or_else(|| {
                Err(format!("Shared Host supervisor exited before readiness: {status}").into())
            });
        }
        if started.elapsed() > Duration::from_secs(40) {
            // A timeout must not terminate a background service that may own running work.
            break Err("Shared Host readiness timed out; startup outcome is unknown".into());
        }
        thread::sleep(Duration::from_millis(25));
    };
    let _ = fs::remove_file(ready);
    result
}

fn serve(mut options: Options) -> Result<(), Box<dyn Error>> {
    let ready = options
        .ready
        .as_ref()
        .ok_or("Internal Host startup requires --ready-file")?;
    fs::create_dir_all(&options.data)?;
    if owner_ready(&options.data) {
        return publish_status(ready, "ready\n");
    }
    if !options.extras.iter().any(|value| value == "--stock-codex")
        && let Ok(installation) = codexhost_platform::discover_codex_desktop()
    {
        options.extras.push("--stock-codex".into());
        options.extras.push(
            installation
                .executable_codex_cli
                .to_string_lossy()
                .into_owned(),
        );
    }
    let _independent = codexhost_platform::register_independent_service()?;
    let node_ready = ready.with_extension("node");
    let mut command = Command::new(&options.node);
    clean(&mut command);
    command
        .current_dir(&options.data)
        .arg("--disable-warning=UNDICI-EHPA")
        .arg(node_entrypoint_path(&options.runtime))
        .arg("--codexhost-shared-host")
        .arg("--data")
        .arg(&options.data)
        .arg("--ready-file")
        .arg(&node_ready)
        .args(options.extras)
        .env("CODEXHOST_DATA_DIR", &options.data)
        .env("CODEXHOST_HOST_RUNTIME_PATH", &options.runtime)
        .env("CODEXHOST_CLI_NODE_PATH", &options.node)
        .env("CODEXHOST_HOST_NODE_PATH", &options.node)
        .env("CODEXHOST_LAUNCHER_EXECUTABLE", env::current_exe()?)
        // Host-side fetch (for example voice transcription) follows the system proxy.
        .envs(codexhost_platform::proxy_environment());
    let mut child = spawn_supervised(&mut command)?;
    let result = (|| -> Result<(), Box<dyn Error>> {
        let mut published = false;
        while child.try_wait()?.is_none() {
            if !published && let Some(result) = readiness(&node_ready) {
                match result {
                    Ok(()) => {
                        publish_ready(&options.data, child.id(), &options.runtime)?;
                        publish_status(ready, "ready\n")?;
                    }
                    Err(error) => {
                        publish_status(ready, &error.to_string())?;
                    }
                }
                published = true;
                let _ = fs::remove_file(&node_ready);
            }
            // Retain exact descendant identities before a root crash reparents them.
            child.has_live_processes()?;
            thread::sleep(Duration::from_millis(100));
        }
        if !published && let Ok(message) = fs::read_to_string(&node_ready) {
            publish_status(ready, &message)?;
        }
        Ok(())
    })();
    let _ = fs::remove_file(&node_ready);
    let _ = child.terminate();
    // Finish normal process-tree cleanup before the supervisor exits.
    while child.wait_for_tree_exit(Duration::from_secs(2)).is_err() {
        let _ = child.force_terminate();
        thread::sleep(Duration::from_millis(100));
    }
    let _ = fs::remove_file(options.data.join("shared-host-ready.json"));
    result
}

// The supervisor exits after cleaning its managed children. This wait is only
// for normal shutdown; it is not a startup lock or a crash-recovery proof.
fn wait_for_shutdown(
    owner: Option<&codexhost_platform::ProcessSnapshot>,
    supervisor: Option<&codexhost_platform::ProcessSnapshot>,
    timeout: Duration,
) -> Result<(), Box<dyn Error>> {
    let Some(target) = supervisor.or(owner) else {
        return Ok(());
    };
    let started = Instant::now();
    let mut escalated = false;
    loop {
        let live = codexhost_platform::process_snapshot(target.id).ok();
        if !live.is_some_and(|live| {
            live.started_at_micros == target.started_at_micros
                && live.executable == target.executable
        }) {
            return Ok(());
        }
        if started.elapsed() >= timeout {
            return Err("Shared Host shutdown timed out".into());
        }
        // A stalled Node may retain native children. Let its supervisor finish
        // cleanup after terminating the owner captured before the stop request.
        if !escalated && started.elapsed() >= Duration::from_secs(2) {
            if let Some(owner) = owner {
                codexhost_platform::terminate_process_instance(owner, true)?;
            }
            escalated = true;
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn stop(options: &Options) -> Result<(), Box<dyn Error>> {
    let owner = owner_snapshot(&options.data);
    let supervisor = owner
        .as_ref()
        .filter(|owner| owner.parent_id > 1)
        .and_then(|owner| codexhost_platform::process_snapshot(owner.parent_id).ok());
    let mut command = Command::new(&options.node);
    clean(&mut command);
    let status = command
        .arg(node_entrypoint_path(&options.runtime))
        .arg("--codexhost-shared-host")
        .arg("--data")
        .arg(&options.data)
        .arg("--stop")
        .stderr(Stdio::inherit())
        .status()?;
    if status.success() {
        wait_for_shutdown(owner.as_ref(), supervisor.as_ref(), Duration::from_secs(10))
    } else {
        Err("Shared Host shutdown was not confirmed".into())
    }
}

// Keep the file in place: unlinking a locked file would let another caller lock a
// different inode. The OS releases the lock when the maintenance process exits.
fn lifecycle_lock(data: &Path) -> Result<fs::File, Box<dyn Error>> {
    fs::create_dir_all(data)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(data.join("shared-host-lifecycle.lock"))?;
    let started = Instant::now();
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(file),
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.raw_os_error() == Some(33) =>
            {
                if started.elapsed() > Duration::from_secs(40) {
                    return Err("Shared Host lifecycle is busy; no action was taken".into());
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => return Err(error.into()),
        }
    }
}

pub fn run(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    let action = arguments.first().map(String::as_str).unwrap_or("");
    if arguments.is_empty() {
        return Err(
            "usage: codexhost host <ensure|restart|stop> --node <file> --host-runtime <file> --data <directory>"
                .into(),
        );
    }
    let options = options(&arguments[1..])?;
    // The detached supervisor must not inherit or reacquire the caller's lock:
    // ensure/restart retain it until that supervisor has published readiness.
    let _guard = match action {
        "ensure" | "stop" | "restart" => Some(lifecycle_lock(&options.data)?),
        _ => None,
    };
    match action {
        "ensure" => ensure(&arguments[1..], options),
        "serve" => serve(options),
        "stop" => stop(&options),
        "restart" => {
            stop(&options)?;
            let data = options.data.clone();
            let runtime = options.runtime.clone();
            ensure(&arguments[1..], options)?;
            let owner: ReadyOwner = serde_json::from_slice(&fs::read(data.join("shared-host-ready.json"))?)?;
            if owner.runtime != runtime || !owner_ready(&data) {
                return Err("Shared Host restart did not activate the requested runtime".into());
            }
            Ok(())
        }
        _ => Err(
            "usage: codexhost host <ensure|restart|stop> --node <file> --host-runtime <file> --data <directory>"
                .into(),
        ),
    }
}

#[cfg(test)]
#[path = "host_service_tests.rs"]
mod tests;
