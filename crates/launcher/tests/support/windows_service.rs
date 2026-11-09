use std::env;
use std::fs;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// Cargo's enclosing Windows Job does not allow service breakaway. Run the
// fixture in our own cleanup Job, as a real supervised Desktop caller does.
pub fn run_in_service_job() -> bool {
    const ADMISSION: &str = "CODEXHOST_WEB_TEST_JOB_ADMISSION";
    if let Some(path) = env::var_os(ADMISSION) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !std::path::Path::new(&path).exists() {
            assert!(Instant::now() < deadline, "fixture Job admission timed out");
            thread::sleep(Duration::from_millis(10));
        }
        return false;
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = env::temp_dir().join(format!("web-test-job-{}-{nonce}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let admission = root.join("admitted");
    let current = thread::current();
    let name = current.name().expect("named test thread");
    let mut command = Command::new(env::current_exe().unwrap());
    command
        .args(["--exact", name, "--nocapture"])
        .env(ADMISSION, &admission)
        .stdin(Stdio::null());
    let mut child = codexhost_platform::spawn_supervised(&mut command).unwrap();
    fs::write(&admission, "admitted").unwrap();
    let status = child.wait().unwrap();
    fs::remove_dir_all(&root).unwrap();
    assert!(status.success(), "service fixture {name} failed: {status}");
    true
}
