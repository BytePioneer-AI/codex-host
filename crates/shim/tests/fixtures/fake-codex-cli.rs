#![forbid(unsafe_code)]

use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;
use std::process::{self, Command, Stdio};
use std::thread;
use std::time::Duration;

use codexhost_platform::CODEX_CLI_PATH_ENV;

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

// The root-exit test mode intentionally drops a live child to verify orphan cleanup.
#[allow(clippy::zombie_processes)]
fn main() {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    #[cfg(unix)]
    if env::var_os("FAKE_CODEX_CRASH").is_some() {
        use std::os::unix::process::CommandExt;

        let error = Command::new("/bin/sh").args(["-c", "kill -SEGV $$"]).exec();
        panic!("failed to exec crashing process: {error}");
    }
    if run_signal_observer() {
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

    if env::var_os("FAKE_CODEX_PRINT_INVOCATION").is_some() {
        eprintln!("args={}", arguments.join("|"));
        eprintln!(
            "codex_cli_path_present={}",
            env::var_os(CODEX_CLI_PATH_ENV).is_some()
        );
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
