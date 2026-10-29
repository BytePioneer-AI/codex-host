//! Actual Windows Job -> Node Host -> native Launcher -> native Updater handoff.
//! No installed application or install tool is executed.
use super::*;
use serde_json::json;
const LAUNCHER_FIXTURE: &str = "active_update::windows::tests::launcher_fixture";

fn wait_file(file: &Path, timeout: Duration) {
    let end = Instant::now() + timeout;
    while !file.is_file() {
        assert!(Instant::now() < end, "missing {}", file.display());
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
#[ignore = "requires the paired Updater test binary; run npm run test:update-fixtures"]
fn two_updates_survive_old_desktop_jobs_including_detached_node_children() {
    let updater = std::env::var_os("CODEXHOST_NATIVE_UPDATER_TEST_BINARY")
        .expect("run through npm run test:update-fixtures");
    let key = WindowsLaunchJob::create_unique().unwrap();
    let root = std::env::temp_dir().join(format!("codexhost 交接-{}", key.key()));
    fs::create_dir_all(root.join("bin")).unwrap();
    let launcher = root.join("bin/codexhost.exe");
    fs::copy(std::env::current_exe().unwrap(), &launcher).unwrap();
    fs::write(root.join("host.mjs"), r#"
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const { startUpdater } = await import(pathToFileURL(process.env.CODEXHOST_HANDOFF_PUBLISHER));
const { readWindowsProcessIdentity } = await import(pathToFileURL(process.env.CODEXHOST_HANDOFF_IDENTITY));
const config = JSON.parse(fs.readFileSync(process.env.CODEXHOST_HANDOFF_CONFIG,'utf8'));
const owner = await readWindowsProcessIdentity(process.pid);
const request = { ...config.request, launch_via_launcher: false };
fs.writeFileSync(config.requestPath, JSON.stringify(request));
fs.writeFileSync(config.statusPath, JSON.stringify({ schemaVersion:1, version:request.version, installation:'windows-installer', phase:'prepared', updatedAt:1 }));
fs.writeFileSync(config.lockPath, JSON.stringify({ ownerPid:process.pid, statusPath:config.statusPath, operationId:config.operationId, ownerStartedAtMicros:owner.startedAtMicros, installationStarted:false }));
// Negative control: detached Node still inherits the old Job.
const detached = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
fs.writeFileSync(config.detachedPid, String(detached.pid)); detached.unref();
fs.writeFileSync(config.beforeIntent, 'prepared');
while (!fs.existsSync(config.allowIntent)) await new Promise(r=>setTimeout(r,20));
await startUpdater({platform:'win32',prepared:{requestPath:config.requestPath,helperPath:config.helperPath},owner:request,spawnUpdater(){throw new Error('Host must not spawn its own updater')},readStatus(){throw new Error('Launcher owns the native ready handshake')}});
fs.writeFileSync(config.published, 'requested');
setInterval(()=>{},1000);
"#).unwrap();
    let package =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/update-manager/dist");
    let mut first = Command::new(&launcher)
        .args(["--exact", LAUNCHER_FIXTURE, "--ignored", "--nocapture"])
        .env("CODEXHOST_HANDOFF_ROOT", &root)
        .env("CODEXHOST_HANDOFF_ROUND", "1")
        .env("CODEXHOST_HANDOFF_UPDATER", updater)
        .env(
            "CODEXHOST_HANDOFF_PUBLISHER",
            package.join("updater-ready.js"),
        )
        .env(
            "CODEXHOST_HANDOFF_IDENTITY",
            package.join("windows-process-identity.js"),
        )
        .spawn()
        .unwrap();
    wait_file(&root.join("survived-2"), Duration::from_secs(90));
    assert!(first.wait().unwrap().success());
    assert!(root.join("survived-1").is_file());
    for n in [1, 2] {
        let result: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join(format!("survived-{n}"))).unwrap()).unwrap();
        assert_eq!(result["outsideOldJob"], true);
        assert_eq!(result["oldJobEmpty"], true);
        assert_eq!(result["lockTaken"], true);
    }
    // All fixture binaries have exited before removing this private directory.
    wait_file(&root.join("finished-1"), Duration::from_secs(10));
    wait_file(&root.join("finished-2"), Duration::from_secs(10));
    for _ in 0..100 {
        if fs::remove_dir_all(&root).is_ok() {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("fixture processes did not release their software directory");
}

#[test]
#[ignore = "spawned by the two-update Windows handoff test only"]
fn launcher_fixture() {
    let root = PathBuf::from(std::env::var_os("CODEXHOST_HANDOFF_ROOT").unwrap());
    let round = std::env::var("CODEXHOST_HANDOFF_ROUND").unwrap();
    assert!(["1", "2"].contains(&round.as_str()));
    if let Some(previous) = std::env::var_os("CODEXHOST_HANDOFF_PREVIOUS_JOB") {
        assert!(
            !WindowsLaunchJob::open(&previous.to_string_lossy())
                .unwrap()
                .contains_pid(std::process::id())
                .unwrap(),
            "relaunch inherited the previous Desktop Job"
        );
    }
    let job = WindowsLaunchJob::create_unique().unwrap();
    assert!(!job.contains_pid(std::process::id()).unwrap());
    let state = root.join(format!("state-{round}"));
    let operation = state.join(format!("update-{round}"));
    fs::create_dir_all(&operation).unwrap();
    fs::copy(
        std::env::var_os("CODEXHOST_HANDOFF_UPDATER").unwrap(),
        operation.join("codexhost-updater.exe"),
    )
    .unwrap();
    let request = operation.join("request-v1.json");
    let status = operation.join("status-v1.json");
    let owner = process_snapshot(std::process::id()).unwrap();
    let config = root.join(format!("config-{round}.json"));
    let detached = root.join(format!("detached-{round}"));
    let published = root.join(format!("published-{round}"));
    fs::write(&config, json!({
        "requestPath":request, "statusPath":status, "lockPath":state.join("active-update-v1.lock"), "helperPath":operation.join("codexhost-updater.exe"),
        "operationId":job.key(), "published":published,"detachedPid":detached,
        "beforeIntent":root.join(format!("before-intent-{round}")), "allowIntent":root.join(format!("allow-intent-{round}")),
        "request":{"schema_version":1,"version":"1.2.4","wait_pid":owner.id,"wait_executable":owner.executable,
            "wait_started_at_micros":owner.started_at_micros.to_string(),"runtime_descriptor_path":root.join("runtime.json"),
            "status_path":status,"installation":{"kind":"windows-installer","installer_path":root.join("never-run.exe"),
                "artifact_sha256":"ab".repeat(32),"install_root":root,"installed_version":"1.2.3"}}
    }).to_string()).unwrap();
    let mut host = job
        .spawn_supervised(
            Command::new("node")
                .arg(root.join("host.mjs"))
                .env("CODEXHOST_HANDOFF_CONFIG", &config)
                .env(codexhost_platform::DESKTOP_LAUNCH_JOB_ENV, job.key())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit()),
        )
        .unwrap();
    wait_file(
        &root.join(format!("before-intent-{round}")),
        Duration::from_secs(20),
    );
    let mut started = None;
    start_at(&state, &mut started, Some(&job), |_| {
        panic!("prepared alone must not spawn a helper")
    })
    .unwrap();
    assert!(started.is_none());
    fs::write(root.join(format!("allow-intent-{round}")), "allow").unwrap();
    wait_file(&published, Duration::from_secs(20));
    assert!(job.contains_pid(host.id()).unwrap());
    let detached_pid: u32 = fs::read_to_string(detached).unwrap().parse().unwrap();
    assert!(
        job.contains_pid(detached_pid).unwrap(),
        "Node detached unexpectedly escaped its Job"
    );
    let prepared_status = fs::read(&status).unwrap();
    // A real zero-exit process without native lock/ready acknowledgement must
    // leave the old Job and Host alive, not trigger protected-launch cleanup.
    assert!(
        start_at(&state, &mut started, Some(&job), |pending| {
            Command::new(&pending.helper_path)
                .args(["--exact", "no_such_handoff_fixture"])
                .spawn()
        })
        .is_err()
    );
    assert!(started.is_none());
    assert!(host.try_wait().unwrap().is_none());
    assert!(!job.is_empty().unwrap());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&fs::read(&status).unwrap()).unwrap()["phase"],
        "failed"
    );
    fs::write(&status, prepared_status).unwrap(); // fixture-only fresh start attempt
    start_at(&state, &mut started, Some(&job), |pending| {
        Command::new(&pending.helper_path)
            .args([
                "--exact",
                "windows_handoff_tests::updater_fixture",
                "--ignored",
                "--nocapture",
            ])
            .env("CODEXHOST_HANDOFF_REQUEST", &request)
            .env("CODEXHOST_HANDOFF_OLD_JOB", job.key())
            .spawn()
    })
    .unwrap();
    assert!(started.is_some());
    assert!(
        waiting_for_launcher_exit_at(
            &state,
            std::process::id(),
            &std::env::current_exe().unwrap()
        )
        .unwrap()
    );
    job.terminate_and_wait(Duration::from_secs(5)).unwrap();
    host.wait_for_tree_exit(Duration::from_secs(5)).unwrap();
    assert!(!codexhost_platform::process_exists(detached_pid));
    // Returning exits this actual Launcher process. Updater's production wait
    // and ownership code must survive both the Job termination and this exit.
}
