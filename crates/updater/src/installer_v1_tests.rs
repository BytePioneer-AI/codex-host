//! Source-built, version-matched Inno payloads. Never starts Codex Desktop.
use super::*;
struct Stop(std::process::Child);
impl Drop for Stop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[test]
#[ignore = "requires explicitly authorized disposable Windows user and source-built v1 installers"]
fn new_logic_installers_restore_their_actual_added_files() {
    assert_eq!(
        std::env::var("CODEXHOST_DISPOSABLE_WINDOWS_USER").as_deref(),
        Ok("fixture-only")
    );
    let config = PathBuf::from(std::env::var_os("CODEXHOST_INNO_FIXTURE").unwrap());
    let fixture: Fixture = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    let scratch = fs::canonicalize(std::env::var_os("RUNNER_TEMP").unwrap()).unwrap();
    assert!(crate::windows_installation::same_path(
        &fs::canonicalize(fixture.root.parent().unwrap()).unwrap(),
        &scratch
    ));
    assert!(!fixture.root.exists());
    for material in [&fixture.previous, &fixture.next] {
        assert_eq!(sha256_file(&material.path).unwrap(), material.sha256);
    }
    assert_eq!(fixture.previous.version, "99.0.1");
    assert_eq!(fixture.next.version, "99.0.2");
    let status=Command::new("reg.exe").args(["query",r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{8A7B4E80-A650-4D47-9D05-8D4D7F13E67E}_is1"]).status().unwrap();
    assert!(
        !status.success(),
        "disposable user must not already have codexhost"
    );
    fs::create_dir(&fixture.root).unwrap();
    let group = format!("codexhost-v1-fixture-{}", std::process::id());
    let _cleanup = Cleanup {
        root: fixture.root.clone(),
        rules: group.clone(),
    };
    for (n, m) in [&fixture.previous, &fixture.next].iter().enumerate() {
        powershell(&format!(
            "$ErrorActionPreference='Stop'; New-NetFirewallRule -DisplayName '{group}-{n}' -Group '{group}' -Direction Outbound -Action Block -Program {} -Profile Any | Out-Null",
            quoted(&m.path)
        ));
    }
    let target = fixture.root.join("target");
    let other = fixture.root.join("other");
    assert!(install(
        &fixture.previous,
        &other,
        &fixture.root.join("other.log")
    ));
    let other_before = snapshot(&other);
    let mut unrelated = Stop(
        Command::new(other.join("runtime/node.exe"))
            .args(["-e", "setInterval(()=>{},1000)"])
            .spawn()
            .unwrap(),
    );
    assert!(install(
        &fixture.previous,
        &target,
        &fixture.root.join("old.log")
    ));
    let user_plugin = target.join("app/plugins/user-owned/state.json");
    fs::create_dir_all(user_plugin.parent().unwrap()).unwrap();
    fs::write(&user_plugin, b"user plugin state").unwrap();
    let data = target.join("user-local-data/sentinel");
    fs::create_dir_all(data.parent().unwrap()).unwrap();
    fs::write(&data, b"custom-root user data").unwrap();
    let old_software = software_snapshot(&target);
    let operation = fixture.root.join("update-v1");
    fs::create_dir(&operation).unwrap();
    let material_json = operation.join("materials.json");
    let cli = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tools/update-fixtures/windows-installer.mjs");
    let status = Command::new("node")
        .arg(cli)
        .arg("prepare-v1-materials")
        .arg("--manifest")
        .arg(&config)
        .arg("--install-root")
        .arg(&target)
        .arg("--operation")
        .arg(&operation)
        .arg("--output")
        .arg(&material_json)
        .env(
            "CODEXHOST_PLUGIN_DIRECTORY",
            target.join("app/plugins/user-owned"),
        )
        .env("CODEXHOST_DATA_DIR", target.join("user-local-data"))
        .status()
        .unwrap();
    assert!(status.success());
    let materials: crate::installer_recovery::Materials =
        serde_json::from_slice(&fs::read(material_json).unwrap()).unwrap();
    // The COPIED material paths also receive scoped outbound denial; all install
    // and recovery tools run strictly from this already prepared local set.
    for (n, p) in [&materials.installer_path, &operation.join("update.exe")]
        .iter()
        .enumerate()
    {
        powershell(&format!(
            "$ErrorActionPreference='Stop'; New-NetFirewallRule -DisplayName '{group}-prepared-{n}' -Group '{group}' -Direction Outbound -Action Block -Program {} -Profile Any | Out-Null",
            quoted(p)
        ));
    }
    let request:crate::request::UpdateRequest=serde_json::from_value(serde_json::json!({
        "schema_version":1,"version":fixture.next.version,"wait_pid":std::process::id(),"wait_executable":target.join("bin/codexhost.exe"),
        "wait_started_at_micros":"1","runtime_descriptor_path":fixture.root.join("runtime.json"),"status_path":operation.join("status-v1.json"),
        "installation":{"kind":"windows-installer","installer_path":operation.join("update.exe"),"artifact_sha256":fixture.next.sha256,"install_root":target,"installed_version":fixture.previous.version,"recovery":serde_json::from_slice::<serde_json::Value>(&fs::read(operation.join("materials.json")).unwrap()).unwrap()}
    })).unwrap();
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
    while !ready.is_file() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(10));
    }
    let held = codexhost_platform::process_snapshot(holder.0.id()).unwrap();
    let failure = crate::install::install(&request, || Ok(())).unwrap_err();
    assert!(
        failure
            .downcast_ref::<crate::installer_recovery::ToolFailure>()
            .is_some_and(crate::installer_recovery::ToolFailure::may_restore),
        "installation failure is not proven recoverable: {failure}"
    );
    assert!(holder.0.try_wait().unwrap().is_none());
    assert_eq!(
        codexhost_platform::process_snapshot(holder.0.id())
            .unwrap()
            .started_at_micros,
        held.started_at_micros
    );
    fs::write(release, "release").unwrap();
    assert!(holder.0.wait().unwrap().success());
    crate::installer_recovery::restore_files(&request).unwrap();
    assert_eq!(software_snapshot(&target), old_software);
    let mut written = false;
    crate::install::install(&request, || {
        written = true;
        Ok(())
    })
    .unwrap();
    assert!(written);
    assert_eq!(version(&target), fixture.next.version);
    let added = target.join("app/plugins/fixture-next-only/owned-software.txt");
    assert!(
        added.is_file(),
        "actual next Inno payload did not install its declared added file"
    );
    // Capturable partial-software failure after the real tool exited. The new
    // plugin file above came from Inno, not this fault injection.
    fs::write(
        target.join("app/host-runtime.mjs"),
        b"injected partial write",
    )
    .unwrap();
    assert_eq!(
        crate::installer_recovery::restore_files(&request).unwrap(),
        fixture.previous.version
    );
    assert!(!added.exists());
    assert_eq!(software_snapshot(&target), old_software);
    assert_eq!(fs::read(&user_plugin).unwrap(), b"user plugin state");
    assert_eq!(fs::read(&data).unwrap(), b"custom-root user data");
    assert!(unrelated.0.try_wait().unwrap().is_none());
    assert_eq!(snapshot(&other), other_before);
    unrelated.0.kill().unwrap();
    unrelated.0.wait().unwrap();
    fs::write(fixture.root.join("recovery-evidence.json"),serde_json::json!({"fixture":"source-built-v1","oldVersion":fixture.previous.version,"nextVersion":fixture.next.version,"foreignLockHolderSurvived":true,"realNextInstallerAddedFileRemoved":true,"completeOldSoftwareRestored":true,"userPluginsAndCustomRootDataPreserved":true,"otherInstallationUnchanged":true,"codexStartupVerified":false}).to_string()).unwrap();
}
