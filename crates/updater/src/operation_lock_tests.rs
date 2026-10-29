use super::*;
use crate::request::{Installation, NpmInstallation, WindowsInstallation};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicUsize, Ordering};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture {
    root: PathBuf,
    request: UpdateRequest,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "codexhost-handoff-lock-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let operation = root.join("update-1.2.3-fixture");
        fs::create_dir_all(&operation).unwrap();
        let status_path = operation.join("status-v1.json");
        fs::write(&status_path, "prepared").unwrap();
        let owner = process_snapshot(std::process::id()).unwrap();
        let record = Record {
            owner_pid: owner.id,
            owner_started_at_micros: owner.started_at_micros.to_string(),
            status_path: status_path.clone(),
            operation_id: "fixture-operation".into(),
            installation_started: false,
        };
        fs::write(
            root.join("active-update-v1.lock"),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
        Self {
            request: UpdateRequest {
                schema_version: 1,
                version: "1.2.3".into(),
                wait_pid: owner.id,
                wait_executable: owner.executable.clone(),
                launch_via_launcher: false,
                wait_started_at_micros: Some(owner.started_at_micros.to_string()),
                runtime_descriptor_path: root.join("runtime.json"),
                status_path,
                installation: Installation::Npm(NpmInstallation {
                    node_path: owner.executable.clone(),
                    npm_cli_path: owner.executable.clone(),
                    npm_launcher_path: owner.executable,
                    prefix: None,
                    package_root: None,
                    installed_version: None,
                    prepared: None,
                    recovery: None,
                }),
            },
            root,
        }
    }
    fn prepare_windows_installer(&mut self) {
        let install_root = self.root.join("原安装 中文 空格");
        fs::create_dir_all(install_root.join("app")).unwrap();
        fs::create_dir_all(install_root.join("bin")).unwrap();
        self.request.wait_executable = install_root.join("bin/codexhost.exe");
        fs::write(&self.request.wait_executable, b"fixture Launcher").unwrap();
        fs::write(install_root.join("app/codexhost-distribution.json"), serde_json::json!({
            "schemaVersion":1,"version":"1.2.3","distribution":"installer","target":"windows-x64"
        }).to_string()).unwrap();
        let installer_path = self.root.join("prepared.exe");
        fs::write(&installer_path, b"prepared installer").unwrap();
        self.request.version = "1.2.4".into();
        self.request.installation = Installation::WindowsInstaller(WindowsInstallation {
            installer_path,
            install_root,
            recovery: None,
            installed_version: Some("1.2.3".into()),
            artifact_sha256: Sha256::digest(b"prepared installer")
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
        });
    }

    fn record(&self) -> Record {
        read(&self.root.join("active-update-v1.lock")).unwrap()
    }
    fn write(&self, record: &Record) {
        fs::write(
            self.root.join("active-update-v1.lock"),
            serde_json::to_vec(record).unwrap(),
        )
        .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[test]
fn handoff_owns_the_same_operation_and_releases_only_before_writing() {
    let fixture = Fixture::new();
    let lock = OperationLock::take(&fixture.request).unwrap();
    assert_eq!(fixture.record().operation_id, "fixture-operation");
    assert_eq!(fixture.record().owner_pid, std::process::id());
    drop(lock);
    assert!(!fixture.root.join("active-update-v1.lock").exists());
}
#[test]
fn owner_instance_requires_pid_creation_time_and_executable() {
    let fixture = Fixture::new();
    let current = process_snapshot(std::process::id()).unwrap();
    assert!(fixture.request.matches_wait_instance(&current));
    let mut reused = current.clone();
    reused.started_at_micros += 1;
    assert!(!fixture.request.matches_wait_instance(&reused));
    reused = current.clone();
    reused.id += 1;
    assert!(!fixture.request.matches_wait_instance(&reused));
    reused = current;
    reused.executable = fixture.root.join("unrelated.exe");
    assert!(!fixture.request.matches_wait_instance(&reused));
}

#[test]
fn pid_reuse_and_another_operation_are_not_valid_handoffs() {
    let fixture = Fixture::new();
    let mut record = fixture.record();
    record.owner_started_at_micros = "1".into();
    fixture.write(&record);
    assert!(OperationLock::take(&fixture.request).is_err());
    record.owner_started_at_micros = process_snapshot(std::process::id())
        .unwrap()
        .started_at_micros
        .to_string();
    record.status_path = fixture.root.join("other.json");
    fs::write(&record.status_path, "fixture").unwrap();
    fixture.write(&record);
    assert!(OperationLock::take(&fixture.request).is_err());
}
#[test]
fn a_failed_or_interrupted_replacement_retains_its_lock_and_materials() {
    let fixture = Fixture::new();
    let mut lock = OperationLock::take(&fixture.request).unwrap();
    lock.mark_installing().unwrap();
    drop(lock);
    assert!(fixture.record().installation_started);
    assert!(fixture.request.status_path.exists());
}
fn assert_read_validation_failure_is_retryable(corrupt_hash: bool) {
    let mut fixture = Fixture::new();
    fixture.prepare_windows_installer();
    let initial = fixture.record();
    let mut ownership = OperationLock::take(&fixture.request).unwrap();
    let Installation::WindowsInstaller(windows) = &fixture.request.installation else {
        panic!("installer fixture missing")
    };
    crate::windows_installation::validate_installer(
        windows,
        "x64",
        &fixture.request.wait_executable,
    )
    .unwrap();
    if corrupt_hash {
        fs::write(&windows.installer_path, b"changed after preparation").unwrap();
    } else {
        fs::write(windows.install_root.join("app/codexhost-distribution.json"), serde_json::json!({
            "schemaVersion":1,"version":"9.9.9","distribution":"installer","target":"windows-x64"
        }).to_string()).unwrap();
    }
    let result = crate::install::install_windows_with_runner(
        &fixture.request,
        windows,
        "x64",
        &mut || {
            panic!("readonly validation must not cross the write boundary");
        },
        |_, _| panic!("installer must not be executed"),
    );
    let message = result.unwrap_err().to_string();
    assert!(
        message.contains(if corrupt_hash {
            "SHA-256 mismatch"
        } else {
            "identity changed"
        }),
        "{message}"
    );
    assert!(!fixture.record().installation_started);
    drop(ownership);
    assert!(!fixture.root.join("active-update-v1.lock").exists());
    fixture.prepare_windows_installer();
    fixture.write(&initial);
    ownership = OperationLock::take(&fixture.request).unwrap();
    let Installation::WindowsInstaller(windows) = &fixture.request.installation else {
        unreachable!()
    };
    let retry = crate::install::install_windows_with_runner(
        &fixture.request,
        windows,
        "x64",
        &mut || Err("retry reached the write boundary".into()),
        |_, _| panic!("fixture retry stops before execution"),
    );
    assert_eq!(
        retry.unwrap_err().to_string(),
        "retry reached the write boundary"
    );
    assert!(!fixture.record().installation_started);
    drop(ownership);
    assert!(!fixture.root.join("active-update-v1.lock").exists());
}

#[test]
fn final_artifact_hash_failure_does_not_mark_installing_and_allows_retry() {
    assert_read_validation_failure_is_retryable(true);
}

#[test]
fn final_installation_identity_failure_does_not_mark_installing_and_allows_retry() {
    assert_read_validation_failure_is_retryable(false);
}

#[cfg(target_os = "windows")]
#[test]
fn npm_final_ownership_failure_does_not_cross_the_write_boundary() {
    let fixture = Fixture::new();
    let mut ownership = OperationLock::take(&fixture.request).unwrap();
    let result = crate::install::install(&fixture.request, || ownership.mark_installing());
    assert!(result.unwrap_err().to_string().contains("prefix"));
    assert!(!fixture.record().installation_started);
    drop(ownership);
    assert!(!fixture.root.join("active-update-v1.lock").exists());
}

#[test]
fn actual_target_write_failure_retains_the_installation_protection() {
    let mut fixture = Fixture::new();
    fixture.prepare_windows_installer();
    let mut ownership = OperationLock::take(&fixture.request).unwrap();
    let Installation::WindowsInstaller(windows) = &fixture.request.installation else {
        unreachable!()
    };
    let target = windows.install_root.join("app/codexhost-distribution.json");
    let result = crate::install::install_windows_with_runner(
        &fixture.request,
        windows,
        "x64",
        &mut || ownership.mark_installing(),
        |_, _| {
            assert!(fixture.record().installation_started);
            fs::write(&target, b"partial replacement")?;
            Err("fixture installer failed after writing".into())
        },
    );
    assert!(result.is_err());
    drop(ownership);
    assert_eq!(fs::read(target).unwrap(), b"partial replacement");
    assert!(fixture.record().installation_started);
}

#[test]
fn completion_releases_its_operation_but_a_stale_owner_cannot_release_a_new_one() {
    let fixture = Fixture::new();
    let mut lock = OperationLock::take(&fixture.request).unwrap();
    lock.mark_installing().unwrap();
    lock.finish().unwrap();
    assert!(!fixture.root.join("active-update-v1.lock").exists());
    let second = Fixture::new();
    let mut old = OperationLock::take(&second.request).unwrap();
    let mut replacement = second.record();
    replacement.operation_id = "another-operation".into();
    second.write(&replacement);
    assert!(old.mark_installing().is_err());
    assert!(old.finish().is_err());
    drop(old);
    assert_eq!(second.record().operation_id, "another-operation");
}
