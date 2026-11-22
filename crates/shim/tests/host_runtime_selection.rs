//! Exercise the real Shim with both Launcher configuration and npm update metadata.
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use codexhost_platform::{STOCK_CODEX_PATH_ENV, process_executable_path};

struct Fixture {
    root: PathBuf,
    node: PathBuf,
    runtime: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "codexhost-node-selection-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(root.join("npm/app")).unwrap();
        let node = PathBuf::from(env!("CARGO_BIN_EXE_fake-codex-cli"))
            .canonicalize()
            .unwrap();
        // A distinct, valid executable ensures the test detects a wrong selection,
        // rather than succeeding only because the fallback path cannot be started.
        let npm_node = root.join(format!("npm-node{}", std::env::consts::EXE_SUFFIX));
        fs::copy(&node, &npm_node).unwrap();
        fs::write(root.join("npm/app/host-runtime.mjs"), "npm runtime").unwrap();
        let runtime = root.join("selected-runtime.mjs");
        fs::write(&runtime, "Launcher-selected runtime").unwrap();
        Self {
            root,
            node,
            runtime,
        }
    }

    fn command(&self, managed: bool) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_codexhost-shim"));
        command
            .args(["app-server", "--stdio"])
            .env(STOCK_CODEX_PATH_ENV, &self.node)
            .env("CODEXHOST_DATA_DIR", self.root.join("data"))
            .env("CODEXHOST_HOST_NODE_PATH", &self.node)
            .env("CODEXHOST_HOST_RUNTIME_PATH", &self.runtime)
            .env(
                "CODEXHOST_NPM_NODE_PATH",
                self.root
                    .join(format!("npm-node{}", std::env::consts::EXE_SUFFIX)),
            )
            .env("CODEXHOST_NPM_PACKAGE_ROOT", self.root.join("npm"))
            .env_remove("CODEXHOST_REMOTE_SSH_MANAGED")
            .env_remove("CODEXHOST_LAUNCHER_EXECUTABLE")
            .env("FAKE_CODEX_HOST_RUNTIME_READY", self.root.join("ready"))
            .env("FAKE_CODEX_HOST_RUNTIME_EOF_DELAY_MS", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        if managed {
            command.env("CODEXHOST_LAUNCHER_PID", std::process::id().to_string());
        } else {
            command.env_remove("CODEXHOST_LAUNCHER_PID");
        }
        command
    }

    fn run(&self, mut command: Command) -> (Option<(PathBuf, String)>, bool, String) {
        let mut child = command.spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut observed = None;
        loop {
            if let Ok(identity) = fs::read_to_string(self.root.join("ready")) {
                let pid: u32 = identity
                    .lines()
                    .find_map(|line| line.strip_prefix("root="))
                    .unwrap()
                    .parse()
                    .unwrap();
                observed = Some((process_executable_path(pid).unwrap(), identity));
                break;
            }
            if child.try_wait().unwrap().is_some() || Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        drop(child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(5);
        while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        if child.try_wait().unwrap().is_none() {
            child.kill().unwrap();
        }
        let output = child.wait_with_output().unwrap();
        (
            observed,
            output.status.success(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    }

    fn assert_selected(&self, observed: Option<(PathBuf, String)>, stderr: &str) {
        let (executable, identity) =
            observed.unwrap_or_else(|| panic!("Host did not start: {stderr}"));
        // Windows process inspection and fs::canonicalize can spell the same path
        // differently (DOS versus verbatim paths). Compare canonical paths while
        // retaining the full executable identity, not just its filename.
        assert_eq!(
            executable.canonicalize().unwrap(),
            self.node,
            "Shim must execute the selected Node"
        );
        let runtime = identity
            .lines()
            .find_map(|line| line.strip_prefix("host_runtime_path="))
            .unwrap();
        assert_eq!(
            Path::new(runtime).canonicalize().unwrap(),
            self.runtime.canonicalize().unwrap()
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn launcher_selected_node_and_runtime_win_over_npm_metadata() {
    let f = Fixture::new();
    let (observed, _, stderr) = f.run(f.command(true));
    f.assert_selected(observed, &stderr);
}

#[test]
fn remote_runtime_selection_ignores_local_npm_metadata() {
    let f = Fixture::new();
    let mut command = f.command(false);
    command.env("CODEXHOST_REMOTE_SSH_MANAGED", "1");
    let (observed, _, stderr) = f.run(command);
    f.assert_selected(observed, &stderr);
}

#[test]
fn invalid_launcher_node_is_not_replaced_by_npm_node() {
    let f = Fixture::new();
    let mut command = f.command(true);
    command.env("CODEXHOST_HOST_NODE_PATH", f.root.join("missing-node"));
    let (observed, success, _) = f.run(command);
    assert!(
        observed.is_none(),
        "invalid explicit Node must not silently fall back"
    );
    assert!(!success);
}

#[test]
fn managed_main_server_requires_both_runtime_paths() {
    for missing in ["CODEXHOST_HOST_NODE_PATH", "CODEXHOST_HOST_RUNTIME_PATH"] {
        let f = Fixture::new();
        let mut command = f.command(true);
        command.env_remove(missing);
        let (observed, success, _) = f.run(command);
        assert!(
            observed.is_none(),
            "missing {missing} must not be recovered from npm metadata"
        );
        assert!(!success);
    }
}

#[test]
fn managed_main_server_rejects_reactivated_remote_profile() {
    let f = Fixture::new();
    let mut command = f.command(true);
    command.env("CODEXHOST_REMOTE_SSH_MANAGED", "1");
    let (observed, success, stderr) = f.run(command);
    assert!(
        observed.is_none(),
        "local launch must not execute remote bootstrap paths"
    );
    assert!(!success);
    assert!(stderr.contains("remote Host bootstrap"), "{stderr}");
}
