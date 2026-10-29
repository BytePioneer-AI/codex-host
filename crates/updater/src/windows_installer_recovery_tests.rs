//! Actual Inno materials only; opt-in disposable Windows-user fixture. Never
//! starts Codex Desktop or copies registry/shortcut metadata back by hand.
use super::*;
use serde::Deserialize;
use std::path::PathBuf;
use std::{
    os::windows::fs::OpenOptionsExt,
    thread,
    time::{Duration, Instant},
};
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Material {
    path: PathBuf,
    sha256: String,
    version: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Fixture {
    previous: Material,
    next: Material,
    root: PathBuf,
}
fn powershell(script: &str) {
    let exe = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let status = Command::new(exe)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ])
        .status()
        .unwrap();
    assert!(status.success(), "fixture PowerShell failed");
}
fn quoted(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "''"))
}
struct Cleanup {
    root: PathBuf,
    rules: String,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        if self.root.join("target/unins000.exe").is_file() {
            let _ = Command::new(self.root.join("target/unins000.exe"))
                .args([
                    "/VERYSILENT",
                    "/SUPPRESSMSGBOXES",
                    "/NORESTART",
                    "/NOCLOSEAPPLICATIONS",
                    "/NORESTARTAPPLICATIONS",
                ])
                .status();
        }
        let script = format!(
            "Get-NetFirewallRule -Group '{}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule",
            self.rules
        );
        let _ = std::panic::catch_unwind(|| powershell(&script));
    }
}
fn install(material: &Material, target: &Path, log: &Path) -> bool {
    let mut command = Command::new(&material.path);
    command
        .args(windows_installer_arguments(
            &crate::request::WindowsInstallation {
                installer_path: material.path.clone(),
                artifact_sha256: material.sha256.clone(),
                install_root: target.into(),
                recovery: None,
                installed_version: None,
            },
        ))
        .arg("/NOICONS")
        .arg(format!("/LOG={}", log.display()));
    codexhost_platform::configure_background_command(&mut command);
    let mut child = command.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status.success();
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("fixture Inno exceeded its budget");
        }
        thread::sleep(Duration::from_millis(50));
    }
}
fn snapshot(root: &Path) -> Vec<(PathBuf, String)> {
    fn walk(root: &Path, p: &Path, out: &mut Vec<(PathBuf, String)>) {
        for entry in fs::read_dir(p).unwrap() {
            let p = entry.unwrap().path();
            if p.is_dir() {
                walk(root, &p, out)
            } else {
                out.push((
                    p.strip_prefix(root).unwrap().into(),
                    sha256_file(&p).unwrap(),
                ));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort();
    out
}
fn software_snapshot(target: &Path) -> Vec<(PathBuf, String)> {
    // Inno maintains its own uninstaller/ledger. Compare every other payload
    // byte, not just version metadata or the existing Host file.
    snapshot(target)
        .into_iter()
        .filter(|(path, _)| {
            !["unins000.exe", "unins000.dat", "unins000.msg"]
                .iter()
                .any(|name| path == Path::new(name))
        })
        .collect()
}
fn version(target: &Path) -> String {
    serde_json::from_slice::<serde_json::Value>(
        &fs::read(target.join("app/codexhost-distribution.json")).unwrap(),
    )
    .unwrap()["version"]
        .as_str()
        .unwrap()
        .into()
}
#[test]
#[ignore = "requires local old/new real installers, disposable Windows profile and scoped firewall authorization"]
fn original_channel_offline_downgrade_and_partial_write_repair() {
    assert_eq!(
        std::env::var("CODEXHOST_DISPOSABLE_WINDOWS_USER").as_deref(),
        Ok("fixture-only")
    );
    let config = PathBuf::from(
        std::env::var_os("CODEXHOST_INNO_FIXTURE").expect("prepared fixture manifest"),
    );
    let fixture: Fixture = serde_json::from_slice(&fs::read(config).unwrap()).unwrap();
    for m in [&fixture.previous, &fixture.next] {
        assert!(m.path.is_absolute());
        assert_eq!(sha256_file(&m.path).unwrap(), m.sha256);
        crate::request::validate_version(&m.version).unwrap();
    }
    assert_ne!(fixture.previous.path, fixture.next.path);
    assert_ne!(fixture.previous.version, fixture.next.version);
    let temp = std::env::var_os("RUNNER_TEMP").expect("disposable runner scratch directory");
    assert!(fixture.root.is_absolute());
    let parent = fs::canonicalize(fixture.root.parent().expect("fixture root parent")).unwrap();
    assert!(
        crate::windows_installation::same_path(&parent, &fs::canonicalize(temp).unwrap()),
        "fixture root must be a direct child of RUNNER_TEMP"
    );
    assert!(
        !fixture.root.exists(),
        "never adopt an existing installation/root"
    );
    // Product AppId must not already be registered in this user. This test is
    // not permitted to replace a developer's actual installation.
    let status=Command::new("reg.exe").args(["query",r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{8A7B4E80-A650-4D47-9D05-8D4D7F13E67E}_is1"]).status().unwrap();
    assert!(!status.success(), "user already has codexhost installed");
    fs::create_dir(&fixture.root).unwrap();
    let group = format!("codexhost-fixture-{}", std::process::id());
    let _cleanup = Cleanup {
        root: fixture.root.clone(),
        rules: group.clone(),
    };
    for (index, m) in [&fixture.previous, &fixture.next].iter().enumerate() {
        powershell(&format!(
            "$ErrorActionPreference='Stop'; New-NetFirewallRule -DisplayName '{}-{index}' -Group '{}' -Direction Outbound -Action Block -Program {} -Profile Any | Out-Null",
            group,
            group,
            quoted(&m.path)
        ));
    }
    let target = fixture.root.join("target");
    let other = fixture.root.join("other-installation");
    assert!(install(
        &fixture.previous,
        &other,
        &fixture.root.join("other-install.log")
    ));
    let other_before = snapshot(&other);
    let other_node = Command::new(other.join("runtime/node.exe"))
        .args(["-e", "setInterval(()=>{},1000)"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    struct Stop(std::process::Child);
    impl Drop for Stop {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut other_node = Stop(other_node);
    let user = fixture.root.join("user-data");
    fs::create_dir(&user).unwrap();
    fs::write(user.join("sentinel"), b"user data is not software rollback").unwrap();
    let user_before = snapshot(&user);
    assert!(install(
        &fixture.previous,
        &target,
        &fixture.root.join("previous-install.log")
    ));
    assert_eq!(version(&target), fixture.previous.version);
    let original_software = software_snapshot(&target);
    assert!(install(
        &fixture.next,
        &target,
        &fixture.root.join("upgrade.log")
    ));
    assert_eq!(version(&target), fixture.next.version);
    let next_software = software_snapshot(&target);
    let introduced: Vec<_> = next_software
        .iter()
        .filter(|(path, _)| !original_software.iter().any(|(old, _)| old == path))
        .map(|(path, _)| path.clone())
        .collect();
    // Controlled new-version software-file injection guarantees this boundary
    // is tested even when the two published payloads have identical path sets.
    let added_plugin = target.join("app/plugins/codexhost-fixture-new/plugin.mjs");
    fs::create_dir_all(added_plugin.parent().unwrap()).unwrap();
    fs::write(&added_plugin, b"export const fixtureNewSoftware = true;\n").unwrap();
    assert!(install(
        &fixture.previous,
        &target,
        &fixture.root.join("downgrade.log")
    ));
    assert_eq!(version(&target), fixture.previous.version);
    let downgrade_complete = software_snapshot(&target) == original_software;
    // A distinct executable outside target holds the file. It must survive
    // silent Inno, not just the verified target-image shutdown in #640.
    let ready = fixture.root.join("holder-ready");
    let release = fixture.root.join("holder-release");
    let mut holder = Stop(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "install::installer_recovery_tests::foreign_file_holder",
                "--ignored",
                "--nocapture",
            ])
            .env("CODEXHOST_INNO_LOCK_FILE", target.join("bin/codexhost.exe"))
            .env("CODEXHOST_INNO_LOCK_READY", &ready)
            .env("CODEXHOST_INNO_LOCK_RELEASE", &release)
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready.exists() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(10));
    }
    let holder_identity = codexhost_platform::process_snapshot(holder.0.id()).unwrap();
    assert!(!install(
        &fixture.next,
        &target,
        &fixture.root.join("partial-failure.log")
    ));
    assert!(
        holder.0.try_wait().unwrap().is_none(),
        "silent installer terminated the unrelated lock holder"
    );
    assert_eq!(
        codexhost_platform::process_snapshot(holder.0.id())
            .unwrap()
            .started_at_micros,
        holder_identity.started_at_micros
    );
    fs::write(release, "release").unwrap();
    assert!(holder.0.wait().unwrap().success());
    // Explicit software-write fault injection; no registry/shortcut snapshots.
    fs::write(
        target.join("app/host-runtime.mjs"),
        b"injected partial software write",
    )
    .unwrap();
    assert!(install(
        &fixture.previous,
        &target,
        &fixture.root.join("repair.log")
    ));
    assert_eq!(version(&target), fixture.previous.version);
    let repair_complete = software_snapshot(&target) == original_software;
    assert!(other_node.0.try_wait().unwrap().is_none());
    assert_eq!(snapshot(&other), other_before);
    assert_eq!(snapshot(&user), user_before);
    // Inno owns this metadata throughout; only inspect the original tool's result.
    let output=Command::new("reg.exe").args(["query",r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{8A7B4E80-A650-4D47-9D05-8D4D7F13E67E}_is1","/v","DisplayVersion"]).output().unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains(&fixture.previous.version));
    fs::write(
        fixture.root.join("recovery-evidence.json"),
        serde_json::json!({
            "introducedPublishedSoftwarePaths": introduced,
            "injectedNewPluginPath": added_plugin,
            "directDowngradeComplete": downgrade_complete,
            "partialWriteRepairComplete": repair_complete,
            "foreignLockHolderSurvived": true,
            "otherInstallationAndUserDataUnchanged": true,
            "newSoftwareFileRemoved": !added_plugin.exists(),
        })
        .to_string(),
    )
    .unwrap();
    // Metadata or restored existing files alone cannot authorize production
    // recovery. Do not manually delete new software to make this assertion pass.
    assert!(
        downgrade_complete && repair_complete && !added_plugin.exists(),
        "original installer did not restore the complete old software set; inspect recovery-evidence.json; automatic EXE recovery remains unsupported"
    );
}

#[path = "installer_v1_tests.rs"]
mod v1;

#[test]
#[ignore = "child of the authorized Inno fixture only"]
fn foreign_file_holder() {
    assert_eq!(
        std::env::var("CODEXHOST_DISPOSABLE_WINDOWS_USER").as_deref(),
        Ok("fixture-only")
    );
    let _locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(PathBuf::from(
            std::env::var_os("CODEXHOST_INNO_LOCK_FILE").unwrap(),
        ))
        .unwrap();
    fs::write(
        PathBuf::from(std::env::var_os("CODEXHOST_INNO_LOCK_READY").unwrap()),
        "ready",
    )
    .unwrap();
    let release = PathBuf::from(std::env::var_os("CODEXHOST_INNO_LOCK_RELEASE").unwrap());
    let deadline = Instant::now() + Duration::from_secs(420);
    while !release.exists() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(20));
    }
}
