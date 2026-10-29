use super::*;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture {
    root: PathBuf,
    children: Vec<Child>,
    owned: Vec<ProcessSnapshot>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for process in &self.owned {
            let _ = codexhost_platform::terminate_process_instance(process, true);
        }
        for child in &mut self.children {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn fixture(mode: &str, npm_parent: bool) -> (Fixture, StartupCheck) {
    let root = std::env::temp_dir().join(format!(
        "codexhost-startup-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(root.join("bin")).unwrap();
    fs::create_dir_all(root.join("app")).unwrap();
    // Spawn from the long filesystem path so Windows image evidence and the
    // captured Launcher path use the same spelling even under an 8.3 TEMP.
    let root = root.canonicalize().unwrap();
    let launcher = root.join("bin/codexhost.exe");
    fs::copy(std::env::current_exe().unwrap(), &launcher).unwrap();
    fs::write(root.join("app/desktop-controller.mjs"), "fixture").unwrap();
    let host_entry = root.join("app/host-runtime.mjs");
    fs::write(&host_entry, r#"
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root=process.env.CODEXHOST_READY_TEST_ROOT, mode=process.env.CODEXHOST_READY_TEST_MODE;
const token='a'.repeat(64);
const server=http.createServer((req,res)=>{
 if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401);res.end();return;}
 const version=mode==='wrong-host-version'?'9.9.9':'1.2.3';
 const body=JSON.stringify(req.url==='/ready'?{ready:mode!=='host-not-ready'}:{result:{runningVersion:version,installedVersion:version,restartRequired:false,remote:false}});
 res.writeHead(200,{'content-length':Buffer.byteLength(body)});res.end(body);
});
server.listen(0,'127.0.0.1',()=>{
 fs.mkdirSync(path.join(root,'console/hosts'),{recursive:true});
 fs.writeFileSync(path.join(root,`console/hosts/host-${process.pid}.json`),JSON.stringify({schemaVersion:1,pid:process.pid,launcherPid:Number(process.env.CODEXHOST_READY_TEST_LAUNCHER),port:server.address().port,token,startedAt:Date.now()-Number(process.env.CODEXHOST_READY_TEST_CLOCK_OFFSET)}));
});
"#).unwrap();
    #[cfg(not(target_os = "linux"))]
    let started_at = now();
    let wrapper = root.join("wrapper.cjs");
    fs::write(&wrapper, format!(r#"const cp=require('node:child_process'),fs=require('node:fs');const child=cp.spawn({},['--exact','windows_ready::tests::native_startup_child','--ignored','--nocapture'],{{env:process.env,stdio:'ignore'}});fs.writeFileSync({},String(child.pid));child.on('exit',code=>process.exit(code??1));"#, serde_json::to_string(&launcher).unwrap(), serde_json::to_string(&root.join("launcher.pid")).unwrap())).unwrap();
    let mut command = if npm_parent {
        let mut command = Command::new("node");
        command.arg(&wrapper);
        command
    } else {
        let mut command = Command::new(&launcher);
        command.args([
            "--exact",
            "windows_ready::tests::native_startup_child",
            "--ignored",
            "--nocapture",
        ]);
        command
    };
    let mut launcher_child = command
        .env("CODEXHOST_READY_TEST_ROOT", &root)
        .env("CODEXHOST_READY_TEST_MODE", mode)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let launcher_pid = if npm_parent {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Ok(value) = fs::read_to_string(root.join("launcher.pid"))
                && let Ok(pid) = value.trim().parse::<u32>()
            {
                break pid;
            }
            assert!(Instant::now() < deadline && launcher_child.try_wait().unwrap().is_none());
            std::thread::sleep(Duration::from_millis(10));
        }
    } else {
        launcher_child.id()
    };
    let launcher_process = process_snapshot(launcher_pid).unwrap();
    // Linux snapshots use time since boot, unlike Windows FILETIME/macOS epoch
    // time. Keep the synthetic readiness evidence in that same clock domain.
    #[cfg(target_os = "linux")]
    let started_at = birth_ms(&launcher_process);
    #[cfg(target_os = "linux")]
    let clock_offset = now().saturating_sub(started_at);
    #[cfg(not(target_os = "linux"))]
    let clock_offset = 0_u64;
    let owned = vec![launcher_process];
    let host_child = Command::new("node")
        .arg(&host_entry)
        .env("CODEXHOST_READY_TEST_ROOT", &root)
        .env("CODEXHOST_READY_TEST_MODE", mode)
        .env("CODEXHOST_READY_TEST_LAUNCHER", launcher_pid.to_string())
        .env(
            "CODEXHOST_READY_TEST_CLOCK_OFFSET",
            clock_offset.to_string(),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let node = process_snapshot(host_child.id())
        .unwrap()
        .executable
        .canonicalize()
        .unwrap();
    let expected_launcher = if mode == "wrong-installation" {
        let path = root.join("other.exe");
        fs::copy(&launcher, &path).unwrap();
        path
    } else {
        launcher
    };
    let check = StartupCheck {
        #[cfg(target_os = "windows")]
        job: None,
        version: "1.2.3".into(),
        launcher: expected_launcher.canonicalize().unwrap(),
        node,
        host_entry: host_entry.canonicalize().unwrap(),
        descriptor: root.join("runtime.json"),
        data: root.clone(),
        started_at,
        previous_nonce: (mode == "stale-descriptor").then(|| "b".repeat(32)),
        npm_parent,
        spawned: process_snapshot(if mode == "wrong-launch-origin" {
            if npm_parent {
                host_child.id()
            } else {
                std::process::id()
            }
        } else {
            launcher_child.id()
        })
        .ok(),
    };
    (
        Fixture {
            root,
            children: vec![launcher_child, host_child],
            owned,
        },
        check,
    )
}
#[test]
#[ignore = "spawned as an isolated native Launcher fixture by the parent tests"]
fn native_startup_child() {
    let root = PathBuf::from(std::env::var_os("CODEXHOST_READY_TEST_ROOT").unwrap());
    let mode = std::env::var("CODEXHOST_READY_TEST_MODE").unwrap();
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    fs::create_dir_all(root.join("diagnostics")).unwrap();
    let process = process_snapshot(std::process::id()).unwrap();
    let time = if mode == "stale-record" {
        1
    } else if cfg!(target_os = "linux") {
        birth_ms(&process)
    } else {
        now()
    };
    let parent = process_snapshot(process.parent_id).unwrap();
    fs::write(root.join("diagnostics/launcher-startup-v1.json"), serde_json::json!({"schemaVersion":1,"records":[{"pid":std::process::id(),"startedAtMicros":process.started_at_micros.to_string(),"parent":{"pid":parent.id,"startedAtMicros":parent.started_at_micros.to_string(),"executable":parent.executable},"launcherVersion":if mode=="wrong-version" {"9.9.9"}else{"1.2.3"},"startedAtMs":time,"finishedAtMs":time,"outcome":"ready"}]}).to_string()).unwrap();
    fs::write(root.join("runtime.json"), serde_json::json!({"schema_version":1,"launcher_pid":std::process::id(),"control_port":listener.local_addr().unwrap().port(),"nonce":"b".repeat(32)}).to_string()).unwrap();
    if mode == "immediate-exit" {
        return;
    }
    for stream in listener.incoming() {
        let mut stream = stream.unwrap();
        stream
            .set_read_timeout(Some(Duration::from_millis(500)))
            .unwrap();
        let mut request = [0; 128];
        let count = stream.read(&mut request).unwrap_or(0);
        if mode != "control-unavailable"
            && &request[..count] == format!("PING {}\n", "b".repeat(32)).as_bytes()
        {
            let _ = stream.write_all(b"ready\n");
        }
    }
}
#[test]
fn accepts_only_the_fresh_native_instance_with_both_channels_ready() {
    let (_fixture, check) = fixture("ready", false);
    check.wait(Duration::from_secs(8)).unwrap();
}
#[path = "windows_startup_cleanup_tests.rs"]
mod cleanup_tests;

#[test]
fn binds_the_real_npm_wrapper_parent_and_rejects_another_parent_instance() {
    let (_fixture, check) = fixture("ready", true);
    check.wait(Duration::from_secs(8)).unwrap();
    let (_fixture, check) = fixture("wrong-launch-origin", true);
    assert!(check.wait(Duration::from_millis(700)).is_err());
}
#[test]
fn rejects_wrong_versions_installations_stale_evidence_and_unavailable_channels() {
    for mode in [
        "wrong-version",
        "wrong-host-version",
        "wrong-installation",
        "wrong-launch-origin",
        "stale-record",
        "stale-descriptor",
        "host-not-ready",
        "control-unavailable",
        "immediate-exit",
    ] {
        let (_fixture, check) = fixture(mode, false);
        assert!(
            check.wait(Duration::from_millis(700)).is_err(),
            "accepted {mode}"
        );
    }
}
