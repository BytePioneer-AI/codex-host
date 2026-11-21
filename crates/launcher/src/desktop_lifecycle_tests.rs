use super::*;
use crate::runtime_instance::write_descriptor;
use std::net::TcpListener;
use std::process::{Command, Stdio};

const FIXTURE: &str = "CODEXHOST_LIFECYCLE_FIXTURE";

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(random_nonce().unwrap());
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(12)
}
fn listen() -> TcpListener {
    TcpListener::bind(("127.0.0.1", 0)).unwrap()
}
fn snapshot(pid: u32) -> ProcessSnapshot {
    process_snapshot(pid).unwrap()
}
fn descriptor(port: u16) -> RuntimeDescriptor {
    RuntimeDescriptor::new(std::process::id(), port, random_nonce().unwrap()).unwrap()
}

impl Lifecycle {
    fn fixture_record(&self, owner: &Owner) {
        self.store()
            .publish(RECORD, &serde_json::to_vec(owner).unwrap())
            .unwrap();
    }

    fn refuse(&self, root: &Path, reason: &str) {
        let error = self
            .reconcile(root, true, deadline())
            .unwrap_err()
            .to_string();
        assert!(error.contains(reason), "{error}");
    }
}

#[test]
fn refuses_unverified_live_generations_and_cleans_ended_ones() {
    let temp = Temp::new();
    let lifecycle = Lifecycle::open(&temp.0.join("runtime.json"), true).unwrap();
    let _op = lifecycle.lock(deadline()).unwrap();
    let _guard = lifecycle.launcher_guard().unwrap().unwrap();
    let listener = listen();
    let descriptor = descriptor(listener.local_addr().unwrap().port());
    let mut reused = Instance::from(&snapshot(descriptor.launcher_pid));
    reused.started_at_micros -= 1;
    let mut owner = Owner {
        descriptor,
        data: temp.0.clone(),
        launcher: reused.clone(),
        controller: Instance {
            pid: i32::MAX as u32,
            ..reused.clone()
        },
        desktop: Instance {
            pid: i32::MAX as u32 - 1,
            ..reused.clone()
        },
        key: [1; 32],
    };
    for (data, image, reason) in [
        (
            Path::new("/old/data"),
            reused.executable.as_path(),
            "different CODEXHOST_DATA_DIR",
        ),
        (
            &temp.0,
            Path::new("/old/installation"),
            "different installation",
        ),
        (&temp.0, &reused.executable, "identity does not match"),
    ] {
        owner.launcher.executable = image.into();
        lifecycle.fixture_record(&owner);
        lifecycle.refuse(data, reason);
    }
    drop(listener);
    owner.launcher.executable = "/old/installation".into();
    lifecycle.fixture_record(&owner);
    let replacement = RuntimeDescriptor {
        nonce: random_nonce().unwrap(),
        ..owner.descriptor.clone()
    };
    write_descriptor(&lifecycle.descriptor, &replacement).unwrap();
    lifecycle.refuse(&temp.0, "generation do not match");
    assert_eq!(
        read_descriptor(&lifecycle.descriptor).unwrap(),
        Some(replacement)
    );
    write_descriptor(&lifecycle.descriptor, &owner.descriptor).unwrap();
    assert!(lifecycle.reconcile(&temp.0, true, deadline()).unwrap());
    assert!(!lifecycle.reconcile(&temp.0, true, deadline()).unwrap());
}

