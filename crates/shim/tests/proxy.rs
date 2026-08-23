use std::fs;
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
use std::fs::OpenOptions;
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

#[cfg(any(target_os = "macos", target_os = "linux"))]
use codexhost_platform::parent_process_id;
use codexhost_platform::{CODEX_CLI_PATH_ENV, STOCK_CODEX_PATH_ENV};
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
use codexhost_platform::{process_exists, process_snapshot};
use codexhost_shim::{HOST_NODE_PATH_ENV, HOST_RUNTIME_PATH_ENV, REMOTE_SSH_MANAGED_ENV};
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
use fs2::FileExt;

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
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("terminated by signal"),
        "unexpected crash status {:?} with stderr: {stderr}",
        output.status
    );
}

fn wait_for_file(path: &std::path::Path, timeout: Duration) -> String {
    wait_for_optional_file(path, timeout)
        .unwrap_or_else(|| panic!("timed out waiting for {}", path.display()))
}

fn wait_for_optional_file(path: &std::path::Path, timeout: Duration) -> Option<String> {
    let started = Instant::now();
    loop {
        if let Ok(contents) = fs::read_to_string(path) {
            return Some(contents);
        }
        if started.elapsed() >= timeout {
            return None;
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn wait_for_child_file_matching(
    child: &mut process::Child,
    path: &std::path::Path,
    data_directory: &std::path::Path,
    timeout: Duration,
    description: &str,
    matches: impl Fn(&str) -> bool,
) -> String {
    let started = Instant::now();
    let mut last_contents = None;
    loop {
        if let Ok(contents) = fs::read_to_string(path) {
            if matches(&contents) {
                return contents;
            }
            last_contents = Some(contents);
        }
        if let Some(status) = child.try_wait().expect("poll Host Runtime Shim") {
            let mut stderr = Vec::new();
            if let Some(mut stream) = child.stderr.take() {
                stream
                    .read_to_end(&mut stderr)
                    .expect("read exited Host Runtime Shim stderr");
            }
            let owner_record = fs::read_to_string(
                data_directory
                    .join("local-host-runtime-owner-v1")
                    .join("owner"),
            )
            .ok();
            panic!(
                "{description}: Shim PID {} exited with {status}; stderr={}; owner_record={owner_record:?}; observed_file={last_contents:?}",
                child.id(),
                String::from_utf8_lossy(&stderr),
            );
        }
        if started.elapsed() >= timeout {
            let owner_record = fs::read_to_string(
                data_directory
                    .join("local-host-runtime-owner-v1")
                    .join("owner"),
            )
            .ok();
            panic!(
                "{description}: timed out after {timeout:?} while Shim PID {} remained live; owner_record={owner_record:?}; observed_file={last_contents:?}",
                child.id(),
            );
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn wait_for_complete_owner_record(
    child: &mut process::Child,
    data_directory: &std::path::Path,
    timeout: Duration,
) -> String {
    let owner_record = data_directory
        .join("local-host-runtime-owner-v1")
        .join("owner");
    wait_for_child_file_matching(
        child,
        &owner_record,
        data_directory,
        timeout,
        "local Host Runtime owner publication failed",
        |contents| {
            contents.lines().any(|line| {
                line.strip_prefix("child_process_started_at_micros=")
                    .is_some_and(|value| !value.is_empty())
            })
        },
    )
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn process_id_from_ready(contents: &str, label: &str) -> u32 {
    contents
        .lines()
        .find_map(|line| line.strip_prefix(label))
        .expect("ready process identity field")
        .parse::<u32>()
        .expect("ready process identity PID")
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn host_runtime_shim(directory: &std::path::Path, ready: &std::path::Path) -> process::Child {
    Command::new(shim_path())
        .args(["app-server", "--stdio"])
        .env(STOCK_CODEX_PATH_ENV, fake_codex_path())
        .env(HOST_NODE_PATH_ENV, fake_codex_path())
        .env(HOST_RUNTIME_PATH_ENV, fake_codex_path())
        .env("CODEXHOST_DATA_DIR", directory)
        .env("FAKE_CODEX_HOST_RUNTIME_READY", ready)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn fake Host Runtime Shim")
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn legacy_host_runtime_shim(
    directory: &std::path::Path,
    ready: &std::path::Path,
    runtime: &std::path::Path,
) -> process::Child {
    Command::new(shim_path())
        .args(["app-server", "--stdio"])
        .env_remove(HOST_NODE_PATH_ENV)
        .env_remove(HOST_RUNTIME_PATH_ENV)
        .env(STOCK_CODEX_PATH_ENV, runtime)
        .env("CODEXHOST_DATA_DIR", directory)
        .env("FAKE_CODEX_HOST_RUNTIME_READY", ready)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn legacy fake Host Runtime Shim")
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn desktop_owned_shim(
    directory: &std::path::Path,
    launcher_ready: &std::path::Path,
    runtime_ready: &std::path::Path,
    runtime: &std::path::Path,
    configured_host_runtime: bool,
) -> process::Child {
    let mut command = Command::new(fake_codex_path());
    command
        .env("FAKE_CODEX_ORPHAN_SHIM", shim_path())
        .env("FAKE_CODEX_ORPHAN_RUNTIME", runtime)
        .env("FAKE_CODEX_ORPHAN_DATA_DIR", directory)
        .env("FAKE_CODEX_ORPHAN_RUNTIME_READY", runtime_ready)
        .env("FAKE_CODEX_ORPHAN_LAUNCHER_READY", launcher_ready)
        .env("FAKE_CODEX_ORPHAN_KEEP_DESKTOP", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if configured_host_runtime {
        command.env("FAKE_CODEX_ORPHAN_USE_HOST_RUNTIME", "1");
    }
    command.spawn().expect("start fake live Desktop")
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn force_stop_test_process(process_id: u32) {
    #[cfg(target_os = "windows")]
    let _ = Command::new("taskkill.exe")
        .args(["/PID", &process_id.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let _ = Command::new("/bin/kill")
        .args(["-KILL", &process_id.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn wait_for_process_exit(child: &mut process::Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while child.try_wait().expect("poll test process").is_none() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    child.try_wait().expect("final test process poll").is_some()
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn wait_for_process_id_exit(process_id: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while process_exists(process_id) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    !process_exists(process_id)
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
#[test]
fn hands_off_local_host_runtime_ownership_and_converges_on_stdin_eof() {
    let directory = temporary_directory();
    let first_ready = directory.join("first-ready");
    let second_ready = directory.join("second-ready");
    let mut first = host_runtime_shim(&directory, &first_ready);
    let first_stdin = first.stdin.take().expect("first Host Runtime stdin");
    let first_identity = wait_for_file(&first_ready, Duration::from_secs(5));
    let first_root = process_id_from_ready(&first_identity, "root=");

    // Child readiness is written by the fake Host Runtime before the Shim atomically publishes
    // that child's process-instance identity. Start the handoff clock only after publication has
    // completed and the mutation lock is released; startup scheduling is not part of the bounded
    // production handoff window tested below.
    let _ = wait_for_complete_owner_record(&mut first, &directory, Duration::from_secs(10));

    let mut second = host_runtime_shim(&directory, &second_ready);
    let second_stdin = second.stdin.take().expect("second Host Runtime stdin");
    // Reap the old direct child before waiting for the replacement to publish readiness. Linux
    // reports an unreaped child as an existing PID, so reversing these waits deadlocks the fixture.
    if !wait_for_process_exit(&mut first, Duration::from_secs(5)) {
        force_stop_test_process(first.id());
        force_stop_test_process(first_root);
        force_stop_test_process(second.id());
        if let Some(identity) = wait_for_optional_file(&second_ready, Duration::from_secs(1)) {
            force_stop_test_process(process_id_from_ready(&identity, "root="));
        }
        let _ = first.wait();
        let _ = second.wait();
        fs::remove_dir_all(&directory).expect("remove failed handoff fixture");
        panic!("replacement Host Runtime did not retire the previous Shim");
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use std::os::unix::process::ExitStatusExt;

        let status = first.wait().expect("read retired owner Shim status");
        assert_ne!(
            status.signal(),
            Some(nix::sys::signal::Signal::SIGKILL as i32),
            "ownership handoff forced the previous Shim instead of allowing graceful exit"
        );
    }
    drop(first_stdin);
    assert!(
        wait_for_process_id_exit(first_root, Duration::from_secs(5)),
        "previous Host Runtime PID {first_root} survived ownership handoff"
    );
    // A replacement can consume both the graceful and forced production handoff windows before
    // it launches its Host Runtime. Keep enough scheduling margin around that bounded takeover.
    let second_identity = wait_for_child_file_matching(
        &mut second,
        &second_ready,
        &directory,
        Duration::from_secs(10),
        "replacement Host Runtime readiness failed",
        |_| true,
    );
    let second_root = process_id_from_ready(&second_identity, "root=");

    drop(second_stdin);
    if !wait_for_process_exit(&mut second, Duration::from_secs(5)) {
        force_stop_test_process(second.id());
        force_stop_test_process(second_root);
        let _ = second.wait();
        fs::remove_dir_all(&directory).expect("remove failed EOF fixture");
        panic!("Host Runtime Shim did not converge after Desktop stdin EOF");
    }
    assert!(
        wait_for_process_id_exit(second_root, Duration::from_secs(5)),
        "Host Runtime PID {second_root} survived Desktop stdin EOF"
    );
    fs::remove_dir_all(directory).expect("remove Host Runtime handoff fixture");
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
#[test]
fn replacement_waits_for_the_local_runtime_owner_mutation_lock() {
    let directory = temporary_directory();
    let owner_ready = directory.join("owner-ready");
    let replacement_ready = directory.join("replacement-ready");
    let mut owner = host_runtime_shim(&directory, &owner_ready);
    let owner_stdin = owner.stdin.take().expect("owner Host Runtime stdin");
    let owner_root = process_id_from_ready(
        &wait_for_file(&owner_ready, Duration::from_secs(5)),
        "root=",
    );

    let owner_lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("local-host-runtime-owner.lock"))
        .expect("open local Host Runtime owner mutation lock");
    owner_lock
        .lock_exclusive()
        .expect("hold local Host Runtime owner mutation lock");

    let mut replacement = host_runtime_shim(&directory, &replacement_ready);
    let replacement_stdin = replacement
        .stdin
        .take()
        .expect("replacement Host Runtime stdin");
    thread::sleep(Duration::from_millis(300));
    let owner_was_untouched =
        process_exists(owner.id()) && process_exists(owner_root) && !replacement_ready.exists();
    FileExt::unlock(&owner_lock).expect("release local Host Runtime owner mutation lock");

    if !wait_for_process_exit(&mut owner, Duration::from_secs(5)) {
        force_stop_test_process(owner.id());
        force_stop_test_process(owner_root);
        force_stop_test_process(replacement.id());
        let _ = owner.wait();
        let _ = replacement.wait();
        let _ = fs::remove_dir_all(&directory);
        panic!("replacement Host Runtime did not retire the owner after lock release");
    }
    drop(owner_stdin);
    let replacement_identity = wait_for_file(&replacement_ready, Duration::from_secs(5));
    let replacement_root = process_id_from_ready(&replacement_identity, "root=");
    drop(replacement_stdin);
    if !wait_for_process_exit(&mut replacement, Duration::from_secs(5)) {
        force_stop_test_process(replacement.id());
        force_stop_test_process(replacement_root);
        let _ = replacement.wait();
        let _ = fs::remove_dir_all(&directory);
        panic!("replacement Host Runtime did not converge after Desktop stdin EOF");
    }
    fs::remove_dir_all(directory).expect("remove owner mutation lock fixture");

    assert!(
        owner_was_untouched,
        "replacement observed or changed local Host Runtime ownership while the mutation lock was held"
    );
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
#[test]
fn migrates_a_live_version_one_owner_before_starting_a_replacement() {
    let directory = temporary_directory();
    let owner_ready = directory.join("owner-ready");
    let replacement_ready = directory.join("replacement-ready");
    let mut owner = host_runtime_shim(&directory, &owner_ready);
    let owner_stdin = owner.stdin.take().expect("owner Host Runtime stdin");
    let owner_root = process_id_from_ready(
        &wait_for_file(&owner_ready, Duration::from_secs(5)),
        "root=",
    );

    let owner_record = directory.join("local-host-runtime-owner-v1").join("owner");
    let contents = wait_for_complete_owner_record(&mut owner, &directory, Duration::from_secs(10));
    let field = |name: &str| {
        contents
            .lines()
            .find_map(|line| line.strip_prefix(&format!("{name}=")))
            .unwrap_or_else(|| panic!("owner record omitted {name}"))
    };
    fs::write(
        &owner_record,
        format!(
            "version=1\nprocess_id={}\ndesktop_process_id={}\nchild_process_id={}\n",
            field("process_id"),
            field("desktop_process_id"),
            field("child_process_id"),
        ),
    )
    .expect("publish version-one owner record");

    let mut replacement = host_runtime_shim(&directory, &replacement_ready);
    let replacement_stdin = replacement
        .stdin
        .take()
        .expect("replacement Host Runtime stdin");
    let replacement_identity = wait_for_file(&replacement_ready, Duration::from_secs(5));
    let replacement_root = process_id_from_ready(&replacement_identity, "root=");
    let owner_was_retired = wait_for_process_exit(&mut owner, Duration::from_secs(2));

    drop(owner_stdin);
    if !owner_was_retired {
        force_stop_test_process(owner.id());
        force_stop_test_process(owner_root);
        let _ = owner.wait();
    }
    drop(replacement_stdin);
    if !wait_for_process_exit(&mut replacement, Duration::from_secs(5)) {
        force_stop_test_process(replacement.id());
        force_stop_test_process(replacement_root);
        let _ = replacement.wait();
        let _ = fs::remove_dir_all(&directory);
        panic!("replacement Host Runtime did not converge after legacy owner migration");
    }
    let _ = fs::remove_dir_all(&directory);

    assert!(
        owner_was_retired && !process_exists(owner_root),
        "replacement started without retiring the live version-one owner"
    );
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
#[test]
fn waits_for_a_version_one_owner_to_publish_its_child_before_migration() {
    let directory = temporary_directory();
    let owner_ready = directory.join("owner-ready");
    let replacement_ready = directory.join("replacement-ready");
    let mut owner = host_runtime_shim(&directory, &owner_ready);
    let owner_stdin = owner.stdin.take().expect("owner Host Runtime stdin");
    let owner_root = process_id_from_ready(
        &wait_for_file(&owner_ready, Duration::from_secs(5)),
        "root=",
    );

    let owner_record = directory.join("local-host-runtime-owner-v1").join("owner");
    let contents = wait_for_complete_owner_record(&mut owner, &directory, Duration::from_secs(10));
    let field = |name: &str| {
        contents
            .lines()
            .find_map(|line| line.strip_prefix(&format!("{name}=")))
            .unwrap_or_else(|| panic!("owner record omitted {name}"))
    };
    let version_one_without_child = format!(
        "version=1\nprocess_id={}\ndesktop_process_id={}\nchild_process_id=\n",
        field("process_id"),
        field("desktop_process_id"),
    );
    fs::write(&owner_record, &version_one_without_child)
        .expect("publish starting version-one owner record");

    let mut replacement = host_runtime_shim(&directory, &replacement_ready);
    let replacement_stdin = replacement
        .stdin
        .take()
        .expect("replacement Host Runtime stdin");
    let owner_lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("local-host-runtime-owner.lock"))
        .expect("open local Host Runtime owner mutation lock");
    let deadline = Instant::now() + Duration::from_secs(5);
    let replacement_holds_lock = loop {
        match owner_lock.try_lock_exclusive() {
            Ok(()) => {
                FileExt::unlock(&owner_lock).expect("release owner mutation lock probe");
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || (cfg!(target_os = "windows") && error.raw_os_error() == Some(33)) =>
            {
                break true;
            }
            Err(error) => panic!("probe local Host Runtime owner mutation lock: {error}"),
        }
        if Instant::now() >= deadline {
            break false;
        }
        thread::sleep(Duration::from_millis(20));
    };
    thread::sleep(Duration::from_millis(100));
    let observed_record = fs::read_to_string(&owner_record).ok();
    let owner_is_live = process_exists(owner.id());
    let owner_child_is_live = process_exists(owner_root);
    let replacement_is_ready = replacement_ready.exists();
    let replacement_waited_for_child = observed_record.as_deref()
        == Some(version_one_without_child.as_str())
        && owner_is_live
        && owner_child_is_live
        && !replacement_is_ready;
    if replacement_waited_for_child {
        fs::write(
            &owner_record,
            format!(
                "version=1\nprocess_id={}\ndesktop_process_id={}\nchild_process_id={owner_root}\n",
                field("process_id"),
                field("desktop_process_id"),
            ),
        )
        .expect("publish completed version-one owner record");
    }

    let replacement_identity = wait_for_optional_file(&replacement_ready, Duration::from_secs(5));
    let replacement_root = replacement_identity
        .as_deref()
        .map(|identity| process_id_from_ready(identity, "root="));
    let owner_was_retired = wait_for_process_exit(&mut owner, Duration::from_secs(2));

    drop(owner_stdin);
    if !owner_was_retired {
        force_stop_test_process(owner.id());
        force_stop_test_process(owner_root);
        let _ = owner.wait();
    }
    drop(replacement_stdin);
    if !wait_for_process_exit(&mut replacement, Duration::from_secs(5)) {
        force_stop_test_process(replacement.id());
        if let Some(replacement_root) = replacement_root {
            force_stop_test_process(replacement_root);
        }
        let _ = replacement.wait();
    }
    let _ = fs::remove_dir_all(&directory);

    assert!(
        replacement_holds_lock,
        "replacement did not acquire the local Host Runtime owner mutation lock"
    );
    assert!(
        replacement_waited_for_child,
        "replacement migrated or signalled a version-one owner before its child identity was published: record={observed_record:?}, owner_live={owner_is_live}, child_live={owner_child_is_live}, replacement_ready={replacement_is_ready}"
    );
    assert!(
        replacement_identity.is_some() && owner_was_retired && !process_exists(owner_root),
        "replacement did not retire the completed version-one owner and its child"
    );
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
#[test]
fn rejects_a_childless_version_one_owner_whose_process_id_was_reused() {
    let directory = temporary_directory();
    let owner_directory = directory.join("local-host-runtime-owner-v1");
    let replacement_ready = directory.join("replacement-ready");
    fs::create_dir(&owner_directory).expect("create version-one owner directory");

    let mut unrelated = Command::new(fake_codex_path())
        .env("FAKE_CODEX_DELAY_MS", "60000")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn unrelated reused-PID fixture");
    fs::write(
        owner_directory.join("owner"),
        format!(
            "version=1\nprocess_id={}\ndesktop_process_id={}\nchild_process_id=\n",
            unrelated.id(),
            process::id(),
        ),
    )
    .expect("publish childless version-one owner record");

    let mut replacement = host_runtime_shim(&directory, &replacement_ready);
    let replacement_stdin = replacement
        .stdin
        .take()
        .expect("replacement Host Runtime stdin");
    let replacement_identity = wait_for_optional_file(&replacement_ready, Duration::from_secs(2));
    let unrelated_was_not_signalled = unrelated
        .try_wait()
        .expect("poll unrelated reused-PID fixture")
        .is_none();

    force_stop_test_process(unrelated.id());
    let _ = unrelated.wait();
    drop(replacement_stdin);
    if !wait_for_process_exit(&mut replacement, Duration::from_secs(5)) {
        force_stop_test_process(replacement.id());
        if let Some(identity) = replacement_identity.as_deref() {
            force_stop_test_process(process_id_from_ready(identity, "root="));
        }
        let _ = replacement.wait();
    }
    let _ = fs::remove_dir_all(&directory);

    assert!(
        replacement_identity.is_some(),
        "replacement waited on an unrelated process that reused a childless version-one owner PID"
    );
    assert!(
        unrelated_was_not_signalled,
        "replacement signalled an unrelated process that reused a version-one owner PID"
    );
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
#[test]
fn discards_a_childless_version_one_owner_that_names_the_current_shim() {
    let directory = temporary_directory();
    let owner_directory = directory.join("local-host-runtime-owner-v1");
    let replacement_ready = directory.join("replacement-ready");
    let owner_lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("local-host-runtime-owner.lock"))
        .expect("open local Host Runtime owner mutation lock");
    owner_lock
        .lock_exclusive()
        .expect("hold local Host Runtime owner mutation lock");

    let mut replacement = host_runtime_shim(&directory, &replacement_ready);
    let replacement_stdin = replacement
        .stdin
        .take()
        .expect("replacement Host Runtime stdin");
    fs::create_dir(&owner_directory).expect("create stale version-one owner directory");
    fs::write(
        owner_directory.join("owner"),
        format!(
            "version=1\nprocess_id={}\ndesktop_process_id={}\nchild_process_id=\n",
            replacement.id(),
            process::id(),
        ),
    )
    .expect("publish childless version-one self owner record");
    FileExt::unlock(&owner_lock).expect("release local Host Runtime owner mutation lock");

    let replacement_identity = wait_for_optional_file(&replacement_ready, Duration::from_secs(2));
    drop(replacement_stdin);
    if !wait_for_process_exit(&mut replacement, Duration::from_secs(1)) {
        force_stop_test_process(replacement.id());
        if let Some(identity) = replacement_identity.as_deref() {
            force_stop_test_process(process_id_from_ready(identity, "root="));
        }
        let _ = replacement.wait();
    }
    let _ = fs::remove_dir_all(&directory);

    assert!(
        replacement_identity.is_some(),
        "replacement waited on the childless version-one record that named its own Shim PID"
    );
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn refuses_version_one_takeover_when_the_recorded_child_outlives_its_shim() {
    let directory = temporary_directory();
    let owner_ready = directory.join("owner-ready");
    let replacement_ready = directory.join("replacement-ready");
    let mut owner = host_runtime_shim(&directory, &owner_ready);
    let owner_stdin = owner.stdin.take().expect("owner Host Runtime stdin");
    let owner_root = process_id_from_ready(
        &wait_for_file(&owner_ready, Duration::from_secs(5)),
        "root=",
    );
    let owner_record = directory.join("local-host-runtime-owner-v1").join("owner");
    let contents = wait_for_file(&owner_record, Duration::from_secs(5));
    let field = |name: &str| {
        contents
            .lines()
            .find_map(|line| line.strip_prefix(&format!("{name}=")))
            .unwrap_or_else(|| panic!("owner record omitted {name}"))
    };
    fs::write(
        &owner_record,
        format!(
            "version=1\nprocess_id={}\ndesktop_process_id={}\nchild_process_id={owner_root}\n",
            field("process_id"),
            field("desktop_process_id"),
        ),
    )
    .expect("publish version-one owner record");

    force_stop_test_process(owner.id());
    assert!(
        wait_for_process_exit(&mut owner, Duration::from_secs(5)),
        "version-one owner Shim did not exit"
    );
    drop(owner_stdin);
    let reparent_deadline = Instant::now() + Duration::from_secs(5);
    while parent_process_id(owner_root).ok().flatten() == Some(owner.id())
        && Instant::now() < reparent_deadline
    {
        thread::sleep(Duration::from_millis(20));
    }
    assert!(
        process_exists(owner_root),
        "recorded Host Runtime child exited"
    );

    let mut replacement = host_runtime_shim(&directory, &replacement_ready);
    let replacement_stdin = replacement
        .stdin
        .take()
        .expect("replacement Host Runtime stdin");
    let replacement_identity = wait_for_optional_file(&replacement_ready, Duration::from_secs(2));
    let recorded_child_survived = process_exists(owner_root);

    drop(replacement_stdin);
    if !wait_for_process_exit(&mut replacement, Duration::from_secs(2)) {
        force_stop_test_process(replacement.id());
        if let Some(identity) = replacement_identity.as_deref() {
            force_stop_test_process(process_id_from_ready(identity, "root="));
        }
        let _ = replacement.wait();
    }
    force_stop_test_process(owner_root);
    let _ = fs::remove_dir_all(&directory);

    assert!(
        replacement_identity.is_none(),
        "replacement started while a version-one owner's reparented child remained live"
    );
    assert!(
        recorded_child_survived,
        "replacement signalled a version-one child without a verified process-instance identity"
    );
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
#[test]
fn retires_an_exact_owner_child_after_its_shim_exits() {
    let directory = temporary_directory();
    let fixture_directory = temporary_directory();
    let owner_ready = directory.join("owner-ready");
    let fixture_ready = fixture_directory.join("fixture-ready");
    let replacement_ready = directory.join("replacement-ready");

    let mut owner = host_runtime_shim(&directory, &owner_ready);
    let owner_stdin = owner.stdin.take().expect("owner Host Runtime stdin");
    wait_for_file(&owner_ready, Duration::from_secs(5));
    let owner_contents =
        wait_for_complete_owner_record(&mut owner, &directory, Duration::from_secs(10));

    // Keep an independently owned Host Runtime alive so this exact-child fixture also works on
    // Windows, where killing a Shim normally closes its Job and retires its own process tree.
    let mut fixture = host_runtime_shim(&fixture_directory, &fixture_ready);
    let fixture_stdin = fixture.stdin.take().expect("fixture Host Runtime stdin");
    let fixture_root = process_id_from_ready(
        &wait_for_file(&fixture_ready, Duration::from_secs(5)),
        "root=",
    );
    let fixture_contents =
        wait_for_complete_owner_record(&mut fixture, &fixture_directory, Duration::from_secs(10));
    let fixture_child_started_at_micros = fixture_contents
        .lines()
        .find_map(|line| line.strip_prefix("child_process_started_at_micros="))
        .filter(|value| !value.is_empty())
        .expect("fixture child start identity");
    let mut reused_desktop_process = Command::new(fake_codex_path())
        .env("FAKE_CODEX_DELAY_MS", "60000")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn reused Desktop PID fixture");

    force_stop_test_process(owner.id());
    assert!(
        wait_for_process_exit(&mut owner, Duration::from_secs(5)),
        "exact owner Shim did not exit"
    );
    drop(owner_stdin);

    let owner_record = directory.join("local-host-runtime-owner-v1").join("owner");
    let orphaned_exact_owner = owner_contents
        .lines()
        .map(|line| {
            if line.starts_with("child_process_id=") {
                format!("child_process_id={fixture_root}")
            } else if line.starts_with("child_process_started_at_micros=") {
                format!("child_process_started_at_micros={fixture_child_started_at_micros}")
            } else if line.starts_with("desktop_process_id=") {
                format!("desktop_process_id={}", reused_desktop_process.id())
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&owner_record, format!("{orphaned_exact_owner}\n"))
        .expect("publish orphaned exact owner record");
    assert!(
        process_exists(fixture_root),
        "exact child fixture exited before replacement"
    );

    let mut replacement = host_runtime_shim(&directory, &replacement_ready);
    let replacement_stdin = replacement
        .stdin
        .take()
        .expect("replacement Host Runtime stdin");
    let replacement_identity = wait_for_optional_file(&replacement_ready, Duration::from_secs(2));
    let replacement_root = replacement_identity
        .as_deref()
        .map(|identity| process_id_from_ready(identity, "root="));
    let orphaned_child_was_retired = !process_exists(fixture_root);
    let reused_desktop_was_not_signalled = reused_desktop_process
        .try_wait()
        .expect("poll reused Desktop PID fixture")
        .is_none();

    drop(replacement_stdin);
    if !wait_for_process_exit(&mut replacement, Duration::from_secs(5)) {
        force_stop_test_process(replacement.id());
        if let Some(replacement_root) = replacement_root {
            force_stop_test_process(replacement_root);
        }
        let _ = replacement.wait();
    }
    drop(fixture_stdin);
    if !wait_for_process_exit(&mut fixture, Duration::from_secs(5)) {
        force_stop_test_process(fixture.id());
        force_stop_test_process(fixture_root);
        let _ = fixture.wait();
    }
    force_stop_test_process(reused_desktop_process.id());
    let _ = reused_desktop_process.wait();
    let _ = fs::remove_dir_all(&directory);
    let _ = fs::remove_dir_all(&fixture_directory);

    assert!(
        replacement_identity.is_some(),
        "replacement trusted a stale PID-only Desktop identity after the exact owner Shim exited"
    );
    assert!(
        reused_desktop_was_not_signalled,
        "replacement signalled the unrelated process that reused the recorded Desktop PID"
    );
    assert!(
        orphaned_child_was_retired,
        "replacement started without retiring the exact child whose recorded Shim had exited"
    );
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
#[test]
fn replacement_does_not_signal_a_reused_owner_process_id() {
    let directory = temporary_directory();
    let owner_ready = directory.join("owner-ready");
    let replacement_ready = directory.join("replacement-ready");
    let mut owner = host_runtime_shim(&directory, &owner_ready);
    let owner_stdin = owner.stdin.take().expect("owner Host Runtime stdin");
    let owner_root = process_id_from_ready(
        &wait_for_file(&owner_ready, Duration::from_secs(5)),
        "root=",
    );
    let mut reused_owner_process = Command::new(fake_codex_path())
        .env("FAKE_CODEX_DELAY_MS", "60000")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn reused owner PID fixture");

    let owner_record = directory.join("local-host-runtime-owner-v1").join("owner");
    let contents = wait_for_complete_owner_record(&mut owner, &directory, Duration::from_secs(10));
    let old_exact_child_started_at_micros = contents
        .lines()
        .find_map(|line| line.strip_prefix("child_process_started_at_micros="))
        .expect("recorded child start identity")
        .parse::<u64>()
        .expect("recorded child start identity micros");
    let recycled = contents
        .lines()
        .map(|line| {
            if line.starts_with("process_id=") {
                format!("process_id={}", reused_owner_process.id())
            } else if line.starts_with("process_started_at_micros=") {
                "process_started_at_micros=18446744073709551615".to_owned()
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>();
    fs::write(&owner_record, format!("{}\n", recycled.join("\n")))
        .expect("publish recycled owner process identity");

    let mut replacement = host_runtime_shim(&directory, &replacement_ready);
    let replacement_stdin = replacement
        .stdin
        .take()
        .expect("replacement Host Runtime stdin");
    let replacement_identity = wait_for_file(&replacement_ready, Duration::from_secs(5));
    let replacement_root = process_id_from_ready(&replacement_identity, "root=");
    let reused_process_was_not_signalled = reused_owner_process
        .try_wait()
        .expect("poll reused owner PID fixture")
        .is_none();
    // Linux keeps a killed child PID visible to kill(2) while its parent is about to reap the
    // zombie, even though /proc/<pid>/exe is already gone. Match the production lease's exact
    // process-instance semantics instead of treating that transient zombie as a live runtime.
    let old_exact_child_was_retired = !process_snapshot(owner_root)
        .is_ok_and(|snapshot| snapshot.started_at_micros == old_exact_child_started_at_micros);

    drop(owner_stdin);
    if !wait_for_process_exit(&mut owner, Duration::from_secs(5)) {
        force_stop_test_process(owner.id());
        force_stop_test_process(owner_root);
        let _ = owner.wait();
    }
    drop(replacement_stdin);
    if !wait_for_process_exit(&mut replacement, Duration::from_secs(5)) {
        force_stop_test_process(replacement.id());
        force_stop_test_process(replacement_root);
        let _ = replacement.wait();
        let _ = fs::remove_dir_all(&directory);
        panic!("replacement Host Runtime did not converge after recycled owner recovery");
    }
    force_stop_test_process(reused_owner_process.id());
    let _ = reused_owner_process.wait();
    fs::remove_dir_all(directory).expect("remove recycled owner fixture");

    assert!(
        reused_process_was_not_signalled,
        "replacement signalled a live process whose PID no longer matched the recorded owner instance"
    );
    assert!(
        old_exact_child_was_retired,
        "replacement started without retiring the exact child after its Shim PID was reused"
    );
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
#[test]
fn replacement_does_not_signal_an_exact_owner_with_a_mismatched_executable() {
    let directory = temporary_directory();
    let owner_ready = directory.join("owner-ready");
    let replacement_ready = directory.join("replacement-ready");
    let mut owner = host_runtime_shim(&directory, &owner_ready);
    let owner_stdin = owner.stdin.take().expect("owner Host Runtime stdin");
    let owner_root = process_id_from_ready(
        &wait_for_file(&owner_ready, Duration::from_secs(5)),
        "root=",
    );
    let owner_contents =
        wait_for_complete_owner_record(&mut owner, &directory, Duration::from_secs(10));

    let mut mismatched_process = Command::new(fake_codex_path())
        .env("FAKE_CODEX_DELAY_MS", "60000")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn mismatched owner executable fixture");
    let mismatched_snapshot =
        process_snapshot(mismatched_process.id()).expect("snapshot mismatched owner executable");
    let mismatched_owner = owner_contents
        .lines()
        .map(|line| {
            if line.starts_with("process_id=") {
                format!("process_id={}", mismatched_process.id())
            } else if line.starts_with("process_started_at_micros=") {
                format!(
                    "process_started_at_micros={}",
                    mismatched_snapshot.started_at_micros
                )
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(
        directory.join("local-host-runtime-owner-v1").join("owner"),
        format!("{mismatched_owner}\n"),
    )
    .expect("publish mismatched owner executable record");

    let mut replacement = host_runtime_shim(&directory, &replacement_ready);
    let replacement_stdin = replacement
        .stdin
        .take()
        .expect("replacement Host Runtime stdin");
    let replacement_identity = wait_for_file(&replacement_ready, Duration::from_secs(5));
    let replacement_root = process_id_from_ready(&replacement_identity, "root=");
    let mismatched_process_was_not_signalled = mismatched_process
        .try_wait()
        .expect("poll mismatched owner executable")
        .is_none();
    let claimed_child_was_not_signalled = process_exists(owner_root);

    drop(owner_stdin);
    if !wait_for_process_exit(&mut owner, Duration::from_secs(5)) {
        force_stop_test_process(owner.id());
        force_stop_test_process(owner_root);
        let _ = owner.wait();
    }
    drop(replacement_stdin);
    if !wait_for_process_exit(&mut replacement, Duration::from_secs(5)) {
        force_stop_test_process(replacement.id());
        force_stop_test_process(replacement_root);
        let _ = replacement.wait();
    }
    force_stop_test_process(mismatched_process.id());
    let _ = mismatched_process.wait();
    fs::remove_dir_all(directory).expect("remove mismatched executable fixture");

    assert!(
        mismatched_process_was_not_signalled,
        "replacement signalled a live exact owner whose executable was not codexhost"
    );
    assert!(
        claimed_child_was_not_signalled,
        "replacement trusted and signalled the child claimed by a mismatched executable"
    );
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
#[test]
fn refuses_handoff_from_another_live_desktop() {
    let directory = temporary_directory();
    let owner_ready = directory.join("owner-ready");
    let launcher_ready = directory.join("launcher-ready");
    let replacement_ready = directory.join("replacement-ready");
    let mut owner = host_runtime_shim(&directory, &owner_ready);
    let owner_stdin = owner.stdin.take().expect("owner Host Runtime stdin");
    let owner_root = process_id_from_ready(
        &wait_for_file(&owner_ready, Duration::from_secs(5)),
        "root=",
    );

    let mut desktop = desktop_owned_shim(
        &directory,
        &launcher_ready,
        &replacement_ready,
        &fake_codex_path(),
        true,
    );
    let desktop_stdin = desktop.stdin.take().expect("fake Desktop stdin");
    let replacement_shim = process_id_from_ready(
        &wait_for_file(&launcher_ready, Duration::from_secs(5)),
        "shim=",
    );
    assert!(
        wait_for_process_id_exit(replacement_shim, Duration::from_secs(5)),
        "replacement Shim did not refuse another live Desktop owner"
    );
    assert!(!replacement_ready.exists());
    assert!(
        process_exists(owner.id()) && process_exists(owner_root),
        "another live Desktop's Shim or Host Runtime was terminated"
    );

    drop(owner_stdin);
    assert!(wait_for_process_exit(&mut owner, Duration::from_secs(5)));
    drop(desktop_stdin);
    assert!(wait_for_process_exit(&mut desktop, Duration::from_secs(5)));
    fs::remove_dir_all(directory).expect("remove live Desktop owner fixture");
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
#[test]
fn retires_a_legacy_runtime_from_its_mapping_store_lock() {
    let directory = temporary_directory();
    let legacy_ready = directory.join("legacy-ready");
    let replacement_ready = directory.join("replacement-ready");
    let legacy_runtime = directory.join(if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    });
    fs::copy(fake_codex_path(), &legacy_runtime).expect("copy legacy fake Node runtime");

    let mut legacy = legacy_host_runtime_shim(&directory, &legacy_ready, &legacy_runtime);
    let legacy_stdin = legacy.stdin.take().expect("legacy Host Runtime stdin");
    let legacy_identity = wait_for_file(&legacy_ready, Duration::from_secs(5));
    let legacy_root = process_id_from_ready(&legacy_identity, "root=");
    let mapping_store = directory.join("mapping-store");
    fs::create_dir(&mapping_store).expect("create legacy Mapping Store directory");
    fs::write(
        mapping_store.join("store.lock"),
        format!("{{\"pid\":{legacy_root},\"instanceId\":\"legacy\"}}\n"),
    )
    .expect("write legacy Mapping Store lock");

    let mut replacement = host_runtime_shim(&directory, &replacement_ready);
    let replacement_stdin = replacement
        .stdin
        .take()
        .expect("replacement Host Runtime stdin");
    // See the local-owner handoff above: the fixture parent must reap its old direct child before
    // the replacement can finish validating that the legacy owner has disappeared on Linux.
    if !wait_for_process_exit(&mut legacy, Duration::from_secs(5)) {
        force_stop_test_process(legacy.id());
        force_stop_test_process(legacy_root);
        force_stop_test_process(replacement.id());
        if let Some(identity) = wait_for_optional_file(&replacement_ready, Duration::from_secs(1)) {
            force_stop_test_process(process_id_from_ready(&identity, "root="));
        }
        let _ = legacy.wait();
        let _ = replacement.wait();
        fs::remove_dir_all(&directory).expect("remove failed legacy handoff fixture");
        panic!("replacement Host Runtime did not retire the legacy Shim");
    }
    drop(legacy_stdin);
    assert!(
        wait_for_process_id_exit(legacy_root, Duration::from_secs(5)),
        "legacy Host Runtime PID {legacy_root} survived ownership migration"
    );
    let replacement_identity = wait_for_file(&replacement_ready, Duration::from_secs(5));
    let replacement_root = process_id_from_ready(&replacement_identity, "root=");

    drop(replacement_stdin);
    if !wait_for_process_exit(&mut replacement, Duration::from_secs(5)) {
        force_stop_test_process(replacement.id());
        force_stop_test_process(replacement_root);
        let _ = replacement.wait();
        fs::remove_dir_all(&directory).expect("remove failed legacy replacement fixture");
        panic!("replacement Host Runtime did not converge after Desktop stdin EOF");
    }
    fs::remove_dir_all(directory).expect("remove legacy Host Runtime fixture");
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
#[test]
fn refuses_legacy_migration_from_another_live_desktop() {
    let directory = temporary_directory();
    let launcher_ready = directory.join("launcher-ready");
    let legacy_ready = directory.join("legacy-ready");
    let replacement_ready = directory.join("replacement-ready");
    let legacy_runtime = directory.join(if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    });
    fs::copy(fake_codex_path(), &legacy_runtime).expect("copy live legacy fake Node runtime");

    let mut desktop = desktop_owned_shim(
        &directory,
        &launcher_ready,
        &legacy_ready,
        &legacy_runtime,
        false,
    );
    let desktop_stdin = desktop.stdin.take().expect("fake Desktop stdin");
    let legacy_shim = process_id_from_ready(
        &wait_for_file(&launcher_ready, Duration::from_secs(5)),
        "shim=",
    );
    let legacy_root = process_id_from_ready(
        &wait_for_file(&legacy_ready, Duration::from_secs(5)),
        "root=",
    );
    let mapping_store = directory.join("mapping-store");
    fs::create_dir(&mapping_store).expect("create live legacy Mapping Store directory");
    fs::write(
        mapping_store.join("store.lock"),
        format!("{{\"pid\":{legacy_root},\"instanceId\":\"live-other\"}}\n"),
    )
    .expect("write live legacy Mapping Store lock");

    let mut replacement = host_runtime_shim(&directory, &replacement_ready);
    if !wait_for_process_exit(&mut replacement, Duration::from_secs(5)) {
        force_stop_test_process(replacement.id());
        if let Some(identity) = wait_for_optional_file(&replacement_ready, Duration::from_secs(1)) {
            force_stop_test_process(process_id_from_ready(&identity, "root="));
        }
        force_stop_test_process(legacy_shim);
        force_stop_test_process(legacy_root);
        drop(desktop_stdin);
        let _ = desktop.wait();
        let _ = replacement.wait();
        fs::remove_dir_all(&directory).expect("remove unsafe legacy migration fixture");
        panic!("replacement Shim retired a Host Runtime owned by another live Desktop");
    }
    let mut replacement_error = String::new();
    replacement
        .stderr
        .take()
        .expect("replacement Shim stderr")
        .read_to_string(&mut replacement_error)
        .expect("read replacement Shim error");
    assert!(
        replacement_error.contains("another Codex Desktop process owns the legacy"),
        "unexpected replacement error: {replacement_error}"
    );
    assert!(!replacement_ready.exists());
    assert!(
        process_exists(legacy_shim) && process_exists(legacy_root),
        "legacy Shim or Host Runtime owned by another live Desktop was terminated"
    );

    force_stop_test_process(legacy_shim);
    force_stop_test_process(legacy_root);
    drop(desktop_stdin);
    assert!(wait_for_process_exit(&mut desktop, Duration::from_secs(5)));
    fs::remove_dir_all(directory).expect("remove live legacy Desktop fixture");
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn retires_an_orphaned_legacy_runtime_after_desktop_exit() {
    let directory = temporary_directory();
    let launcher_ready = directory.join("launcher-ready");
    let legacy_ready = directory.join("legacy-ready");
    let replacement_ready = directory.join("replacement-ready");
    let legacy_runtime = directory.join("node");
    fs::copy(fake_codex_path(), &legacy_runtime).expect("copy orphaned fake Node runtime");

    let launcher = Command::new(fake_codex_path())
        .env("FAKE_CODEX_ORPHAN_SHIM", shim_path())
        .env("FAKE_CODEX_ORPHAN_RUNTIME", &legacy_runtime)
        .env("FAKE_CODEX_ORPHAN_DATA_DIR", &directory)
        .env("FAKE_CODEX_ORPHAN_RUNTIME_READY", &legacy_ready)
        .env("FAKE_CODEX_ORPHAN_LAUNCHER_READY", &launcher_ready)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start fake Desktop launcher");
    let launcher_process_id = launcher.id();
    let launcher = launcher
        .wait_with_output()
        .expect("run fake Desktop launcher");
    assert!(
        launcher.status.success(),
        "{}",
        String::from_utf8_lossy(&launcher.stderr)
    );
    let legacy_shim = process_id_from_ready(
        &wait_for_file(&launcher_ready, Duration::from_secs(5)),
        "shim=",
    );
    let legacy_root = process_id_from_ready(
        &wait_for_file(&legacy_ready, Duration::from_secs(5)),
        "root=",
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while parent_process_id(legacy_shim)
        .expect("read orphaned Shim parent")
        .is_some_and(|parent| parent == launcher_process_id)
        && Instant::now() < deadline
    {
        thread::sleep(Duration::from_millis(20));
    }
    assert_ne!(
        parent_process_id(legacy_shim).expect("read reparented Shim parent"),
        Some(launcher_process_id),
        "legacy Shim was not reparented after its fake Desktop exited"
    );

    let mapping_store = directory.join("mapping-store");
    fs::create_dir(&mapping_store).expect("create orphaned Mapping Store directory");
    fs::write(
        mapping_store.join("store.lock"),
        format!("{{\"pid\":{legacy_root},\"instanceId\":\"orphaned\"}}\n"),
    )
    .expect("write orphaned Mapping Store lock");

    let mut replacement = host_runtime_shim(&directory, &replacement_ready);
    let replacement_stdin = replacement
        .stdin
        .take()
        .expect("replacement Host Runtime stdin");
    let Some(replacement_identity) =
        wait_for_optional_file(&replacement_ready, Duration::from_secs(5))
    else {
        drop(replacement_stdin);
        force_stop_test_process(legacy_shim);
        force_stop_test_process(legacy_root);
        force_stop_test_process(replacement.id());
        let _ = replacement.wait();
        let mut replacement_error = String::new();
        if let Some(mut stderr) = replacement.stderr.take() {
            let _ = stderr.read_to_string(&mut replacement_error);
        }
        let _ = fs::remove_dir_all(&directory);
        panic!(
            "replacement Host Runtime did not recover the orphaned legacy owner: {replacement_error}"
        );
    };
    let replacement_root = process_id_from_ready(&replacement_identity, "root=");
    assert!(
        !process_exists(legacy_shim) && !process_exists(legacy_root),
        "orphaned legacy Shim or Host Runtime survived ownership migration"
    );

    drop(replacement_stdin);
    if !wait_for_process_exit(&mut replacement, Duration::from_secs(5)) {
        force_stop_test_process(replacement.id());
        force_stop_test_process(replacement_root);
        let _ = replacement.wait();
        fs::remove_dir_all(&directory).expect("remove failed orphan replacement fixture");
        panic!("replacement Host Runtime did not converge after orphan recovery");
    }
    fs::remove_dir_all(directory).expect("remove orphaned Host Runtime fixture");
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
