//! Disposable MSIX test application, never Codex Desktop.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
#[cfg(target_os = "windows")]
#[link(name = "CodexHostActivationProbe")]
unsafe extern "C" {
    fn codexhost_probe_ran() -> i32;
}

#[cfg(target_os = "windows")]
mod early {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};
    pub static CHECKED: AtomicBool = AtomicBool::new(false);
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCommandLineW() -> *const u16;
        fn GetCurrentProcess() -> *mut c_void;
        fn OpenJobObjectW(access: u32, inherit: i32, name: *const u16) -> *mut c_void;
        fn IsProcessInJob(process: *mut c_void, job: *mut c_void, member: *mut i32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn ExitProcess(code: u32) -> !;
    }
    unsafe extern "system" fn check(_module: *mut c_void, reason: u32, _reserved: *mut c_void) {
        if reason != 1 {
            return;
        }
        CHECKED.store(true, Ordering::SeqCst);
        let command = unsafe { GetCommandLineW() };
        let mut len = 0;
        while len < 32768 && unsafe { *command.add(len) } != 0 {
            len += 1;
        }
        let marker = b"--codexhost-activation=";
        for start in 0..len.saturating_sub(marker.len() + 31) {
            if !marker
                .iter()
                .enumerate()
                .all(|(offset, byte)| unsafe { *command.add(start + offset) } == u16::from(*byte))
            {
                continue;
            }
            let prefix = b"Local\\codexhost-activation-";
            let mut name = [0u16; 80];
            for (i, byte) in prefix.iter().enumerate() {
                name[i] = u16::from(*byte);
            }
            for i in 0..32 {
                name[prefix.len() + i] = unsafe { *command.add(start + marker.len() + i) };
            }
            let job = unsafe { OpenJobObjectW(4, 0, name.as_ptr()) };
            let mut member = 0;
            if job.is_null()
                || unsafe { IsProcessInJob(GetCurrentProcess(), job, &mut member) } == 0
                || member == 0
            {
                unsafe { ExitProcess(197) }
            }
            unsafe {
                CloseHandle(job);
            }
        }
    }
    #[used]
    #[unsafe(no_mangle)]
    #[unsafe(link_section = ".CRT$XLB")]
    pub static CODEXHOST_TLS_GUARD: unsafe extern "system" fn(*mut c_void, u32, *mut c_void) =
        check;
}

#[cfg(target_os = "windows")]
#[allow(clippy::zombie_processes)] // Deliberate orphan fixture: the Job, not a living parent, must retain the leaf.
fn main() {
    assert_eq!(
        unsafe { codexhost_probe_ran() },
        1,
        "imported DLL guard did not execute"
    );
    assert!(
        early::CHECKED.load(std::sync::atomic::Ordering::SeqCst),
        "native pre-entry guard was not linked"
    );
    use std::{
        process::{Command, Stdio},
        time::Duration,
    };
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let value = |prefix: &str| {
        arguments
            .iter()
            .find_map(|arg| arg.strip_prefix(prefix))
            .map(str::to_owned)
    };
    let output = std::path::PathBuf::from(value("--fixture-output=").expect("fixture output"));
    let role = value("--fixture-role=").unwrap_or_else(|| "root".into());
    let key = value("--codexhost-activation=")
        .or_else(|| std::env::var("CODEXHOST_JOB_PROBE").ok())
        .expect("fixture probe");
    let job = codexhost_platform::WindowsLaunchJob::open(&key).unwrap();
    let member = job.contains_pid(std::process::id()).unwrap();
    let record = match role.as_str() {
        "leaf" => output.with_extension("leaf"),
        "middle" => output.with_extension("middle"),
        _ => output.clone(),
    };
    // This is the first application action: membership must precede it.
    let temporary = record.with_extension("tmp");
    std::fs::write(&temporary, format!("{} {member}", std::process::id())).unwrap();
    std::fs::rename(&temporary, &record).unwrap();
    if role == "leaf" {
        loop {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    let mut child = Command::new(std::env::current_exe().unwrap());
    child
        .args(
            arguments
                .iter()
                .filter(|arg| !arg.starts_with("--fixture-role=")),
        )
        .arg(if role == "middle" {
            "--fixture-role=leaf"
        } else {
            "--fixture-role=middle"
        })
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = child.spawn().unwrap();
    if role == "middle" {
        return;
    }
    child.wait().unwrap();
    std::fs::write(
        output.with_extension("orphan"),
        b"middle exited; leaf survives",
    )
    .unwrap();
    loop {
        std::thread::sleep(Duration::from_millis(100));
    }
}
#[cfg(not(target_os = "windows"))]
fn main() {
    panic!("this fixture is Windows-only");
}