#[test]
fn launcher_fixture() {
    let Some(root) = std::env::var_os(FIXTURE).map(PathBuf::from) else {
        return;
    };
    let bundle = std::env::var_os("CODEXHOST_TEST_CONTROLLER_BUNDLE").unwrap();
    let legacy = root.join("legacy").exists();
    let managed = root.join("managed").exists();
    let path = root.join("runtime.json");
    let lifecycle = Lifecycle::open(&path, true).unwrap();
    let _guard = lifecycle.launcher_guard().unwrap().unwrap();
    let operation = lifecycle.lock(deadline()).unwrap();
    let port = listen().local_addr().unwrap().port();
    let descriptor = descriptor(port);
    let renderer = root.join("renderer.js");
    fs::write(&renderer, "void 0;").unwrap();
    fs::write(
        root.join("watchdog.mjs"),
        "setTimeout(() => process.exit(0), 20_000).unref();",
    )
    .unwrap();
    let mut command = Command::new("node");
    command
        .current_dir(&root)
        .args(["--import", "./watchdog.mjs"])
        .arg(bundle)
        .arg("--renderer")
        .arg(renderer)
        .args([
            "--renderer-cdp-endpoint",
            &format!("http://127.0.0.1:{port}"),
            "--attachment-port",
            &port.to_string(),
            "--attachment-nonce",
            &descriptor.nonce,
        ])
        .env(
            "CODEXHOST_CONTROLLER_LIFECYCLE",
            if legacy { "0" } else { "1" },
        )
        .env("CODEXHOST_DATA_DIR", &root)
        .env("HOME", &root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    let mut child = codexhost_platform::spawn_supervised(&mut command).unwrap();
    // Intentionally no Desktop executable is started. Only the orphaned Node is real.
    if !legacy {
        let controller = snapshot(child.id());
        let absent = ProcessSnapshot {
            id: i32::MAX as u32,
            executable: root.join("desktop"),
            ..controller.clone()
        };
        let published = lifecycle
            .record_start(descriptor.clone(), &root, &absent, &controller)
            .unwrap();
        published.bootstrap(child.take_stdin().unwrap()).unwrap();
        if !managed {
            wait_until(deadline(), || Ok(!port_closed(port)?)).unwrap();
            write_descriptor(&path, &descriptor).unwrap();
            std::process::exit(0);
        }
        use rustix::process::{Pid, Signal, kill_process};
        kill_process(
            Pid::from_raw(child.id().try_into().unwrap()).unwrap(),
            Signal::STOP,
        )
        .unwrap();
        drop(operation);
        assert!(
            !crate::wait_for_controller_ready(&mut child, Duration::from_secs(120), || published
                .stopping())
            .unwrap()
        );
        crate::stop_desktop_controller(&mut child).unwrap();
        return;
    }
    wait_until(deadline(), || {
        Ok(root
            .join("diagnostics/desktop-controller-v1.json")
            .is_file()
            && !port_closed(port)?)
    })
    .unwrap();
    write_descriptor(&path, &descriptor).unwrap();
    drop(operation);
    child.wait().unwrap();
}

#[test]
#[ignore = "requires the release bundle; exercised by Unix recovery CI"]
fn recovers_release_controller() {
    for mode in ["legacy", "orphan", "managed"] {
        let temp = Temp::new();
        let path = temp.0.join("runtime.json");
        fs::write(temp.0.join(mode), b"").unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "desktop_lifecycle::tests::launcher_fixture"])
            .env(FIXTURE, &temp.0)
            .spawn()
            .unwrap();
        let orphan = mode == "orphan";
        if orphan {
            assert!(child.wait().unwrap().success());
        }
        let lifecycle = Lifecycle::open(&path, true).unwrap();
        wait_until(deadline(), || {
            Ok(path.exists() || lifecycle.read()?.is_some())
        })
        .unwrap();
        let _operation = lifecycle.lock(deadline()).unwrap();
        let guard = lifecycle.launcher_guard().unwrap();
        assert_eq!(guard.is_some(), orphan);
        let reaper = (!orphan).then(|| thread::spawn(move || child.wait().unwrap()));
        if orphan {
            let owner = lifecycle.read().unwrap().unwrap();
            lifecycle.store().remove(RECORD).unwrap();
            lifecycle.refuse(&temp.0, "lsof");
            lifecycle.fixture_record(&Owner {
                desktop: (&snapshot(std::process::id())).into(),
                ..owner.clone()
            });
            lifecycle.refuse(&temp.0, "Desktop is still running");
            lifecycle.fixture_record(&Owner {
                key: [0; 32],
                ..owner.clone()
            });
            lifecycle.refuse(&temp.0, "did not prove");
            lifecycle.fixture_record(&owner);
        }
        assert!(lifecycle.reconcile(&temp.0, orphan, deadline()).unwrap());
        assert!(!path.exists() && lifecycle.read().unwrap().is_none());
        if let Some(reaper) = reaper {
            assert!(reaper.join().unwrap().success());
        }
    }
}

#[test]
fn matches_replaced_linux_executable_only_when_unlinked() {
    let temp = Temp::new();
    let expected = temp.0.join("codexhost");
    fs::write(&expected, b"new").unwrap();
    let deleted = PathBuf::from(format!("{} (deleted)", expected.display()));
    assert_eq!(
        stripped_deleted_executable(&deleted).as_deref(),
        Some(expected.as_path())
    );
    #[cfg(target_os = "linux")]
    assert!(same_executable(&expected, &deleted));
    let other = temp.0.join("other-codexhost (deleted)");
    assert_ne!(
        stripped_deleted_executable(&other).as_deref(),
        Some(expected.as_path())
    );
    // A literal file on disk named "... (deleted)" must not masquerade as an unlinked binary.
    fs::write(&deleted, b"spoof").unwrap();
    assert_eq!(stripped_deleted_executable(&deleted), None);
    assert!(!same_executable(&expected, &deleted));
}
