use std::fs;
#[cfg(target_os = "windows")]
use std::io::{BufRead, BufReader};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{self, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
use std::time::Instant;

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
use codexhost_platform::process_exists;
use codexhost_platform::{CODEX_CLI_PATH_ENV, STOCK_CODEX_PATH_ENV};
use codexhost_shim::{HOST_NODE_PATH_ENV, HOST_RUNTIME_PATH_ENV, REMOTE_SSH_MANAGED_ENV};

fn shim_path() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_codexhost-shim"))
}

fn fake_codex_path() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_fake-codex-cli"))
}

fn temporary_directory() -> PathBuf {
    static NEXT_DIRECTORY_ID: AtomicU64 = AtomicU64::new(0);

    loop {
        let directory_id = NEXT_DIRECTORY_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "codexhost-shim-test-{}-{directory_id}",
            process::id(),
        ));
        match fs::create_dir(&path) {
            Ok(()) => return path,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => panic!("create temporary directory {}: {error}", path.display()),
        }
    }
}

#[test]
fn creates_unique_temporary_directories_concurrently() {
    let workers = (0..16)
        .map(|_| std::thread::spawn(temporary_directory))
        .collect::<Vec<_>>();
    let directories = workers
        .into_iter()
        .map(|worker| worker.join().expect("create temporary directory"))
        .collect::<std::collections::HashSet<_>>();

    assert_eq!(directories.len(), 16);
    for directory in directories {
        fs::remove_dir(directory).expect("remove temporary directory");
    }
}

