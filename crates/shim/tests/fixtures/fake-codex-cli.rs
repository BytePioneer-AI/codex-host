#![forbid(unsafe_code)]

use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{self, Command, Stdio};
use std::thread;
use std::time::Duration;

#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::os::unix::net::UnixListener;

use codexhost_platform::{CODEX_CLI_PATH_ENV, STOCK_CODEX_PATH_ENV};
use codexhost_shim::{HOST_NODE_PATH_ENV, HOST_RUNTIME_PATH_ENV};

fn environment_u64(name: &str, default: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(default)
}

fn write_ready_file(path: &Path, contents: &str) {
    let temporary = path.with_extension(format!("tmp-{}", process::id()));
    fs::write(&temporary, contents).expect("write temporary ready file");
    fs::rename(temporary, path).expect("publish ready file");
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn run_unix_listener() -> bool {
    let Some(socket_path) =
        env::var_os("FAKE_CODEX_UNIX_LISTENER_PATH").map(std::path::PathBuf::from)
    else {
        return false;
    };
    let ready_path = env::var_os("FAKE_CODEX_READY_PATH").map(std::path::PathBuf::from);
    fs::create_dir_all(socket_path.parent().expect("fake listener parent"))
        .expect("create fake listener directory");
    let _ = fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).expect("bind fake Unix listener");
    if let Some(path) = ready_path {
        write_ready_file(
            &path,
            &format!(
                "root={}\nshim={}\n",
                process::id(),
                nix::unistd::getppid().as_raw()
            ),
        );
    }
    for connection in listener.incoming() {
        drop(connection.expect("accept fake Unix listener connection"));
    }
    true
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn run_unix_listener() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn run_signal_observer() -> bool {
    use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
    use signal_hook::flag::register_usize;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    let Some(ready_path) = env::var_os("FAKE_CODEX_SIGNAL_READY").map(std::path::PathBuf::from)
    else {
        return false;
    };
    let observed_path = env::var_os("FAKE_CODEX_SIGNAL_OBSERVED").map(std::path::PathBuf::from);
    let ignore = env::var_os("FAKE_CODEX_IGNORE_SIGNALS").is_some();
    let pending = Arc::new(AtomicUsize::new(0));
    let _registrations = [SIGTERM, SIGINT, SIGHUP].map(|signal| {
        register_usize(signal, Arc::clone(&pending), signal as usize)
            .expect("install fake signal observer")
    });
    write_ready_file(&ready_path, &format!("{}\n", process::id()));
    loop {
        let signal = pending.swap(0, Ordering::SeqCst);
        if signal != 0 {
            if let Some(path) = &observed_path {
                write_ready_file(path, &format!("{signal}\n"));
            }
            if !ignore {
                process::exit(128 + signal as i32);
            }
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(not(target_os = "macos"))]
fn run_signal_observer() -> bool {
    false
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
#[allow(clippy::zombie_processes)]
fn run_orphan_shim_launcher() -> bool {
    let Some(shim_path) = env::var_os("FAKE_CODEX_ORPHAN_SHIM") else {
        return false;
    };
    let runtime_path =
        env::var_os("FAKE_CODEX_ORPHAN_RUNTIME").expect("orphan launcher fake runtime path");
    let data_directory =
        env::var_os("FAKE_CODEX_ORPHAN_DATA_DIR").expect("orphan launcher data directory");
    let runtime_ready =
        env::var_os("FAKE_CODEX_ORPHAN_RUNTIME_READY").expect("orphan launcher runtime ready path");
    let launcher_ready =
        env::var_os("FAKE_CODEX_ORPHAN_LAUNCHER_READY").expect("orphan launcher ready path");

    let keep_desktop_alive = env::var_os("FAKE_CODEX_ORPHAN_KEEP_DESKTOP").is_some();
    let configured_host_runtime = env::var_os("FAKE_CODEX_ORPHAN_USE_HOST_RUNTIME").is_some();
    let mut command = Command::new(shim_path);
    command
        .args(["app-server", "--stdio"])
        .env_remove("FAKE_CODEX_ORPHAN_SHIM")
        .env_remove("FAKE_CODEX_ORPHAN_RUNTIME")
        .env_remove("FAKE_CODEX_ORPHAN_DATA_DIR")
        .env_remove("FAKE_CODEX_ORPHAN_RUNTIME_READY")
        .env_remove("FAKE_CODEX_ORPHAN_LAUNCHER_READY")
        .env_remove("FAKE_CODEX_ORPHAN_KEEP_DESKTOP")
        .env_remove("FAKE_CODEX_ORPHAN_USE_HOST_RUNTIME")
        .env(STOCK_CODEX_PATH_ENV, &runtime_path)
        .env("CODEXHOST_DATA_DIR", data_directory)
        .env("FAKE_CODEX_HOST_RUNTIME_READY", runtime_ready)
        .stdin(if keep_desktop_alive {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if configured_host_runtime {
        command
            .env(HOST_NODE_PATH_ENV, &runtime_path)
            .env(HOST_RUNTIME_PATH_ENV, &runtime_path);
    } else {
        command
            .env_remove(HOST_NODE_PATH_ENV)
            .env_remove(HOST_RUNTIME_PATH_ENV);
    }
    let mut child = command
        .spawn()
        .expect("spawn orphaned fake Host Runtime Shim");
    write_ready_file(
        &std::path::PathBuf::from(launcher_ready),
        &format!("shim={}\n", child.id()),
    );
    if keep_desktop_alive {
        // A real Desktop reaps a rejected Shim while the Desktop itself stays open. Poll both
        // lifetimes so Linux does not retain the exited child as a zombie until Desktop EOF.
        let (desktop_eof_sender, desktop_eof_receiver) = std::sync::mpsc::sync_channel(1);
        thread::spawn(move || {
            let result = io::stdin().read_to_end(&mut Vec::new());
            let _ = desktop_eof_sender.send(result);
        });
        let mut child_exited = false;
        loop {
            if !child_exited {
                child_exited = child.try_wait().expect("poll fake Desktop child").is_some();
            }
            match desktop_eof_receiver.try_recv() {
                Ok(result) => {
                    result.expect("wait for fake Desktop stdin EOF");
                    break;
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    panic!("fake Desktop stdin reader disconnected")
                }
            }
        }
        if !child_exited {
            drop(child.stdin.take());
            child.wait().expect("reap fake Desktop child");
        }
    }
    true
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn run_orphan_shim_launcher() -> bool {
    false
}

// The root-exit test mode intentionally drops a live child to verify orphan cleanup.
#[allow(clippy::zombie_processes)]
fn main() {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if env::var_os("FAKE_CODEX_CRASH").is_some() {
        use std::os::unix::process::CommandExt;

        let error = Command::new("/bin/sh").args(["-c", "kill -SEGV $$"]).exec();
        panic!("failed to exec crashing process: {error}");
    }
    if run_unix_listener() {
        return;
    }
    if run_signal_observer() {
        return;
    }
    if run_orphan_shim_launcher() {
        return;
    }
    if let Some(ready_path) = env::var_os("FAKE_CODEX_HOST_RUNTIME_READY") {
        let host_node_path = env::var_os(HOST_NODE_PATH_ENV)
            .map(PathBuf::from)
            .map(|value| value.display().to_string())
            .unwrap_or_default();
        let host_runtime_path = env::var_os(HOST_RUNTIME_PATH_ENV)
            .map(PathBuf::from)
            .map(|value| value.display().to_string())
            .unwrap_or_default();
        write_ready_file(
            Path::new(&ready_path),
            &format!(
                "root={}\nhost_node_path={host_node_path}\nhost_runtime_path={host_runtime_path}\n",
                process::id(),
            ),
        );
        io::stdin()
            .read_to_end(&mut Vec::new())
            .expect("wait for fake Host Runtime stdin EOF");
        thread::sleep(Duration::from_millis(environment_u64(
            "FAKE_CODEX_HOST_RUNTIME_EOF_DELAY_MS",
            60_000,
        )));
        return;
    }
    if arguments
        .first()
        .is_some_and(|value| value == "--child-sleep")
    {
        #[cfg(target_os = "macos")]
        if env::var_os("FAKE_CODEX_CHILD_NEW_GROUP").is_some() {
            use nix::unistd::{Pid, setpgid};

            setpgid(Pid::from_raw(0), Pid::from_raw(0)).expect("isolate fake child process group");
        }
        thread::sleep(Duration::from_millis(environment_u64(
            "FAKE_CODEX_CHILD_DELAY_MS",
            60_000,
        )));
        return;
    }

    if env::var_os("FAKE_CODEX_STREAM_RESPONSE").is_some() {
        let mut request = [0_u8; 1];
        io::stdin()
            .read_exact(&mut request)
            .expect("read streaming request byte");
        io::stdout()
            .write_all(b"response")
            .expect("write streaming response");
        io::stdout().flush().expect("flush streaming response");
        io::stdin()
            .read_to_end(&mut Vec::new())
            .expect("wait for streaming stdin EOF");
        return;
    }

    if env::var_os("FAKE_CODEX_PRINT_INVOCATION").is_some() {
        eprintln!("args={}", arguments.join("|"));
        eprintln!(
            "codex_cli_path_present={}",
            env::var_os(CODEX_CLI_PATH_ENV).is_some()
        );
    }

    if env::var_os("FAKE_CODEX_PRINT_PROXY_ENV").is_some() {
        for name in [
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
            "NODE_USE_ENV_PROXY",
        ] {
            if let Some(value) = env::var_os(name) {
                eprintln!("{name}={}", value.to_string_lossy());
            }
        }
    }

    if env::var_os("FAKE_CODEX_SPAWN_CHILD").is_some() {
        let mut child = Command::new(env::current_exe().expect("current executable"))
            .arg("--child-sleep")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn fake child");
        println!("{}", child.id());
        io::stdout().flush().expect("flush child id");
        if let Some(path) = env::var_os("FAKE_CODEX_READY_PATH") {
            write_ready_file(
                Path::new(&path),
                &format!("root={}\nchild={}\n", process::id(), child.id()),
            );
        }
        if env::var_os("FAKE_CODEX_ROOT_EXIT").is_some() {
            thread::sleep(Duration::from_millis(environment_u64(
                "FAKE_CODEX_ROOT_EXIT_DELAY_MS",
                500,
            )));
            return;
        }
        thread::sleep(Duration::from_millis(environment_u64(
            "FAKE_CODEX_DELAY_MS",
            60_000,
        )));
        let _ = child.wait();
        return;
    }

    let delay_ms = environment_u64("FAKE_CODEX_DELAY_MS", 0);
    if delay_ms > 0 {
        thread::sleep(Duration::from_millis(delay_ms));
    }

    let mut input = Vec::new();
    io::stdin().read_to_end(&mut input).expect("read stdin");
    let mut stdout = io::stdout().lock();
    if env::var_os("FAKE_CODEX_BYTE_CHUNKS").is_some() {
        for byte in input {
            stdout.write_all(&[byte]).expect("write byte chunk");
            stdout.flush().expect("flush byte chunk");
        }
    } else {
        stdout.write_all(&input).expect("write stdin echo");
    }
    if let Ok(extra) = env::var("FAKE_CODEX_STDOUT") {
        stdout
            .write_all(extra.as_bytes())
            .expect("write extra stdout");
    }
    stdout.flush().expect("flush stdout");

    if let Ok(stderr) = env::var("FAKE_CODEX_STDERR") {
        io::stderr()
            .write_all(stderr.as_bytes())
            .expect("write stderr");
    }

    let exit_code = env::var("FAKE_CODEX_EXIT_CODE")
        .ok()
        .and_then(|value| value.parse::<i32>().ok())
        .unwrap_or(0);
    process::exit(exit_code);
}
