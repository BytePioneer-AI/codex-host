//! Test-only executable with Codex's argument layout; never invokes a real CLI.
use std::{env, process::Command};

fn main() {
    #[cfg(windows)]
    if env::args().nth(1).as_deref() == Some("--watch-process") {
        watch_process(env::args().nth(2).unwrap().parse().unwrap());
        return;
    }
    let script = env::current_exe()
        .unwrap()
        .with_file_name("native-codex.mjs");
    let mut command = Command::new(env::var_os("NATIVE_FIXTURE_NODE").unwrap());
    command.arg(script).args(env::args_os().skip(1));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        panic!("fixture exec failed: {}", command.exec());
    }
    #[cfg(windows)]
    std::process::exit(command.status().unwrap().code().unwrap_or(1));
}

// Retain the original Windows process object: its numeric PID can be reused as
// soon as it exits, so kill(pid, 0) cannot prove whether that instance survived.
#[cfg(windows)]
fn watch_process(pid: u32) {
    use std::ffi::c_void;
    use std::io::{BufRead, Write};
    type Handle = *mut c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn WaitForSingleObject(handle: Handle, timeout: u32) -> u32;
        fn CloseHandle(handle: Handle) -> i32;
    }
    let process = unsafe { OpenProcess(0x0010_0000, 0, pid) }; // SYNCHRONIZE
    assert!(!process.is_null(), "cannot retain fixture process instance");
    assert_eq!(
        unsafe { WaitForSingleObject(process, 0) },
        258,
        "fixture must be alive"
    );
    println!("observing");
    std::io::stdout().flush().unwrap();
    for line in std::io::stdin().lock().lines() {
        assert_eq!(line.unwrap(), "check");
        println!(
            "{}",
            match unsafe { WaitForSingleObject(process, 0) } {
                0 => "exited",
                258 => "running",
                result => panic!("cannot inspect retained process: {result}"),
            }
        );
        std::io::stdout().flush().unwrap();
    }
    unsafe {
        CloseHandle(process);
    }
}
