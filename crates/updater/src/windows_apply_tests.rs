//! Portable apply-order evidence, NOT Inno/Job/Host acceptance. Only process
//! handoff, quiescence, the installer command and readiness are substituted here.
//! Request/material validators, both install/restore callers, locks and status
//! persistence are production implementations operating on real private files.
use super::*;
use crate::request::WindowsInstallation;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn write(path: &Path, bytes: impl AsRef<[u8]>) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}
fn files(version: &str) -> Vec<(&'static str, Vec<u8>)> {
    let mut files = vec![
        ("bin/codexhost.exe", version.as_bytes().to_vec()),
        ("runtime/node.exe", version.as_bytes().to_vec()),
        ("libexec/codexhost-updater.exe", version.as_bytes().to_vec()),
        ("app/host-runtime.mjs", version.as_bytes().to_vec()),
        ("app/codexhost-distribution.json", serde_json::to_vec(&json!({"schemaVersion":1,"version":version,"distribution":"installer","target":"windows-x64"})).unwrap()),
    ];
    if version == "1.2.4" {
        files.push((
            "app/plugins/next-only/plugin.mjs",
            b"next software".to_vec(),
        ));
    }
    files
}
fn manifest(version: &str) -> String {
    format!(
        "codexhost-inno-files-v1\n{version}\nwindows-x64\n{}\n",
        files(version)
            .iter()
            .map(|(p, b)| format!("{} {} {p}", digest(b), b.len()))
            .collect::<Vec<_>>()
            .join("\n")
    )
}
struct Fixture {
    root: PathBuf,
    request_path: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "apply-中文 空格-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
            crate::status::unix_seconds()
        ));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let operation = root.join("update-1.2.4-fixture");
        let install = root.join("custom install");
        for (p, b) in files("1.2.3") {
            write(&install.join(p), b);
        }
        write(
            &install.join(crate::installer_files::MARKER),
            manifest("1.2.3"),
        );
        write(&install.join("app/plugins/user/state"), b"user");
        write(&operation.join("update.exe"), b"next Inno");
        write(&operation.join("previous.exe"), b"old Inno");
        let old = json!({"schemaVersion":1,"installerSha256":digest(b"old Inno"),"files":manifest("1.2.3")}).to_string();
        let next = json!({"schemaVersion":1,"installerSha256":digest(b"next Inno"),"files":manifest("1.2.4")}).to_string();
        write(&operation.join("previous-installer.json"), &old);
        write(&operation.join("target-installer.json"), &next);
        write(&operation.join("previous-files.txt"), manifest("1.2.3"));
        write(&operation.join("replacement-files.txt"), manifest("1.2.4"));
        let status_path = operation.join("status-v1.json");
        let owner = codexhost_platform::process_snapshot(std::process::id()).unwrap();
        write(&status_path,json!({"schemaVersion":1,"version":"1.2.4","installation":"windows-installer","phase":"prepared","updatedAt":1}).to_string());
        write(&root.join("active-update-v1.lock"),json!({"ownerPid":owner.id,"ownerStartedAtMicros":owner.started_at_micros.to_string(),"statusPath":status_path,"operationId":"apply-fixture","installationStarted":false}).to_string());
        let request_path = operation.join("request-v1.json");
        write(&request_path,json!({"schema_version":1,"version":"1.2.4","wait_pid":u32::MAX,"wait_started_at_micros":"1","wait_executable":install.join("bin/codexhost.exe"),"runtime_descriptor_path":root.join("runtime.json"),"status_path":status_path,"installation":{"kind":"windows-installer","installer_path":operation.join("update.exe"),"artifact_sha256":digest(b"next Inno"),"installed_version":"1.2.3","install_root":install,"recovery":{"installer_path":operation.join("previous.exe"),"artifact_sha256":digest(b"old Inno"),"manifest_path":operation.join("previous-installer.json"),"manifest_sha256":digest(old.as_bytes()),"target_manifest_path":operation.join("target-installer.json"),"target_manifest_sha256":digest(next.as_bytes()),"replacement_files_path":operation.join("replacement-files.txt"),"protected_roots":[root.join("user-data")]}}}).to_string());
        Self { root, request_path }
    }
    fn status(&self) -> Value {
        serde_json::from_slice(
            &fs::read(self.request_path.parent().unwrap().join("status-v1.json")).unwrap(),
        )
        .unwrap()
    }
    fn run(&self, effects: &mut TestEffects) -> Result<()> {
        let request = UpdateRequest::parse_windows_fixture(&self.request_path)?;
        execute(&request, effects)
    }
    fn assert_end(&self, failed: bool, retained: bool) {
        assert_eq!(
            self.status()["phase"],
            if failed { "failed" } else { "succeeded" }
        );
        assert_eq!(self.root.join("active-update-v1.lock").exists(), retained);
        if retained {
            let record: Value =
                serde_json::from_slice(&fs::read(self.root.join("active-update-v1.lock")).unwrap())
                    .unwrap();
            assert_eq!(record["installationStarted"], true);
        }
        for name in [
            "previous.exe",
            "update.exe",
            "previous-files.txt",
            "replacement-files.txt",
        ] {
            assert!(self.request_path.parent().unwrap().join(name).is_file());
        }
        assert_eq!(
            fs::read(self.root.join("custom install/app/plugins/user/state")).unwrap(),
            b"user"
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[derive(Clone, Copy, Default)]
enum InstallResult {
    #[default]
    Ready,
    PartialStopped,
    ZeroExitCorruptTarget,
    ZeroExitCorruptMetadata,
    Unknown,
    RestartPending,
    ReadOnlyFailure,
}
#[derive(Clone, Copy, Default)]
enum LaunchResult {
    #[default]
    Ready,
    NoChild,
    Stopped,
    Unknown(&'static str),
}
#[derive(Default)]
struct TestEffects {
    install_result: InstallResult,
    launches: Vec<LaunchResult>,
    launch_versions: Vec<String>,
    console_versions: Vec<String>,
    console_fails: bool,
    restore_calls: usize,
    restore_fails: bool,
    quiescent_fails: bool,
    tamper_recovery_on_launch: bool,
}
fn windows(r: &UpdateRequest) -> &WindowsInstallation {
    let Installation::WindowsInstaller(w) = &r.installation else {
        panic!("wrong channel")
    };
    w
}
// Test-only stand-in for Inno's file work; this is NOT evidence of its Pascal or
// uninstall-ledger semantics. The production callers verify every output byte.
fn tool_files(root: &Path, version: &str) {
    for (p, b) in files(version) {
        write(&root.join(p), b);
    }
    write(
        &root.join(crate::installer_files::MARKER),
        manifest(version),
    );
    if version == "1.2.3" {
        let _ = fs::remove_file(root.join("app/plugins/next-only/plugin.mjs"));
    }
}
impl Effects for TestEffects {
    fn handoff(&mut self, r: &UpdateRequest) -> Result<OperationLock> {
        let lock = OperationLock::take(r)?;
        write_status(r, "waiting-for-exit", None)?;
        Ok(lock)
    }
    fn install(
        &mut self,
        r: &UpdateRequest,
        before_write: &mut dyn FnMut() -> Result<()>,
    ) -> Result<()> {
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&r.status_path)?)?["phase"],
            "waiting-for-exit"
        );
        if matches!(self.install_result, InstallResult::ReadOnlyFailure) {
            write(&windows(r).installer_path, b"tampered after parse");
        }
        crate::install::install_windows_with_runner(
            r,
            windows(r),
            "x64",
            before_write,
            |command, _| {
                let record: Value = serde_json::from_slice(&fs::read(
                    r.status_path
                        .parent()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .join("active-update-v1.lock"),
                )?)?;
                assert_eq!(record["installationStarted"], true);
                assert_eq!(
                    serde_json::from_slice::<Value>(&fs::read(&r.status_path)?)?["phase"],
                    "installing"
                );
                assert!(
                    command
                        .get_args()
                        .any(|a| a.to_string_lossy().starts_with("/DIR="))
                );
                tool_files(&windows(r).install_root, "1.2.4");
                match self.install_result {
                    InstallResult::PartialStopped => {
                        write(
                            &windows(r).install_root.join("app/host-runtime.mjs"),
                            b"partial",
                        );
                        Err(crate::installer_recovery::stopped_failure(
                            "test tool partially wrote".into(),
                        ))
                    }
                    InstallResult::ZeroExitCorruptTarget => {
                        write(
                            &windows(r).install_root.join("app/host-runtime.mjs"),
                            b"bad target despite zero exit",
                        );
                        Ok(())
                    }
                    InstallResult::ZeroExitCorruptMetadata => {
                        write(
                            &windows(r)
                                .install_root
                                .join("app/codexhost-distribution.json"),
                            b"bad metadata despite zero exit",
                        );
                        Ok(())
                    }
                    InstallResult::Unknown => Err("tool exit unproven".into()),
                    InstallResult::RestartPending => {
                        let mut error = crate::installer_recovery::stopped_failure(
                            "test restart pending".into(),
                        );
                        error
                            .downcast_mut::<crate::installer_recovery::ToolFailure>()
                            .unwrap()
                            .restart_pending = true;
                        Err(error)
                    }
                    _ => Ok(()),
                }
            },
        )
    }
    fn quiescent(&mut self, _: &UpdateRequest) -> Result<()> {
        if self.quiescent_fails {
            Err("unknown resource holder".into())
        } else {
            Ok(())
        }
    }
    fn restore_files(&mut self, r: &UpdateRequest) -> Result<UpdateRequest> {
        self.restore_calls += 1;
        let version =
            crate::installer_recovery::restore_files_with_runner(r, "x64", |command, _| {
                assert_eq!(
                    command.get_program(),
                    windows(r)
                        .recovery
                        .as_ref()
                        .unwrap()
                        .installer_path
                        .as_os_str()
                );
                assert!(
                    command
                        .get_args()
                        .any(|a| a.to_string_lossy().starts_with("/CODEXHOSTREPLACEFILES="))
                );
                if self.restore_fails {
                    return Err("test original tool blocked".into());
                }
                tool_files(&windows(r).install_root, "1.2.3");
                Ok(())
            })?;
        let mut previous = r.clone();
        previous.version = version;
        Ok(previous)
    }
    fn start_console(&mut self, r: &UpdateRequest) -> Result<()> {
        let status: Value = serde_json::from_slice(&fs::read(&r.status_path)?)?;
        assert!(matches!(
            status["outcome"].as_str(),
            Some("updated" | "restored")
        ));
        assert!(
            !r.status_path
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("active-update-v1.lock")
                .exists()
        );
        assert_eq!(self.launch_versions.last(), Some(&r.version));
        self.console_versions.push(r.version.clone());
        if self.console_fails {
            Err("console unavailable".into())
        } else {
            Ok(())
        }
    }
    fn launch(&mut self, r: &UpdateRequest) -> std::result::Result<(), LaunchFailure> {
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&r.status_path).unwrap()).unwrap()["phase"],
            "restarting"
        );
        self.launch_versions.push(r.version.clone());
        if self.tamper_recovery_on_launch && r.version == "1.2.4" {
            write(
                &windows(r).recovery.as_ref().unwrap().installer_path,
                b"changed after install",
            );
        }
        assert_eq!(
            fs::read(windows(r).install_root.join("bin/codexhost.exe")).unwrap(),
            r.version.as_bytes()
        );
        match self.launches.remove(0) {
            LaunchResult::Ready => Ok(()),
            LaunchResult::NoChild => Err(LaunchFailure::NoChild(io::Error::from(
                io::ErrorKind::NotFound,
            ))),
            LaunchResult::Stopped => Err(LaunchFailure::OwnedLaunchStopped("not ready".into())),
            LaunchResult::Unknown(stage) => Err(LaunchFailure::Unproven(stage.into())),
        }
    }
}
#[test]
fn installation_failure_evidence_is_typed_and_channel_scoped_not_error_text() {
    let f = Fixture::new();
    let mut request = UpdateRequest::parse_windows_fixture(&f.request_path).unwrap();
    let npm_error = crate::npm_prepared::install_failure("same error text".into(), true);
    assert!(!stopped_install_tool(&request, npm_error.as_ref()));
    request.installation = Installation::Npm(serde_json::from_value(json!({
        "node_path":f.root.join("unused-node"),"npm_cli_path":f.root.join("unused-npm"),"npm_launcher_path":f.root.join("unused-wrapper")
    })).unwrap());
    assert!(stopped_install_tool(&request, npm_error.as_ref()));
    assert!(!stopped_install_tool(
        &request,
        crate::npm_prepared::install_failure("same error text".into(), false).as_ref()
    ));
    assert!(!stopped_install_tool(
        &request,
        crate::installer_recovery::stopped_failure("same error text".into()).as_ref()
    ));
    assert!(!stopped_install_tool(
        &request,
        Box::<dyn Error>::from("tool_stopped=true; original version restored").as_ref()
    ));
}

