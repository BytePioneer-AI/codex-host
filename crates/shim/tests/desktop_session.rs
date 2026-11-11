#![cfg(target_os = "macos")]

use std::fs;
use std::process::Command;
use std::time::{Duration, Instant};

use codexhost_platform::{process_snapshot, spawn_in_desktop_session, terminate_process_instance};

#[test]
#[ignore = "requires the current user's logged-in macOS desktop and launchd"]
fn desktop_spawn_reports_child_launch_failures() {
    let directory = std::env::temp_dir().join(format!("aqua-error-{}", std::process::id()));
    fs::create_dir(&directory).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_codexhost-shim"));
    command.current_dir(directory.join("missing"));
    let result = spawn_in_desktop_session(&command);
    fs::remove_dir(&directory).unwrap();
    let error = result.unwrap_err().to_string();
    assert!(error.contains("desktop launch failed:"), "{error}");
    assert!(error.contains("os error 2"), "{error}");
}

#[test]
#[ignore = "requires the current user's logged-in macOS desktop and launchd"]
fn desktop_spawn_preserves_context_and_survives_handoff_cleanup() {
    let directory = std::env::temp_dir().join(format!("aqua-test-{}", std::process::id()));
    fs::create_dir(&directory).unwrap();
    let output = directory.join("context.json");
    let script = r#"
import ctypes,json,os,shutil,subprocess,time
s=ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
sid=ctypes.c_uint32(); attrs=ctypes.c_uint32()
assert s.SessionGetInfo(ctypes.c_uint32(0xffffffff),ctypes.byref(sid),ctypes.byref(attrs))==0
data={'graphic_access': bool(attrs.value & 0x10), 'value':os.environ['AQUA_TEST_VALUE'], 'cwd':os.getcwd()}
if os.environ.get('CODEXHOST_TEST_GH_AUTH') == '1':
    r=subprocess.run([shutil.which('gh'),'api','user','--jq','.login'],capture_output=True,timeout=15)
    data['gh_authenticated']=r.returncode==0
with open(os.environ['AQUA_TEST_OUTPUT']+'.partial','w') as f: json.dump(data,f)
os.replace(os.environ['AQUA_TEST_OUTPUT']+'.partial',os.environ['AQUA_TEST_OUTPUT'])
time.sleep(30)
"#;
    let mut command = Command::new(env!("CARGO_BIN_EXE_codexhost-shim"));
    command
        .args(["-c", script])
        .env_clear()
        .envs(std::env::vars_os())
        .env("CODEXHOST_STOCK_CODEX_PATH", "/usr/bin/python3")
        .env("AQUA_TEST_VALUE", "spaces & Unicode 中文")
        .env("AQUA_TEST_OUTPUT", &output)
        .env_remove("CODEXHOST_LAUNCHER_PID")
        .current_dir(&directory);
    let spawned = spawn_in_desktop_session(&command).unwrap();
    let check = || {
        let deadline = Instant::now() + Duration::from_secs(20);
        let data = loop {
            if let Ok(text) = fs::read_to_string(&output) {
                break text;
            }
            assert!(
                Instant::now() < deadline,
                "desktop child did not publish its context"
            );
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(data.contains("\"graphic_access\": true"), "{data}");
        assert!(data.contains("spaces & Unicode"), "{data}");
        assert!(data.contains(directory.to_str().unwrap()), "{data}");
        if std::env::var("CODEXHOST_TEST_GH_AUTH").as_deref() == Ok("1") {
            assert!(data.contains("\"gh_authenticated\": true"), "{data}");
        }
        assert_eq!(
            process_snapshot(spawned.id).unwrap().started_at_micros,
            spawned.started_at_micros
        );
    };
    let result = std::panic::catch_unwind(check);
    terminate_process_instance(&spawned, false).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while process_snapshot(spawned.id).is_ok() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    if process_snapshot(spawned.id).is_ok() {
        terminate_process_instance(&spawned, true).unwrap();
    }
    fs::remove_dir_all(directory).unwrap();
    result.unwrap();
}
