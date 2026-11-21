use super::*;
use crate::runtime_instance::write_descriptor;
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::process::{Command, Stdio};

const TEST_ROLE: &str = "CODEXHOST_939_FIXTURE";

fn wait_until(mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !check() {
        assert!(
            Instant::now() < deadline,
            "fixture did not reach its expected state"
        );
        thread::sleep(Duration::from_millis(15));
    }
}

fn helper(name: &str, root: &Path) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args([
        "--exact",
        &format!("desktop_lifecycle::tests::{name}"),
        "--nocapture",
    ]);
    command.env(TEST_ROLE, root);
    command
}

#[test]
fn controller_fixture() {
    let Some(root) = std::env::var_os(TEST_ROLE).map(PathBuf::from) else {
        return;
    };
    let mut bootstrap = [0; 64];
    std::io::stdin().read_exact(&mut bootstrap).unwrap();
    let port = fs::read_to_string(root.join("port"))
        .unwrap()
        .parse::<u16>()
        .unwrap();
    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline && !root.join("release").exists() {
        match listener.accept() {
            Ok((mut socket, _)) => {
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                let Some(client) = line.trim_end().strip_prefix("LIFECYCLE 1 ") else {
                    continue;
                };
                let server = random_nonce().unwrap();
                let transcript = format!(
                    "{}:{}:{client}:{server}",
                    hex(&bootstrap[32..]),
                    std::process::id()
                );
                let proof = authenticator(&bootstrap[..32], "identity", &transcript)
                    .finalize()
                    .into_bytes();
                if writeln!(socket, "identity {server} {}", hex(&proof)).is_err() {
                    continue;
                }
                line.clear();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                if let Some(proof) = line.trim_end().strip_prefix("stop ").and_then(unhex::<32>)
                    && authenticator(&bootstrap[..32], "stop", &transcript)
                        .verify_slice(&proof)
                        .is_ok()
                {
                    let _ = socket.write_all(b"stopping\n");
                    return;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10))
            }
            Err(error) => panic!("fixture accept failed: {error}"),
        }
    }
}

#[test]
fn launcher_fixture() {
    let Some(root) = std::env::var_os(TEST_ROLE).map(PathBuf::from) else {
        return;
    };
    let launcher_lock =
        crate::runtime_instance::try_acquire_launcher_guard(&root.join("launcher-v1.lock"))
            .unwrap()
            .unwrap();
    let descriptor_path = root.join("desktop-runtime-v1.json");
    let lifecycle = Lifecycle::open(&descriptor_path).unwrap();
    let operation = lifecycle.lock().unwrap();
    let executable = root.join("fixture-desktop");
    fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
    let mut desktop = Command::new(executable.canonicalize().unwrap())
        .args(["--exact", "desktop_lifecycle::tests::desktop_fixture"])
        .env(TEST_ROLE, &root)
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    wait_until(|| root.join("desktop-ready").exists());
    let desk = process_snapshot(desktop.id()).unwrap();
    let port = TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    assert!(![4400, 4401].contains(&port));
    fs::write(root.join("port"), port.to_string()).unwrap();
    let descriptor =
        RuntimeDescriptor::new(std::process::id(), port, random_nonce().unwrap()).unwrap();
    let (mut command, entry) = fixture_controller(&root, &descriptor);
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let controller = process_snapshot(child.id()).unwrap();
    let (_published, bootstrap) = lifecycle
        .record_start(&descriptor, &root, &desk, &controller, &entry)
        .unwrap();
    child.stdin.take().unwrap().write_all(&bootstrap).unwrap();
    wait_until(|| port_closed(port).is_ok_and(|closed| !closed));
    write_descriptor(&descriptor_path, &descriptor).unwrap();
    if !root.join("keep-desktop").exists() {
        desktop.kill().unwrap();
        desktop.wait().unwrap();
    }
    drop(operation);
    // No destructor runs. The listener and runtime descriptor must survive the parent.
    std::mem::forget(launcher_lock);
    std::process::exit(0);
}

// Local verification can use the built release Controller in place of the Rust wire fixture.
fn fixture_controller(root: &Path, descriptor: &RuntimeDescriptor) -> (Command, PathBuf) {
    let Some(entry) = std::env::var_os("CODEXHOST_939_RELEASE_CONTROLLER").map(PathBuf::from)
    else {
        return (
            helper("controller_fixture", root),
            std::env::current_exe().unwrap(),
        );
    };
    assert!(entry.is_absolute());
    let watchdog = root.join("watchdog.mjs");
    fs::write(&watchdog, "import { existsSync } from 'node:fs';\nconst deadline = Date.now()+25000;\nsetInterval(() => { if (Date.now()>deadline || existsSync('release')) process.exit(0); }, 25).unref();\n").unwrap();
    let renderer = root.join("renderer.js");
    fs::write(&renderer, "void 0;\n").unwrap();
    let mut command = Command::new("node");
    command
        .current_dir(root)
        .arg("--import")
        .arg(watchdog)
        .arg(&entry)
        .arg("--renderer")
        .arg(renderer)
        // The fixture only connects back to its own loopback listener, never to a real Desktop.
        .args([
            "--renderer-cdp-endpoint",
            &format!("http://127.0.0.1:{}", descriptor.control_port),
            "--attachment-port",
            &descriptor.control_port.to_string(),
            "--attachment-nonce",
            &descriptor.nonce,
        ])
        .env("CODEXHOST_CONTROLLER_LIFECYCLE", "1")
        .env("CODEXHOST_DATA_DIR", root);
    (command, entry)
}

