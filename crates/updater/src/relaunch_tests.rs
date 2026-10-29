use super::*;
use std::path::PathBuf;

#[test]
#[ignore = "requires CODEXHOST_LAUNCHER_TEST_BINARY; runs only isolated Node/Launcher policy fixtures"]
fn update_and_recovery_relaunch_preserve_an_unowned_desktop() {
    let launcher = PathBuf::from(
        std::env::var_os("CODEXHOST_LAUNCHER_TEST_BINARY").expect("Launcher test binary"),
    );
    let root =
        std::env::temp_dir().join(format!("codexhost-relaunch-policy-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(root.clone());
    let loop_script = root.join("official-fixture.cjs");
    fs::write(&loop_script, "setInterval(() => {},1000)").unwrap();
    let bridge = root.join("npm-wrapper.cjs");
    fs::write(&bridge, format!(r#"const fs=require('node:fs'),cp=require('node:child_process');
fs.writeFileSync(process.env.CODEXHOST_RELAUNCH_ARGUMENTS,JSON.stringify(process.argv.slice(2)));
const child=cp.spawnSync({},['--exact','update_relaunch_tests::policy_child','--ignored','--nocapture'],{{env:process.env,stdio:'inherit'}});process.exit(child.status??1);"#, serde_json::to_string(&launcher).unwrap())).unwrap();
    for (windows, version) in [(true, "1.2.4"), (true, "1.2.3"), (false, "1.2.3")] {
        let mut official = Command::new("node").arg(&loop_script).spawn().unwrap();
        struct Stop<'a>(&'a mut Child);
        impl Drop for Stop<'_> {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let official = Stop(&mut official);
        let request = UpdateRequest {
            schema_version: 1,
            version: version.into(),
            wait_pid: 1,
            wait_executable: root.join("unused"),
            launch_via_launcher: false,
            wait_started_at_micros: None,
            runtime_descriptor_path: root.join("runtime"),
            status_path: root.join("status"),
            installation: Installation::Npm(NpmInstallation {
                node_path: "node".into(),
                npm_cli_path: root.join("unused-npm"),
                npm_launcher_path: bridge.clone(),
                prefix: None,
                package_root: None,
                installed_version: None,
                prepared: None,
                recovery: None,
            }),
        };
        // These variables configure the fixture, not the production launch policy.
        let mut command = relaunch_command(&request, windows);
        command
            .env("CODEXHOST_RELAUNCH_ARGUMENTS", root.join("arguments.json"))
            .env("CODEXHOST_UNOWNED_FIXTURE_PID", official.0.id().to_string())
            .env(
                "CODEXHOST_EXPECT_PRESERVED",
                if windows { "1" } else { "0" },
            );
        command.stdout(Stdio::inherit()).stderr(Stdio::inherit());
        assert!(command.status().unwrap().success());
        if windows {
            assert!(official.0.try_wait().unwrap().is_none());
        }
    }
}
