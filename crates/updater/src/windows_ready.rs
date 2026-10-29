use crate::RuntimeDescriptorProbe;
use codexhost_platform::{ProcessSnapshot, process_snapshot};
use serde::Deserialize;
use std::error::Error;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartupFile {
    schema_version: u8,
    records: Vec<Startup>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Startup {
    #[cfg(target_os = "windows")]
    #[serde(default)]
    launch_job: Option<String>,
    #[serde(default)]
    parent: Option<ProcessEvidence>,
    #[serde(default)]
    started_at_micros: Option<String>,
    #[serde(default)]
    error: Option<String>,
    pid: u32,
    launcher_version: String,
    started_at_ms: u64,
    finished_at_ms: Option<u64>,
    outcome: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessEvidence {
    pid: u32,
    started_at_micros: String,
    executable: PathBuf,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Host {
    schema_version: u8,
    pid: u32,
    launcher_pid: Option<u32>,
    port: u16,
    token: String,
    started_at: u64,
}

pub(crate) struct StartupCheck {
    #[cfg(target_os = "windows")]
    job: Option<codexhost_platform::WindowsLaunchJob>,
    version: String,
    launcher: PathBuf,
    node: PathBuf,
    host_entry: PathBuf,
    descriptor: PathBuf,
    data: PathBuf,
    started_at: u64,
    previous_nonce: Option<String>,
    npm_parent: bool,
    spawned: Option<ProcessSnapshot>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}
fn regular(path: &Path, limit: u64) -> Result<Option<Vec<u8>>, Box<dyn Error>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("startup evidence is not a regular file".into());
    }
    let mut bytes = Vec::new();
    File::open(path)?.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err("startup evidence exceeds its size limit".into());
    }
    Ok(Some(bytes))
}
fn birth_ms(process: &ProcessSnapshot) -> u64 {
    #[cfg(target_os = "windows")]
    {
        process
            .started_at_micros
            .saturating_sub(11_644_473_600_000_000)
            / 1000
    }
    #[cfg(not(target_os = "windows"))]
    {
        process.started_at_micros / 1000
    }
}
fn same_instance(left: &ProcessSnapshot, right: &ProcessSnapshot) -> bool {
    left.id == right.id
        && left.started_at_micros == right.started_at_micros
        && crate::windows_installation::same_path(&left.executable, &right.executable)
}
fn connect(port: u16) -> std::io::Result<TcpStream> {
    let stream = TcpStream::connect_timeout(
        &SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        Duration::from_millis(400),
    )?;
    stream.set_read_timeout(Some(Duration::from_millis(400)))?;
    stream.set_write_timeout(Some(Duration::from_millis(400)))?;
    Ok(stream)
}
fn controller_ready(port: u16, nonce: &str) -> Result<bool, Box<dyn Error>> {
    let mut stream = connect(port)?;
    writeln!(stream, "PING {nonce}")?;
    let mut bytes = [0; 6];
    stream.read_exact(&mut bytes)?;
    Ok(&bytes == b"ready\n")
}
fn host_request(
    host: &Host,
    route: &str,
    body: Option<&str>,
) -> Result<serde_json::Value, Box<dyn Error>> {
    let mut stream = connect(host.port)?;
    let body = body.unwrap_or("");
    let method = if body.is_empty() { "GET" } else { "POST" };
    write!(
        stream,
        "{method} {route} HTTP/1.0\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        host.port,
        host.token,
        body.len()
    )?;
    let started = Instant::now();
    let mut bytes = Vec::new();
    let mut buffer = [0; 1024];
    loop {
        if started.elapsed() > Duration::from_secs(2) || bytes.len() > 16 * 1024 {
            return Err("Host readiness response exceeded its bounds".into());
        }
        let count = stream.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
    if !(bytes.starts_with(b"HTTP/1.0 200 ") || bytes.starts_with(b"HTTP/1.1 200 ")) {
        return Err("Host readiness was rejected".into());
    }
    let boundary = bytes
        .windows(4)
        .position(|value| value == b"\r\n\r\n")
        .ok_or("Host response has no body")?;
    Ok(serde_json::from_slice(&bytes[boundary + 4..])?)
}
impl StartupCheck {
    #[cfg(target_os = "windows")]
    pub(crate) fn capture(request: &crate::request::UpdateRequest) -> Result<Self, Box<dyn Error>> {
        use crate::request::Installation;
        let (root, node, distribution) = match &request.installation {
            Installation::Npm(npm) => (
                npm.prefix
                    .as_ref()
                    .ok_or("npm startup has no prefix")?
                    .join(format!(
                        "node_modules/@codexhost/cli-win32-{}",
                        crate::windows_installation::architecture()
                    )),
                npm.node_path.clone(),
                "npm",
            ),
            Installation::WindowsInstaller(windows) => (
                windows.install_root.clone(),
                windows.install_root.join("runtime/node.exe"),
                "installer",
            ),
            _ => return Err("Windows startup check requires a Windows installation".into()),
        };
        crate::windows_installation::metadata(
            &root,
            &request.version,
            distribution,
            crate::windows_installation::architecture(),
        )?;
        let launcher = root.join("bin/codexhost.exe");
        let host_entry = root.join("app/host-runtime.mjs");
        for path in [&launcher, &host_entry] {
            crate::windows_installation::owned_file(&root, path)?;
        }
        let data = std::env::var_os("CODEXHOST_DATA_DIR")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join(".codexhost"))
            })
            .ok_or("startup data directory is unavailable")?;
        let data = if data.is_absolute() {
            data
        } else {
            std::env::current_dir()?.join(data)
        };
        let previous_nonce = regular(&request.runtime_descriptor_path, 4096)?
            .and_then(|bytes| serde_json::from_slice::<RuntimeDescriptorProbe>(&bytes).ok())
            .map(|value| value.nonce);
        Ok(Self {
            job: Some(codexhost_platform::WindowsLaunchJob::create_unique()?),
            version: request.version.clone(),
            launcher: launcher.canonicalize()?,
            node: node.canonicalize()?,
            host_entry: host_entry.canonicalize()?,
            descriptor: request.runtime_descriptor_path.clone(),
            data,
            started_at: now(),
            previous_nonce,
            npm_parent: distribution == "npm",
            spawned: None,
        })
    }
    #[cfg(target_os = "windows")]
    pub(crate) fn job_key(&self) -> Result<&str, Box<dyn Error>> {
        Ok(self
            .job
            .as_ref()
            .ok_or("startup has no caller-held Job")?
            .key())
    }
    #[cfg(target_os = "windows")]
    pub(crate) fn bind(&mut self, child: &std::process::Child) -> Result<(), Box<dyn Error>> {
        let process = process_snapshot(child.id())?;
        let expected = if self.npm_parent {
            &self.node
        } else {
            &self.launcher
        };
        if !crate::windows_installation::same_path(&process.executable.canonicalize()?, expected) {
            return Err("relaunch child does not match the target execution path".into());
        }
        self.spawned = Some(process);
        Ok(())
    }
    fn launcher_instance(
        &self,
    ) -> Result<Option<(RuntimeDescriptorProbe, ProcessSnapshot)>, Box<dyn Error>> {
        let Some(bytes) = regular(&self.descriptor, 4096)? else {
            return Ok(None);
        };
        let descriptor: RuntimeDescriptorProbe = serde_json::from_slice(&bytes)?;
        if descriptor.schema_version != 1
            || descriptor.launcher_pid == 0
            || descriptor.control_port == 0
            || descriptor.nonce.len() != 32
            || !descriptor
                .nonce
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || self.previous_nonce.as_deref() == Some(&descriptor.nonce)
        {
            return Ok(None);
        }
        let process = process_snapshot(descriptor.launcher_pid)?;
        let Some(spawned) = &self.spawned else {
            return Err("relaunch process identity is not bound".into());
        };
        if self.npm_parent {
            if process.parent_id != spawned.id
                || !same_instance(spawned, &process_snapshot(spawned.id)?)
            {
                return Ok(None);
            }
        } else if !same_instance(spawned, &process) {
            return Ok(None);
        }
        if birth_ms(&process) < self.started_at
            || !crate::windows_installation::same_path(
                &process.executable.canonicalize()?,
                &self.launcher,
            )
        {
            return Ok(None);
        }
        Ok(Some((descriptor, process)))
    }
    fn launcher_ready(
        &self,
    ) -> Result<Option<(RuntimeDescriptorProbe, ProcessSnapshot)>, Box<dyn Error>> {
        let Some((descriptor, process)) = self.launcher_instance()? else {
            return Ok(None);
        };
        let Some(bytes) = regular(
            &self.data.join("diagnostics/launcher-startup-v1.json"),
            256 * 1024,
        )?
        else {
            return Ok(None);
        };
        let records: StartupFile = serde_json::from_slice(&bytes)?;
        if records.schema_version != 1
            || records.records.len() > 10
            || !records.records.iter().any(|record| {
                record.pid == process.id
                    && record.launcher_version == self.version
                    && record.outcome == "ready"
                    && record.started_at_ms >= self.started_at
                    && record
                        .finished_at_ms
                        .is_some_and(|end| end >= record.started_at_ms && end <= now())
            })
        {
            return Ok(None);
        }
        if !controller_ready(descriptor.control_port, &descriptor.nonce)? {
            return Ok(None);
        }
        Ok(Some((descriptor, process)))
    }
    fn host_ready(&self, launcher: u32) -> Result<Option<ProcessSnapshot>, Box<dyn Error>> {
        if !self.host_entry.is_file() {
            return Err("target Host entry disappeared".into());
        }
        let directory = self.data.join("console/hosts");
        #[cfg(target_os = "windows")]
        let observed = codexhost_platform::process_arguments_for_executable(&self.node)?;
        #[cfg(target_os = "windows")]
        let paths = observed
            .iter()
            .filter(|observed| {
                crate::npm_processes::script_belongs(
                    &observed.arguments,
                    std::slice::from_ref(&self.host_entry),
                )
            })
            .map(|observed| directory.join(format!("host-{}.json", observed.id)))
            .collect::<Vec<_>>();
        #[cfg(not(target_os = "windows"))]
        let paths = match fs::read_dir(directory) {
            Ok(names) => names
                .take(128)
                .map(|name| name.map(|name| name.path()))
                .collect::<Result<Vec<_>, _>>()?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        for path in paths {
            if !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("host-") && name.ends_with(".json"))
            {
                continue;
            }
            let Ok(Some(bytes)) = regular(&path, 4096) else {
                continue;
            };
            let Ok(host) = serde_json::from_slice::<Host>(&bytes) else {
                continue;
            };
            if host.schema_version != 1
                || host.pid == 0
                || host.pid == launcher
                || host.launcher_pid != Some(launcher)
                || host.port == 0
                || host.started_at < self.started_at
                || host.token.len() != 64
                || !host
                    .token
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            {
                continue;
            }
            let Ok(process) = process_snapshot(host.pid) else {
                continue;
            };
            if birth_ms(&process) < self.started_at
                || !crate::windows_installation::same_path(
                    &process.executable.canonicalize()?,
                    &self.node,
                )
            {
                continue;
            }
            #[cfg(target_os = "windows")]
            if !observed.iter().any(|observed| {
                observed.id == process.id
                    && observed.started_at_micros == process.started_at_micros
                    && crate::npm_processes::script_belongs(
                        &observed.arguments,
                        std::slice::from_ref(&self.host_entry),
                    )
            }) {
                continue;
            }
            #[cfg(target_os = "windows")]
            if let Some(job) = &self.job
                && !job.contains_pid(process.id)?
            {
                continue;
            }
            if host_request(&host, "/ready", None)?["ready"] != true {
                continue;
            }
            let reply = host_request(
                &host,
                "/rpc",
                Some(r#"{"method":"codexhost/runtime/status","params":{}}"#),
            )?;
            let status = &reply["result"];
            if status["runningVersion"] == self.version
                && status["installedVersion"] == self.version
                && status["restartRequired"] == false
                && status["remote"] == false
            {
                return Ok(Some(process));
            }
        }
        Ok(None)
    }
    #[cfg(test)]
    pub(crate) fn wait(&self, timeout: Duration) -> Result<(), Box<dyn Error>> {
        self.wait_with_launcher(timeout, |_| Ok(()))
    }
    pub(crate) fn wait_with_launcher(
        &self,
        timeout: Duration,
        mut bind_result: impl FnMut(&ProcessSnapshot) -> Result<(), Box<dyn Error>>,
    ) -> Result<(), Box<dyn Error>> {
        let started = Instant::now();
        let mut last_error = None;
        let mut bound = None;
        while started.elapsed() < timeout {
            if let Some(error) = self.startup_failure() {
                return Err(format!("target launch failed: {error}").into());
            }
            let attempt = (|| -> Result<bool, Box<dyn Error>> {
                if let Some((_, instance)) = self.launcher_instance()? {
                    let key = (instance.id, instance.started_at_micros);
                    if bound != Some(key) {
                        bind_result(&instance)?;
                        bound = Some(key);
                    }
                }
                let Some((descriptor, launcher)) = self.launcher_ready()? else {
                    return Ok(false);
                };
                let Some(host) = self.host_ready(descriptor.launcher_pid)? else {
                    return Ok(false);
                };
                Ok(same_instance(&launcher, &process_snapshot(launcher.id)?)
                    && same_instance(&host, &process_snapshot(host.id)?))
            })();
            match attempt {
                Ok(true) => return Ok(()),
                Ok(false) => {}
                Err(error) => last_error = Some(error.to_string()),
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err(format!(
            "target installation Host/control chain did not become ready{}",
            last_error
                .map(|error| format!(": {error}"))
                .unwrap_or_default()
        )
        .into())
    }
}

#[path = "windows_startup_cleanup.rs"]
mod cleanup;

#[cfg(test)]
#[path = "windows_ready_tests.rs"]
mod tests;
