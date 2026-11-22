use std::fs;
use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use codexhost_platform::{process_identity, process_instance, process_snapshot};
use serde::{Deserialize, Serialize};
use url::{Host, Url};

use crate::launcher::Launcher;

const SHELL_READY: &str = "desktop-shell-ready.json";
const WEB_READY: &str = "web-service-ready.json";
const POLL_INTERVAL: Duration = Duration::from_millis(600);
const READY_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Serialize, Deserialize, PartialEq, Eq)]
struct ShellRecord {
    pid: u32,
    started_at_micros: u64,
    executable: PathBuf,
    version: String,
}

pub(crate) struct ShellReady {
    path: PathBuf,
    owner: ShellRecord,
}

impl ShellReady {
    pub fn publish(data_dir: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let process = process_snapshot(std::process::id())?;
        Self::write(
            data_dir,
            ShellRecord {
                pid: process.id,
                started_at_micros: process.started_at_micros,
                executable: process.executable,
                version: env!("CARGO_PKG_VERSION").into(),
            },
        )
    }

    fn write(data_dir: &Path, owner: ShellRecord) -> Result<Self, Box<dyn std::error::Error>> {
        fs::create_dir_all(data_dir)?;
        let path = data_dir.join(SHELL_READY);
        let mut file = tempfile::NamedTempFile::new_in(data_dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.as_file()
                .set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        serde_json::to_writer(&mut file, &owner)?;
        writeln!(file)?;
        file.as_file().sync_all()?;
        file.persist(&path)?;
        Ok(Self { path, owner })
    }

    pub fn remove_if_owned(&self) {
        if fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ShellRecord>(&bytes).ok())
            .is_some_and(|record| record == self.owner)
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}

impl Drop for ShellReady {
    fn drop(&mut self) {
        self.remove_if_owned();
    }
}

#[derive(Deserialize)]
struct WebRecord {
    pid: u32,
    started_at_micros: u64,
    web_pid: u32,
    #[serde(rename = "loginUrl")]
    login_url: String,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct WebReady {
    pid: u32,
    started_at_micros: u64,
    web_pid: u32,
    pub login_url: Url,
}

fn loopback_addresses(url: &Url) -> &'static [IpAddr] {
    const V4: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);
    const V6: IpAddr = IpAddr::V6(Ipv6Addr::LOCALHOST);
    match url.host() {
        Some(Host::Ipv4(host)) if host == Ipv4Addr::LOCALHOST => &[V4],
        Some(Host::Ipv6(host)) if host == Ipv6Addr::LOCALHOST => &[V6],
        Some(Host::Domain("localhost")) => &[V4, V6],
        _ => &[],
    }
}

fn login_url(value: &str) -> Result<Url, &'static str> {
    const INVALID: &str = "The Web service did not provide a loopback login URL. Check its listen address in diagnostics.";
    let url = Url::parse(value).map_err(|_| INVALID)?;
    let mut tokens = url.query_pairs().filter(|(name, _)| name == "token");
    if url.scheme() != "http"
        || loopback_addresses(&url).is_empty()
        || url.port() == Some(0)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.fragment().is_some()
        || !tokens.next().is_some_and(|(_, value)| !value.is_empty())
        || tokens.next().is_some()
    {
        return Err(INVALID);
    }
    Ok(url)
}

impl WebReady {
    pub(crate) fn display_url(&self) -> String {
        let mut clean = self.login_url.clone();
        clean.set_query(None);
        clean.set_fragment(None);
        clean.as_str().trim_end_matches('/').to_owned()
    }

    pub(crate) fn read_live_optional(data_dir: &Path) -> Option<Self> {
        Self::read_live(data_dir).ok()
    }

    fn parse(bytes: &[u8]) -> Result<Self, &'static str> {
        // Launcher flattens WebAccess into the supervisor's JSON record.
        let record: WebRecord = serde_json::from_slice(bytes)
            .map_err(|_| "Cannot read the Web service readiness record.")?;
        if record.pid == 0 || record.web_pid == 0 || record.started_at_micros == 0 {
            return Err("The Web service readiness record has no process identity.");
        }
        Ok(Self {
            pid: record.pid,
            started_at_micros: record.started_at_micros,
            web_pid: record.web_pid,
            login_url: login_url(&record.login_url)?,
        })
    }

    fn read_live(data_dir: &Path) -> Result<Self, &'static str> {
        let record = fs::read(data_dir.join(WEB_READY))
            .map_err(|_| "Waiting for the Web service readiness record.")?;
        let ready = Self::parse(&record)?;
        if process_instance(ready.pid, ready.started_at_micros).is_none()
            || !process_identity(ready.web_pid).is_ok_and(|child| child.parent_id == ready.pid)
        {
            return Err("The Web service has stopped.");
        }
        let port = ready.login_url.port_or_known_default().unwrap_or(80);
        if !loopback_addresses(&ready.login_url).iter().any(|&ip| {
            TcpStream::connect_timeout(&SocketAddr::new(ip, port), Duration::from_millis(200))
                .is_ok()
        }) {
            return Err("The Web service is not accepting loopback connections.");
        }
        Ok(ready)
    }
}