fn run_shim(
    input: &[u8],
    arguments: &[&str],
    environment: &[(&str, &str)],
) -> std::process::Output {
    let mut command = Command::new(shim_path());
    command
        .args(arguments)
        .env_remove(HOST_NODE_PATH_ENV)
        .env_remove(HOST_RUNTIME_PATH_ENV)
        .env_remove(REMOTE_SSH_MANAGED_ENV)
        .env_remove("CODEXHOST_REMOTE_LISTENER_CHILD")
        .env(STOCK_CODEX_PATH_ENV, fake_codex_path())
        .env(CODEX_CLI_PATH_ENV, shim_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for name in [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "NO_PROXY",
        "no_proxy",
        "NODE_USE_ENV_PROXY",
    ] {
        command.env_remove(name);
    }
    for (key, value) in environment {
        command.env(key, value);
    }
    let mut child = command.spawn().expect("spawn shim");
    let mut stdin = child.stdin.take().expect("shim stdin");
    let input = input.to_vec();
    let writer = thread::spawn(move || stdin.write_all(&input));
    let output = child.wait_with_output().expect("wait for shim");
    writer
        .join()
        .expect("join shim stdin writer")
        .expect("write shim stdin");
    output
}

#[test]
fn preserves_arbitrary_bytes_and_chunk_boundaries() {
    let mut input = b"{\"id\":1}\r\n{\"split\":".to_vec();
    input.extend_from_slice(&[0, 0x7f, 0x80, 0xff, b'\n']);
    let output = run_shim(
        &input,
        &["app-server", "--stdio"],
        &[("FAKE_CODEX_BYTE_CHUNKS", "1")],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, input);
}

#[test]
fn forwards_response_before_stdin_eof() {
    let mut shim = Command::new(shim_path())
        .env(STOCK_CODEX_PATH_ENV, fake_codex_path())
        .env("FAKE_CODEX_STREAM_RESPONSE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn streaming shim");
    let mut stdin = shim.stdin.take().expect("shim stdin");
    stdin.write_all(b"x").expect("write streaming request");

    let mut stdout = shim.stdout.take().expect("shim stdout");
    let (response_sender, response_receiver) = mpsc::sync_channel(1);
    let reader = thread::spawn(move || {
        let mut response = [0_u8; 8];
        stdout
            .read_exact(&mut response)
            .expect("read streaming response");
        response_sender
            .send(response)
            .expect("send streaming response");
        let mut trailing = Vec::new();
        stdout
            .read_to_end(&mut trailing)
            .expect("drain streaming stdout");
        (response, trailing)
    });
    let response = response_receiver
        .recv_timeout(Duration::from_secs(2))
        .expect("Shim did not forward a response while stdin remained open");
    assert_eq!(response, *b"response");
    drop(stdin);
    let status = shim.wait().expect("wait for streaming shim");
    let mut stderr = Vec::new();
    shim.stderr
        .take()
        .expect("shim stderr")
        .read_to_end(&mut stderr)
        .expect("read streaming shim stderr");
    assert!(
        status.success(),
        "streaming shim exited {status}; stderr={}",
        String::from_utf8_lossy(&stderr)
    );
    let (response, trailing) = reader.join().expect("join response reader");
    assert_eq!(response, *b"response");
    assert!(trailing.is_empty());
}

#[test]
fn preserves_arguments_and_removes_recursive_environment() {
    let output = run_shim(
        b"",
        &["app-server", "--analytics-default-enabled"],
        &[("FAKE_CODEX_PRINT_INVOCATION", "1")],
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("args=app-server|--analytics-default-enabled"));
    assert!(stderr.contains("codex_cli_path_present=false"));
    assert!(output.stdout.is_empty());
}

#[test]
fn managed_remote_child_receives_inherited_proxy_environment() {
    let output = run_shim(
        b"",
        &["app-server", "--analytics-default-enabled"],
        &[
            (REMOTE_SSH_MANAGED_ENV, "1"),
            ("HTTP_PROXY", "http://remote-proxy:8080"),
            ("FAKE_CODEX_PRINT_PROXY_ENV", "1"),
        ],
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{stderr}");
    assert!(
        stderr.contains("HTTP_PROXY=http://remote-proxy:8080"),
        "stderr={stderr}"
    );
    assert!(
        stderr.contains("http_proxy=http://remote-proxy:8080"),
        "stderr={stderr}"
    );
}

#[test]
fn forwards_stderr_and_exit_code_without_polluting_stdout() {
    let output = run_shim(
        b"request",
        &[],
        &[
            ("FAKE_CODEX_STDERR", "official stderr"),
            ("FAKE_CODEX_EXIT_CODE", "23"),
        ],
    );
    assert_eq!(output.status.code(), Some(23));
    assert_eq!(output.stdout, b"request");
    assert_eq!(output.stderr, b"official stderr");
}

#[test]
fn drains_large_output_after_stdin_eof() {
    let input = vec![b'x'; 2 * 1024 * 1024];
    let output = run_shim(&input, &[], &[]);
    assert!(
        output.status.success(),
        "large-output shim exited {}; stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, input);
}

#[test]
fn production_shim_ignores_gate_capture_environment() {
    let output_directory = temporary_directory().join("capture-must-not-exist");
    let output = run_shim(
        b"request",
        &[],
        &[(
            "CODEXHOST_PROBE_OUTPUT",
            output_directory.to_str().expect("UTF-8 test path"),
        )],
    );
    assert!(output.status.success());
    assert_eq!(output.stdout, b"request");
    assert!(!output_directory.exists());
}

#[test]
fn rejects_recursion_without_stdout_output() {
    let output = Command::new(shim_path())
        .env(STOCK_CODEX_PATH_ENV, shim_path())
        .stdin(Stdio::null())
        .output()
        .expect("run recursive shim");
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Shim itself"));
}

#[test]
fn rejects_missing_official_cli_without_falling_back_to_path() {
    let missing = temporary_directory().join("missing-codex.exe");
    let output = Command::new(shim_path())
        .env(STOCK_CODEX_PATH_ENV, missing)
        .stdin(Stdio::null())
        .output()
        .expect("run shim with missing target");
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("does not exist"));
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn managed_remote_listener_detaches_after_the_socket_is_ready() {
    static NEXT_REMOTE_DIRECTORY_ID: AtomicU64 = AtomicU64::new(0);

    let directory = PathBuf::from("/tmp").join(format!(
        "codexhost-remote-test-{}-{}",
        process::id(),
        NEXT_REMOTE_DIRECTORY_ID.fetch_add(1, Ordering::Relaxed),
    ));
    fs::create_dir(&directory).expect("create short remote listener fixture directory");
    let codex_home = directory.join("home");
    let socket = codex_home
        .join("app-server-control")
        .join("app-server-control.sock");
    let ready = directory.join("ready");
    let started = Instant::now();
    let child = Command::new(shim_path())
        .args([
            "-c",
            "features.code_mode_host=true",
            "app-server",
            "--listen",
            "unix://",
        ])
        .env_remove(HOST_NODE_PATH_ENV)
        .env_remove(HOST_RUNTIME_PATH_ENV)
        .env_remove("CODEXHOST_REMOTE_LISTENER_CHILD")
        .env(STOCK_CODEX_PATH_ENV, fake_codex_path())
        .env(CODEX_CLI_PATH_ENV, shim_path())
        .env(REMOTE_SSH_MANAGED_ENV, "1")
        .env("CODEX_HOME", &codex_home)
        .env("FAKE_CODEX_UNIX_LISTENER_PATH", &socket)
        .env("FAKE_CODEX_READY_PATH", &ready)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start managed remote listener");
    let (completion_sender, completion_receiver) = mpsc::channel();
    let waiter = thread::spawn(move || completion_sender.send(child.wait_with_output()));

    let ready_deadline = Instant::now() + Duration::from_secs(2);
    while !ready.exists() && Instant::now() < ready_deadline {
        thread::sleep(Duration::from_millis(20));
    }
    let ready = fs::read_to_string(&ready).expect("read detached listener identity");
    let value = |label: &str| {
        ready
            .lines()
            .find_map(|line| line.strip_prefix(label))
            .expect("listener identity field")
            .parse::<u32>()
            .expect("listener identity PID")
    };
    let root_id = value("root=");
    let shim_id = value("shim=");
    let output = match completion_receiver.recv_timeout(Duration::from_secs(2)) {
        Ok(output) => output.expect("wait for managed remote listener bootstrap"),
        Err(error) => {
            let _ = Command::new("/bin/kill")
                .args(["-KILL", &shim_id.to_string(), &root_id.to_string()])
                .status();
            let _ = completion_receiver.recv_timeout(Duration::from_secs(5));
            waiter
                .join()
                .expect("join failed bootstrap waiter")
                .expect("send failed bootstrap output");
            fs::remove_dir_all(&directory).expect("remove failed remote listener fixture");
            panic!("remote listener bootstrap kept its output pipes open: {error}");
        }
    };
    waiter
        .join()
        .expect("join remote listener bootstrap waiter")
        .expect("send remote listener bootstrap output");
    assert!(
        output.status.success(),
        "remote listener bootstrap failed: {}; stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty());
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "remote listener bootstrap did not detach promptly"
    );

    assert!(socket.exists(), "detached listener socket is unavailable");
    assert!(process_exists(root_id), "detached listener root exited");
    assert!(process_exists(shim_id), "detached listener Shim exited");

    let termination = Command::new("/bin/kill")
        .args(["-TERM", &shim_id.to_string()])
        .status()
        .expect("stop detached listener Shim");
    assert!(termination.success());
    let deadline = Instant::now() + Duration::from_secs(5);
    while (process_exists(root_id) || process_exists(shim_id)) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    if process_exists(root_id) || process_exists(shim_id) {
        let _ = Command::new("/bin/kill")
            .args(["-KILL", &shim_id.to_string(), &root_id.to_string()])
            .status();
    }
    assert!(
        !process_exists(root_id),
        "detached listener root survived shutdown"
    );
    assert!(
        !process_exists(shim_id),
        "detached listener Shim survived shutdown"
    );
    fs::remove_dir_all(directory).expect("remove remote listener fixture");
}

#[cfg(target_os = "macos")]
#[test]
fn reports_an_official_cli_crash_without_polluting_stdout() {
    let output = run_shim(b"", &[], &[("FAKE_CODEX_CRASH", "1")]);
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("terminated by signal"));
}

#[cfg(target_os = "macos")]
fn wait_for_file(path: &std::path::Path, timeout: Duration) -> String {
    let started = Instant::now();
    loop {
        if let Ok(contents) = fs::read_to_string(path) {
            return contents;
        }
        assert!(
            started.elapsed() < timeout,
            "timed out waiting for {}",
            path.display()
        );
        thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(target_os = "macos")]
fn run_external_signal_case(signal: &str, expected_signal: i32, ignore_signal: bool) {
    let directory = temporary_directory();
    let ready = directory.join("ready");
    let observed = directory.join("observed");
    let mut command = Command::new(shim_path());
    command
        .env(STOCK_CODEX_PATH_ENV, fake_codex_path())
        .env("FAKE_CODEX_SIGNAL_READY", &ready)
        .env("FAKE_CODEX_SIGNAL_OBSERVED", &observed)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if ignore_signal {
        command.env("FAKE_CODEX_IGNORE_SIGNALS", "1");
    }
    let mut shim = command.spawn().expect("spawn signal test shim");
    let shim_id = shim.id();
    let child_id = wait_for_file(&ready, Duration::from_secs(5))
        .trim()
        .parse::<u32>()
        .expect("ready child PID");

    let kill_status = Command::new("/bin/kill")
        .args([format!("-{signal}"), shim_id.to_string()])
        .status()
        .expect("send external signal");
    assert!(kill_status.success());
    assert_eq!(
        wait_for_file(&observed, Duration::from_secs(5)).trim(),
        expected_signal.to_string()
    );

    let started = Instant::now();
    while shim.try_wait().expect("poll shim").is_none()
        && started.elapsed() < Duration::from_secs(6)
    {
        thread::sleep(Duration::from_millis(20));
    }
    if shim.try_wait().expect("final shim poll").is_none() {
        let _ = shim.kill();
        let _ = Command::new("/bin/kill")
            .args(["-KILL", &child_id.to_string()])
            .status();
        panic!("Shim did not converge after {signal}");
    }
    let output = shim.wait_with_output().expect("collect shim output");
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains(&format!("forwarded shutdown signal {expected_signal}")));
    if ignore_signal {
        assert!(stderr.contains("terminated by signal 9"));
    }
    assert!(
        !process_exists(child_id),
        "official CLI PID {child_id} survived shutdown"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn forwards_external_sigterm_to_the_official_cli_group() {
    run_external_signal_case("TERM", 15, false);
}

#[cfg(target_os = "macos")]
#[test]
fn forwards_external_sigint_to_the_official_cli_group() {
    run_external_signal_case("INT", 2, false);
}

#[cfg(target_os = "macos")]
#[test]
fn forwards_external_sighup_to_the_official_cli_group() {
    run_external_signal_case("HUP", 1, false);
}

#[cfg(target_os = "macos")]
#[test]
fn converges_once_when_multiple_shutdown_signals_arrive() {
    let directory = temporary_directory();
    let ready = directory.join("ready");
    let observed = directory.join("observed");
    let mut shim = Command::new(shim_path())
        .env(STOCK_CODEX_PATH_ENV, fake_codex_path())
        .env("FAKE_CODEX_SIGNAL_READY", &ready)
        .env("FAKE_CODEX_SIGNAL_OBSERVED", &observed)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn concurrent-signal shim");
    let child_id = wait_for_file(&ready, Duration::from_secs(5))
        .trim()
        .parse::<u32>()
        .expect("ready child PID");
    for signal in ["TERM", "INT"] {
        let status = Command::new("/bin/kill")
            .args([format!("-{signal}"), shim.id().to_string()])
            .status()
            .expect("send shutdown signal");
        assert!(status.success());
    }
    let _ = wait_for_file(&observed, Duration::from_secs(5));
    let started = Instant::now();
    while shim.try_wait().expect("poll shim").is_none()
        && started.elapsed() < Duration::from_secs(5)
    {
        thread::sleep(Duration::from_millis(20));
    }
    if shim.try_wait().expect("final shim poll").is_none() {
        let _ = shim.kill();
        let _ = Command::new("/bin/kill")
            .args(["-KILL", &child_id.to_string()])
            .status();
        panic!("Shim did not converge after concurrent signals");
    }
    let output = shim
        .wait_with_output()
        .expect("collect concurrent-signal output");
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(stderr.matches("forwarded shutdown signal").count(), 1);
    assert!(!process_exists(child_id));
}

#[cfg(target_os = "macos")]
#[test]
fn escalates_when_the_official_cli_ignores_sigterm() {
    run_external_signal_case("TERM", 15, true);
}

#[cfg(target_os = "macos")]
#[test]
fn cleans_an_escaped_descendant_after_the_cli_root_exits() {
    let directory = temporary_directory();
    let ready = directory.join("ready");
    let mut shim = Command::new(shim_path())
        .env(STOCK_CODEX_PATH_ENV, fake_codex_path())
        .env("FAKE_CODEX_SPAWN_CHILD", "1")
        .env("FAKE_CODEX_ROOT_EXIT", "1")
        .env("FAKE_CODEX_CHILD_NEW_GROUP", "1")
        .env("FAKE_CODEX_READY_PATH", &ready)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn descendant-cleanup shim");
    let ready = wait_for_file(&ready, Duration::from_secs(5));
    let child_id = ready
        .lines()
        .find_map(|line| line.strip_prefix("child="))
        .expect("child identity")
        .parse::<u32>()
        .expect("child PID");

    let started = Instant::now();
    while shim.try_wait().expect("poll shim").is_none()
        && started.elapsed() < Duration::from_secs(6)
    {
        thread::sleep(Duration::from_millis(20));
    }
    if shim.try_wait().expect("final shim poll").is_none() {
        let _ = shim.kill();
        let _ = Command::new("/bin/kill")
            .args(["-KILL", &child_id.to_string()])
            .status();
        panic!("Shim did not clean escaped descendant");
    }
    let output = shim.wait_with_output().expect("collect descendant output");
    assert!(output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("terminated official CLI descendants after root exit")
    );
    assert!(
        !process_exists(child_id),
        "escaped descendant PID {child_id} survived"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn job_terminates_the_official_cli_tree_when_shim_is_killed() {
    let mut shim = Command::new(shim_path())
        .env(STOCK_CODEX_PATH_ENV, fake_codex_path())
        .env("FAKE_CODEX_SPAWN_CHILD", "1")
        .env("FAKE_CODEX_DELAY_MS", "60000")
        .env("FAKE_CODEX_CHILD_DELAY_MS", "60000")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn job-guarded shim");
    let shim_id = shim.id();
    let mut reader = BufReader::new(shim.stdout.take().expect("shim stdout"));
    let mut child_id_line = String::new();
    reader.read_line(&mut child_id_line).expect("read child id");
    let child_id = child_id_line.trim().parse::<u32>().expect("child id");
    assert!(process_exists(child_id));

    let status = Command::new("taskkill.exe")
        .args(["/PID", &shim_id.to_string(), "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("kill shim");
    assert!(status.success());
    let _ = shim.wait();

    let started = Instant::now();
    while process_exists(child_id) && started.elapsed() < Duration::from_secs(10) {
        thread::sleep(Duration::from_millis(100));
    }
    assert!(
        !process_exists(child_id),
        "kill-on-close Job left child PID {child_id} running"
    );
}
