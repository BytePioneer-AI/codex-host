//! Child of the actual Launcher Job handoff fixture; never invokes install().
use super::*;
use codexhost_platform::WindowsLaunchJob;
use std::{fs, path::PathBuf, process::Command};

#[test]
fn inherited_job_is_rejected_before_any_lock_handoff() {
    let job = WindowsLaunchJob::create_unique().unwrap();
    let mut child = job
        .spawn_supervised(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "windows_handoff_tests::reject_job_fixture",
                    "--ignored",
                    "--nocapture",
                ])
                .env(codexhost_platform::DESKTOP_LAUNCH_JOB_ENV, job.key()),
        )
        .unwrap();
    assert!(child.wait().unwrap().success());
    let outside = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "windows_handoff_tests::unbound_job_environment_fixture",
            "--ignored",
            "--nocapture",
        ])
        .env(codexhost_platform::DESKTOP_LAUNCH_JOB_ENV, job.key())
        .status()
        .unwrap();
    assert!(
        outside.success(),
        "package-wide environment alone must not deny an independent helper"
    );
}

#[test]
fn destroyed_job_hint_does_not_deny_an_independent_child() {
    let job = WindowsLaunchJob::create_unique().unwrap();
    let key = job.key().to_owned();
    drop(job); // no members and no handles remain
    assert!(
        matches!(WindowsLaunchJob::open(&key), Err(codexhost_platform::PlatformError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound)
    );
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "windows_handoff_tests::unbound_job_environment_fixture",
            "--ignored",
            "--nocapture",
        ])
        .env(codexhost_platform::DESKTOP_LAUNCH_JOB_ENV, key)
        .status()
        .unwrap();
    assert!(status.success());
}

#[test]
#[ignore = "child of inherited_job_is_rejected_before_any_lock_handoff"]
fn unbound_job_environment_fixture() {
    reject_inherited_desktop_job().unwrap();
}

#[test]
#[ignore = "child of inherited_job_is_rejected_before_any_lock_handoff"]
fn reject_job_fixture() {
    assert!(
        reject_inherited_desktop_job()
            .unwrap_err()
            .to_string()
            .contains("inherited the old Desktop Job")
    );
}

#[test]
#[ignore = "spawned only by the two-update native Launcher handoff fixture"]
fn updater_fixture() {
    let root = PathBuf::from(std::env::var_os("CODEXHOST_HANDOFF_ROOT").unwrap());
    let round = std::env::var("CODEXHOST_HANDOFF_ROUND").unwrap();
    assert!(["1", "2"].contains(&round.as_str()));
    let job = WindowsLaunchJob::open(&std::env::var("CODEXHOST_HANDOFF_OLD_JOB").unwrap()).unwrap();
    assert!(!job.contains_pid(std::process::id()).unwrap());
    let request: UpdateRequest = serde_json::from_slice(
        &fs::read(PathBuf::from(
            std::env::var_os("CODEXHOST_HANDOFF_REQUEST").unwrap(),
        ))
        .unwrap(),
    )
    .unwrap();
    // The test deliberately enters the real identity/lock/wait handshake
    // without opening the production automatic-install acceptance gate.
    let mut ownership = wait_for_launcher_exit(&request).unwrap();
    assert!(job.is_empty().unwrap());
    assert!(!job.contains_pid(std::process::id()).unwrap());
    ownership.finish().unwrap();
    fs::write(
        root.join(format!("survived-{round}")),
        serde_json::json!({
            "outsideOldJob":true,"oldJobEmpty":true,"lockTaken":true
        })
        .to_string(),
    )
    .unwrap();
    if round == "1" {
        // Include the real Node wrapper hop used by npm relaunches. This is
        // process/Job inheritance evidence, not full Codex startup acceptance.
        let status = Command::new("node")
            .args(["-e", "const c=require('node:child_process').spawnSync(process.argv[1],['--exact','active_update::windows::tests::launcher_fixture','--ignored','--nocapture'],{stdio:'inherit'});process.exit(c.status??1)", "--"])
            .arg(root.join("bin/codexhost.exe"))
            .env("CODEXHOST_HANDOFF_ROUND", "2")
            .env("CODEXHOST_HANDOFF_PREVIOUS_JOB", job.key())
            .status()
            .unwrap();
        assert!(status.success());
    }
    fs::write(root.join(format!("finished-{round}")), "finished").unwrap();
}