pub(crate) enum WebEvent {
    Connected(WebReady),
    Reconnecting,
    Error(String),
}

/// Ensure the background Web service is running and return its live loopback access info.
pub(crate) fn ensure_web_ready(launcher: &Launcher) -> Result<WebReady, String> {
    if let Ok(live) = WebReady::read_live(&launcher.data_dir) {
        return Ok(live);
    }
    launcher.run(&["web", "--background"])?;
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        match WebReady::read_live(&launcher.data_dir) {
            Ok(live) => return Ok(live),
            Err(reason) => {
                if launcher.is_stopping() {
                    return Err("CodexHost is shutting down".into());
                }
                if Instant::now() >= deadline {
                    return Err(format!("Web service readiness timed out. {reason}"));
                }
                std::thread::sleep(POLL_INTERVAL);
            }
        }
    }
}

/// Inactive until the first native-window request. After startup, the Launcher
/// supervisor owns restarts; the shell only waits for a usable new record.
pub(crate) fn watch(launcher: &Launcher, requests: Receiver<()>, report: impl Fn(WebEvent)) {
    if requests.recv().is_err() {
        return;
    }
    let mut ensure = true;
    let mut connected = None;
    let mut deadline = None;
    while !launcher.is_stopping() {
        if ensure {
            connected = None;
            deadline = match launcher.run(&["web", "--background"]) {
                Ok(()) => Some(Instant::now() + READY_TIMEOUT),
                Err(error) => {
                    report(WebEvent::Error(error));
                    None
                }
            };
        }
        let observed = WebReady::read_live(&launcher.data_dir);
        match (&connected, observed) {
            (Some(current), Ok(ref live)) if live == current => (),
            (Some(_), _) => {
                connected = None;
                deadline = Some(Instant::now() + READY_TIMEOUT);
                report(WebEvent::Reconnecting);
            }
            (None, Ok(live)) => {
                connected = Some(live.clone());
                deadline = None;
                report(WebEvent::Connected(live));
            }
            (None, Err(reason)) if deadline.is_some_and(|deadline| Instant::now() >= deadline) => {
                deadline = None;
                report(WebEvent::Error(format!(
                    "Web service readiness timed out. {reason}"
                )));
            }
            (None, Err(_)) => (),
        }
        ensure = match requests.recv_timeout(POLL_INTERVAL) {
            Ok(()) => true,
            Err(RecvTimeoutError::Timeout) => false,
            Err(RecvTimeoutError::Disconnected) => return,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_flattened_launcher_record_and_tracks_replacements() {
        let first = WebReady::parse(br#"{"pid":18,"started_at_micros":42,"web_pid":20,"address":"http://127.0.0.1:4400/","loginUrl":"http://127.0.0.1:4400/?token=fixture"}"#).unwrap();
        assert_eq!(
            (first.pid, first.started_at_micros, first.web_pid),
            (18, 42, 20)
        );
        assert_eq!(first.login_url.port(), Some(4400));
        assert_eq!(first.display_url(), "http://127.0.0.1:4400");
        let next = WebReady::parse(br#"{"pid":18,"started_at_micros":42,"web_pid":21,"loginUrl":"http://127.0.0.1:4400/?token=fixture"}"#).unwrap();
        assert!(first != next);
        assert!(WebReady::parse(br#"{"pid":18,"started_at_micros":42,"loginUrl":"http://127.0.0.1:4400/?token=fixture"}"#).is_err());
    }

    #[test]
    fn login_url_matches_direct_web_auth_contract() {
        for host in ["127.0.0.1", "[::1]", "localhost"] {
            assert!(login_url(&format!("http://{host}:4400/?token=fixture")).is_ok());
        }
        for invalid in [
            "https://localhost:4400/?token=fixture",
            "http://127.0.0.2:4400/?token=fixture",
            "http://127.0.0.1.example:4400/?token=fixture",
            "http://localhost@other.example/?token=fixture",
            "http://user:pass@localhost:4400/?token=fixture",
            "http://localhost:4400/",
            "http://localhost:4400/?token=",
            "http://localhost:4400/?token=a&token=b",
            "http://localhost:4400/redirect?token=fixture",
            "http://localhost:4400/?token=fixture#other",
        ] {
            assert!(login_url(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn publishes_private_shell_record_and_only_removes_its_owner() {
        let dir = tempfile::tempdir().unwrap();
        let first = ShellReady::publish(dir.path()).unwrap();
        let bytes = fs::read(&first.path).unwrap();
        let record: ShellRecord = serde_json::from_slice(&bytes).unwrap();
        assert!(record.executable.is_absolute());
        assert!(process_instance(record.pid, record.started_at_micros).is_some());
        assert_eq!(record.version, env!("CARGO_PKG_VERSION"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&first.path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let second = ShellReady::write(
            dir.path(),
            ShellRecord {
                started_at_micros: record.started_at_micros + 1,
                ..record
            },
        )
        .unwrap();
        drop(first);
        assert!(second.path.is_file());
        drop(second);
        assert!(!dir.path().join(SHELL_READY).exists());
    }
}