#[test]
fn complete_apply_success_releases_lock_only_after_target_ready() {
    let f = Fixture::new();
    let mut e = TestEffects {
        launches: vec![LaunchResult::Ready],
        ..Default::default()
    };
    f.run(&mut e).unwrap();
    f.assert_end(false, false);
    assert_eq!(f.status()["outcome"], "updated");
    assert_eq!(e.restore_calls, 0);
    assert_eq!(e.launch_versions, ["1.2.4"]);
    assert_eq!(e.console_versions, ["1.2.4"]);
}
#[test]
fn console_failure_does_not_revert_a_committed_update_or_restoration() {
    for restore in [false, true] {
        let f = Fixture::new();
        let mut e = TestEffects {
            install_result: if restore {
                InstallResult::PartialStopped
            } else {
                InstallResult::Ready
            },
            launches: vec![LaunchResult::Ready],
            console_fails: true,
            ..Default::default()
        };
        assert_eq!(f.run(&mut e).is_err(), restore);
        f.assert_end(restore, false);
        assert_eq!(e.restore_calls, usize::from(restore));
        assert_eq!(
            f.status()["outcome"],
            if restore { "restored" } else { "updated" }
        );
        assert_eq!(
            e.console_versions,
            [if restore { "1.2.3" } else { "1.2.4" }]
        );
    }
}
#[test]
fn partial_install_and_no_child_and_owned_cleanup_each_restore_once_then_report_failed() {
    for (install, launches) in [
        (InstallResult::PartialStopped, vec![LaunchResult::Ready]),
        (
            InstallResult::ZeroExitCorruptTarget,
            vec![LaunchResult::Ready],
        ),
        (
            InstallResult::ZeroExitCorruptMetadata,
            vec![LaunchResult::Ready],
        ),
        (
            InstallResult::Ready,
            vec![LaunchResult::NoChild, LaunchResult::Ready],
        ),
        (
            InstallResult::Ready,
            vec![LaunchResult::Stopped, LaunchResult::Ready],
        ),
    ] {
        let f = Fixture::new();
        let mut e = TestEffects {
            install_result: install,
            launches,
            ..Default::default()
        };
        assert!(
            f.run(&mut e)
                .unwrap_err()
                .to_string()
                .contains("original version restored and its Host is ready")
        );
        f.assert_end(true, false);
        assert_eq!(f.status()["outcome"], "restored");
        assert_eq!(e.restore_calls, 1);
        assert_eq!(e.launch_versions.last().unwrap(), "1.2.3");
        assert_eq!(e.console_versions, ["1.2.3"]);
        assert!(
            !f.root
                .join("custom install/app/plugins/next-only/plugin.mjs")
                .exists()
        );
    }
}
#[test]
fn original_launch_failure_never_recurses_and_retains_written_protection() {
    for failure in [LaunchResult::NoChild, LaunchResult::Unknown("bind")] {
        let f = Fixture::new();
        let mut e = TestEffects {
            launches: vec![LaunchResult::NoChild, failure],
            ..Default::default()
        };
        let error = f.run(&mut e).unwrap_err().to_string();
        assert!(error.contains("original software restored"));
        assert!(error.contains("recovery is not retried"));
        assert_eq!(f.status()["outcome"], "recovery-failed");
        f.assert_end(true, true);
        assert_eq!(e.restore_calls, 1);
        assert_eq!(e.launch_versions, ["1.2.4", "1.2.3"]);
        assert!(e.console_versions.is_empty());
    }
}
#[test]
fn capture_bind_or_cleanup_unknown_never_overwrites_the_new_installation() {
    for stage in ["capture", "Job setup", "bind", "cleanup"] {
        let f = Fixture::new();
        let mut e = TestEffects {
            launches: vec![LaunchResult::Unknown(stage)],
            ..Default::default()
        };
        assert!(f.run(&mut e).is_err());
        f.assert_end(true, true);
        assert_eq!(e.restore_calls, 0);
        assert!(e.console_versions.is_empty());
        assert_eq!(f.status()["outcome"], "unknown");
        assert_eq!(e.launch_versions, ["1.2.4"]);
        assert_eq!(
            fs::read(f.root.join("custom install/bin/codexhost.exe")).unwrap(),
            b"1.2.4"
        );
    }
}
#[test]
fn unknown_or_pending_installer_state_never_restores_or_launches() {
    for install in [InstallResult::Unknown, InstallResult::RestartPending] {
        let f = Fixture::new();
        let mut e = TestEffects {
            install_result: install,
            ..Default::default()
        };
        assert!(f.run(&mut e).is_err());
        f.assert_end(true, true);
        assert_eq!(e.restore_calls, 0);
        assert!(e.launch_versions.is_empty());
    }
}
#[test]
fn restoration_or_quiescence_failure_keeps_materials_and_final_failed_state() {
    for quiescent in [false, true] {
        let f = Fixture::new();
        let mut e = TestEffects {
            launches: vec![LaunchResult::NoChild],
            restore_fails: !quiescent,
            quiescent_fails: quiescent,
            ..Default::default()
        };
        assert!(
            f.run(&mut e)
                .unwrap_err()
                .to_string()
                .contains("materials retained")
        );
        f.assert_end(true, true);
        assert_eq!(e.restore_calls, usize::from(!quiescent));
        assert_eq!(e.launch_versions, ["1.2.4"]);
    }
}
#[test]
fn read_only_validation_failure_does_not_mark_written_or_attempt_recovery() {
    let f = Fixture::new();
    let mut e = TestEffects {
        install_result: InstallResult::ReadOnlyFailure,
        ..Default::default()
    };
    assert!(f.run(&mut e).is_err());
    f.assert_end(true, false);
    assert_eq!(e.restore_calls, 0);
    assert!(e.launch_versions.is_empty());
}
#[test]
fn changed_recovery_material_after_write_blocks_restore_and_preserves_new_files() {
    let f = Fixture::new();
    let mut e = TestEffects {
        launches: vec![LaunchResult::NoChild],
        tamper_recovery_on_launch: true,
        ..Default::default()
    };
    assert!(
        f.run(&mut e)
            .unwrap_err()
            .to_string()
            .contains("materials retained")
    );
    f.assert_end(true, true);
    assert_eq!(e.restore_calls, 1);
    assert_eq!(e.launch_versions, ["1.2.4"]);
    assert_eq!(
        fs::read(f.root.join("custom install/bin/codexhost.exe")).unwrap(),
        b"1.2.4"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn valid_request_still_requires_a_live_owner_before_handoff() {
    let f = Fixture::new();
    let error = crate::apply(&f.request_path).unwrap_err();
    assert!(error.to_string().contains("Launcher exited before"));
    assert_eq!(f.status()["phase"], "failed");
}

#[test]
fn malformed_request_and_changed_original_materials_fail_before_handoff() {
    for corrupt_request in [false, true] {
        let f = Fixture::new();
        if corrupt_request {
            let mut r: Value = serde_json::from_slice(&fs::read(&f.request_path).unwrap()).unwrap();
            r["schema_version"] = json!(9);
            write(&f.request_path, r.to_string());
        } else {
            write(
                &f.request_path.parent().unwrap().join("previous.exe"),
                b"changed",
            );
        }
        let mut e = TestEffects::default();
        assert!(f.run(&mut e).is_err());
        assert_eq!(f.status()["phase"], "prepared");
        let lock: Value =
            serde_json::from_slice(&fs::read(f.root.join("active-update-v1.lock")).unwrap())
                .unwrap();
        assert_eq!(lock["installationStarted"], false);
        assert!(e.launch_versions.is_empty());
        assert_eq!(e.restore_calls, 0);
    }
}