#[test]
fn desktop_fixture() {
    let Some(root) = std::env::var_os(TEST_ROLE).map(PathBuf::from) else {
        return;
    };
    fs::write(root.join("desktop-ready"), b"").unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline && !root.join("release").exists() {
        thread::sleep(Duration::from_millis(15));
    }
}

struct Fixture {
    root: PathBuf,
    descriptor: PathBuf,
    old: Owner,
}

impl Fixture {
    fn new(keep_desktop: bool) -> Self {
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("orphan-939-{}", random_nonce().unwrap()));
        fs::create_dir(&root).unwrap();
        if keep_desktop {
            fs::write(root.join("keep-desktop"), b"").unwrap();
        }
        let mut launcher = helper("launcher_fixture", &root)
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        assert!(launcher.wait().unwrap().success());
        let descriptor = root.join("desktop-runtime-v1.json");
        let old = Lifecycle::open(&descriptor)
            .unwrap()
            .read()
            .unwrap()
            .unwrap()
            .0;
        wait_until(|| {
            observe_process_identity(old.controller.pid)
                .unwrap()
                .is_some_and(|id| id.parent_id != launcher.id())
        });
        #[cfg(target_os = "macos")]
        assert_eq!(
            observe_process_identity(old.controller.pid)
                .unwrap()
                .unwrap()
                .parent_id,
            1
        );
        assert!(descriptor.is_file());
        assert!(!port_closed(old.port).unwrap());
        Self {
            root,
            descriptor,
            old,
        }
    }

    fn reconcile(&self, launch: bool) -> Result<bool> {
        let lifecycle = Lifecycle::open(&self.descriptor)?;
        let _operation = lifecycle.lock()?;
        let _guard = try_acquire_launcher_guard(&self.root.join("launcher-v1.lock"))?
            .ok_or("fixture Launcher still owns the lock")?;
        lifecycle.reconcile(&self.root, true, launch)
    }

    fn verify_clean(&self) {
        assert!(port_closed(self.old.port).unwrap());
        assert!(self.old.controller.presence().unwrap() != Presence::Same);
        assert!(!self.descriptor.exists());
        assert!(
            Lifecycle::open(&self.descriptor)
                .unwrap()
                .read()
                .unwrap()
                .is_none()
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::write(self.root.join("release"), b"");
        wait_until(|| {
            port_closed(self.old.port).unwrap_or(false)
                && self
                    .old
                    .desktop
                    .presence()
                    .is_ok_and(|state| state != Presence::Same)
        });
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn stop_reaps_a_real_orphan_and_is_idempotent() {
    let fixture = Fixture::new(false);
    assert!(fixture.reconcile(false).unwrap());
    fixture.verify_clean();
    assert!(!fixture.reconcile(false).unwrap());
}

#[test]
fn launch_and_stop_serialize_recovery_without_removing_a_replacement() {
    let fixture = Fixture::new(false);
    let replacement = RuntimeDescriptor::new(
        std::process::id(),
        fixture.old.port,
        random_nonce().unwrap(),
    )
    .unwrap();
    let lifecycle = Lifecycle::open(&fixture.descriptor).unwrap();
    let operation = lifecycle.lock().unwrap();
    let stop = thread::spawn({
        let path = fixture.descriptor.clone();
        let data = fixture.root.clone();
        move || {
            let lifecycle = Lifecycle::open(&path).unwrap();
            let _operation = lifecycle.lock().unwrap();
            // A newer owner is unverified in this fixture; leave it alone.
            assert!(lifecycle.reconcile(&data, false, false).is_err());
        }
    });
    assert!(lifecycle.reconcile(&fixture.root, true, true).unwrap());
    fixture.verify_clean();
    write_descriptor(&fixture.descriptor, &replacement).unwrap();
    lifecycle.remove(&fixture.old).unwrap();
    drop(operation);
    stop.join().unwrap();
    assert_eq!(
        read_descriptor(&fixture.descriptor).unwrap(),
        Some(replacement)
    );
}

#[test]
fn refuses_reused_pid_and_forged_identity_without_stopping_the_listener() {
    let fixture = Fixture::new(false);
    let lifecycle = Lifecycle::open(&fixture.descriptor).unwrap();
    let (mut owner, _) = lifecycle.read().unwrap().unwrap();
    owner.controller.started_at_micros -= 1;
    lifecycle
        .store
        .publish(RECORD, &serde_json::to_vec(&owner).unwrap())
        .unwrap();
    assert!(
        fixture
            .reconcile(false)
            .unwrap_err()
            .to_string()
            .contains("identity does not match")
    );
    assert!(!port_closed(fixture.old.port).unwrap());
    lifecycle
        .store
        .publish(RECORD, &serde_json::to_vec(&fixture.old).unwrap())
        .unwrap();
    lifecycle.store.publish(KEY, &[0; 32]).unwrap();
    assert!(
        fixture
            .reconcile(true)
            .unwrap_err()
            .to_string()
            .contains("did not prove")
    );
    assert!(fixture.descriptor.exists());
    assert!(!port_closed(fixture.old.port).unwrap());
}

#[test]
fn launch_and_stop_refuse_an_orphan_when_desktop_is_alive() {
    let fixture = Fixture::new(true);
    for launch in [false, true] {
        assert!(
            fixture
                .reconcile(launch)
                .unwrap_err()
                .to_string()
                .contains("Desktop is still running")
        );
    }
    assert!(fixture.old.desktop.presence().unwrap() == Presence::Same);
    assert!(!port_closed(fixture.old.port).unwrap());
    assert!(fixture.descriptor.exists());
}
