use super::*;
use std::{
    fs,
    os::windows::{io::AsRawHandle, process::CommandExt},
    path::PathBuf,
    process::{Child, Command, Stdio},
};
use windows::Win32::System::{
    Diagnostics::ToolHelp::*,
    Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
};
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppxFixture {
    package_full_name: String,
    app_user_model_id: String,
    executable: PathBuf,
}

#[test]
#[ignore = "requires a disposable registered MSIX fixture and real Launcher resume executable"]
fn actual_msix_resume_binding_precedes_application_entry() {
    assert_eq!(
        std::env::var("CODEXHOST_DISPOSABLE_WINDOWS_USER").as_deref(),
        Ok("fixture-only")
    );
    let input = std::env::var_os("CODEXHOST_APPX_FIXTURE").expect("registered fixture descriptor");
    let config: AppxFixture = serde_json::from_slice(&fs::read(input).unwrap()).unwrap();
    let job = WindowsLaunchJob::create_unique().unwrap();
    let dir = directory(job.key());
    let environment = vec![("CODEXHOST_JOB_PROBE".into(), job.key().into())];
    let foreign_output = dir.0.join("foreign.trace");
    let foreign_args = vec![
        format!("--fixture-output={}", foreign_output.display()).into(),
        "--fixture-role=leaf".into(),
    ];
    let foreign = crate::windows_desktop::activate_packaged_fixture(
        &config.package_full_name,
        &config.app_user_model_id,
        &config.executable,
        &foreign_output.with_extension("leaf"),
        &foreign_args,
        &environment,
    )
    .unwrap();
    struct Foreign(crate::DesktopProcess);
    impl Drop for Foreign {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let end = Instant::now() + Duration::from_secs(3);
            while self.0.try_wait().ok().flatten().is_none() && Instant::now() < end {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
    let mut foreign = Foreign(foreign);
    wait_file(&foreign_output.with_extension("leaf"));
    assert!(
        fs::read_to_string(foreign_output.with_extension("leaf"))
            .unwrap()
            .ends_with("false")
    );
    assert!(!job.contains_pid(foreign.0.id()).unwrap());
    assert!(foreign.0.try_wait().unwrap().is_none());
    let output = dir.0.join("owned.trace");
    let args = vec![format!("--fixture-output={}", output.display()).into()];
    let _desktop = crate::windows_desktop::activate_packaged_desktop_in_job(
        &config.package_full_name,
        &config.app_user_model_id,
        &args,
        &environment,
        &job,
    )
    .unwrap();
    wait_file(&output.with_extension("orphan"));
    wait_file(&output.with_extension("leaf"));
    for file in [
        &output,
        &output.with_extension("middle"),
        &output.with_extension("leaf"),
    ] {
        let record = fs::read_to_string(file).unwrap();
        assert!(
            record.ends_with("true"),
            "application executed before binding: {record}"
        );
    }
    job.terminate_and_wait(Duration::from_secs(5)).unwrap();
    assert!(foreign.0.try_wait().unwrap().is_none());
}

struct Stop(Child);
impl Drop for Stop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
struct Directory(PathBuf);
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn directory(key: &str) -> Directory {
    let p = std::env::temp_dir().join(format!("codexhost-job-{key}"));
    fs::create_dir(&p).unwrap();
    Directory(p)
}
fn wait_file(file: &std::path::Path) {
    let end = Instant::now() + Duration::from_secs(5);
    while !file.exists() {
        assert!(Instant::now() < end);
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn initial_thread(child: &Child) -> Owned<HANDLE> {
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }.unwrap();
    let snap = unsafe { Owned::new(snap) };
    let mut e = THREADENTRY32 {
        dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    unsafe { Thread32First(*snap, &mut e) }.unwrap();
    loop {
        if e.th32OwnerProcessID == child.id() {
            return unsafe {
                Owned::new(OpenThread(THREAD_SUSPEND_RESUME, false, e.th32ThreadID).unwrap())
            };
        }
        unsafe { Thread32Next(*snap, &mut e) }.unwrap();
    }
}
#[test]
fn helper_assigns_before_execution_and_foreign_package_environment_is_not_a_binding() {
    let job = WindowsLaunchJob::create_unique().unwrap();
    let dir = directory(job.key());
    let mut children = Vec::new();
    for bound in [true, false] {
        let file = dir.0.join(if bound { "bound" } else { "foreign" });
        let source =
            "require('node:fs').writeFileSync(process.argv[1],'ran');setInterval(()=>{},1000)";
        let mut command = Command::new("node");
        command
            .args(["-e", source, "--"])
            .arg(&file)
            .env("CODEXHOST_RUNTIME_NONCE", job.key())
            .creation_flags(4 | 0x08000000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if bound {
            command.arg(job.argument());
        }
        let child = Stop(command.spawn().unwrap());
        let thread = initial_thread(&child.0);
        let process = HANDLE(child.0.as_raw_handle());
        assert!(!file.exists());
        bind_before_resume(process, *thread).unwrap();
        assert_eq!(job.contains_pid(child.0.id()).unwrap(), bound);
        assert!(!file.exists());
        assert_eq!(unsafe { ResumeThread(*thread) }, 1);
        wait_file(&file);
        children.push(child);
    }
    job.terminate_and_wait(Duration::from_secs(5)).unwrap();
    assert!(children[1].0.try_wait().unwrap().is_none()); // independent app survived
    children[0].0.wait().unwrap();
}
#[test]
fn pre_execution_job_retains_orphaned_descendants_and_controller_resources() {
    let job = WindowsLaunchJob::create_unique().unwrap();
    let dir = directory(job.key());
    let pid = dir.0.join("b.pid");
    let done = dir.0.join("a-exited");
    let a = format!(
        "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{{}},1000)'],{{stdio:'ignore'}});require('node:fs').writeFileSync({:?},String(c.pid));c.unref();",
        pid.to_string_lossy()
    );
    let source = format!(
        "const a=require('node:child_process').spawn(process.execPath,['-e',{:?}],{{stdio:'ignore'}});a.on('exit',()=>require('node:fs').writeFileSync({:?},'gone'));setInterval(()=>{{}},1000)",
        a,
        done.to_string_lossy()
    );
    let mut command = Command::new("node");
    command
        .args(["-e", &source])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut root = job.spawn_supervised(&mut command).unwrap();
    wait_file(&done);
    let b = fs::read_to_string(&pid).unwrap().parse().unwrap();
    assert!(job.contains_pid(b).unwrap());
    let mut command = Command::new("node");
    command
        .args(["-e", "setInterval(()=>{},1000)"])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut controller = job.spawn_supervised(&mut command).unwrap();
    assert!(job.contains_pid(controller.id()).unwrap());
    command.creation_flags(0x08000000);
    let mut foreign = Stop(command.spawn().unwrap()); // ordinary creation, never assigned
    let delayed = WindowsLaunchJob::open(job.key()).unwrap();
    job.terminate_and_wait(Duration::from_secs(5)).unwrap();
    root.wait_for_tree_exit(Duration::from_secs(3)).unwrap();
    controller
        .wait_for_tree_exit(Duration::from_secs(3))
        .unwrap();
    assert!(!crate::process_exists(b));
    assert!(foreign.0.try_wait().unwrap().is_none());
    let late = dir.0.join("late-ran");
    let mut command = Command::new("node");
    command
        .args([
            "-e",
            "require('node:fs').writeFileSync(process.argv[1],'ran')",
            "--",
        ])
        .arg(&late)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    assert!(delayed.spawn_supervised(&mut command).is_err());
    assert!(
        !late.exists(),
        "a late claimant ran after cleanup admission"
    );
}
