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
    pub version: String,
    pub runtime: PathBuf,
    #[serde(flatten)]
    pub access: WebAccess,
}

impl ReadyOwner {
    pub fn web_running(&self) -> bool {
        codexhost_platform::process_snapshot(self.web_pid)
            .is_ok_and(|process| process.parent_id == self.pid)
    }
}

fn remove_file(file: &Path) -> Result<(), Box<dyn Error>> {
    match fs::remove_file(file) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn owner(data: &Path) -> Result<Option<ReadyOwner>, Box<dyn Error>> {
    let bytes = match fs::read(data.join(READY)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let record: ReadyOwner = serde_json::from_slice(&bytes)?;
    Ok(codexhost_platform::process_snapshot(record.pid)
        .is_ok_and(|live| {
            live.started_at_micros == record.started_at_micros
                && live.executable == record.executable
        })
        .then_some(record))
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

pub(super) fn ensure(options: &Options) -> Result<(), Box<dyn Error>> {
    crate::service_update::ensure_start_allowed(&options.data)?;
    crate::host_service::run(&options.host_arguments("ensure"))?;
    let started = Instant::now();
    while let Some(record) = owner(&options.data)? {
        if record.web_running() {
            return Ok(());
        }
        if started.elapsed() > Duration::from_secs(40) {
            return Err("Web readiness timed out".into());
        }
        thread::sleep(Duration::from_millis(25));
    }
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
                    publish_status(
                        &options.data.join(READY),
                        &serde_json::to_string(&ReadyOwner {
                            pid: supervisor.id,
                            started_at_micros: supervisor.started_at_micros,
                            executable: supervisor.executable.clone(),
                            web_pid: child.id(),
                            version: env!("CARGO_PKG_VERSION").into(),
                            runtime: options.runtime.clone(),
                            access,
                        })?,
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
    remove_file(&options.data.join(READY))?;
    remove_file(&node_ready)?;
    remove_file(&stop)?;
    outcome
}

pub(super) fn stop(options: &Options) -> Result<bool, Box<dyn Error>> {
    let Some(record) = owner(&options.data)? else {
        return Ok(false);
    };
    publish_status(&options.data.join(STOP), "stop\n")?;
    let started = Instant::now();
    while codexhost_platform::process_snapshot(record.pid).is_ok_and(|live| {
        live.started_at_micros == record.started_at_micros && live.executable == record.executable
    }) {
        if started.elapsed() > Duration::from_secs(10) {
            return Err("Web shutdown timed out".into());
        }
        thread::sleep(Duration::from_millis(25));
    }
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
        "ensure" => ensure(&options),
        "serve" => serve(&options),
        "stop" => stop(&options).map(|_| ()),
        _ => Err("usage: codexhost web-service <ensure|stop> --node <file> --host-node <file> --web-runtime <file> --host-runtime <file> --data <directory>".into()),
    }
}
