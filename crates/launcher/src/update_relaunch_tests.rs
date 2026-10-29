use super::*;

#[test]
#[ignore = "spawned by the Updater relaunch fixture; never activates real Desktop"]
fn policy_child() {
    let arguments: Vec<String> = serde_json::from_slice(
        &std::fs::read(env::var_os("CODEXHOST_RELAUNCH_ARGUMENTS").unwrap()).unwrap(),
    )
    .unwrap();
    let launch_arguments = if arguments.first().map(String::as_str) == Some("launch") {
        &arguments[1..]
    } else {
        &arguments
    };
    let options = parse_launch_options(launch_arguments).unwrap();
    let expected = env::var("CODEXHOST_EXPECT_PRESERVED").unwrap() == "1";
    let pid = env::var("CODEXHOST_UNOWNED_FIXTURE_PID")
        .unwrap()
        .parse()
        .unwrap();
    let existing = codexhost_platform::process_snapshot(pid).unwrap();
    let launcher = codexhost_platform::process_snapshot(std::process::id()).unwrap();
    let concurrent = std::process::Command::new("node")
        .args(["-e", "setInterval(()=>{},1000)"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    struct Stop(std::process::Child);
    impl Drop for Stop {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let concurrent_identity = codexhost_platform::process_snapshot(concurrent.id()).unwrap();
    assert!(concurrent_identity.started_at_micros >= launcher.started_at_micros);
    let _stop = Stop(concurrent);
    struct ErrorCleanup(codexhost_platform::ProcessSnapshot);
    impl Drop for ErrorCleanup {
        fn drop(&mut self) {
            let _ = codexhost_platform::terminate_process_instance(&self.0, true);
        }
    }
    for fail_lower_layer in [false, true] {
        let mut entered = false;
        let result = launch_policy::enter_desktop_launch(options.preserve_external_desktop, || {
            entered = true;
            if fail_lower_layer {
                // Representative platform error cleanup, scoped only to this
                // test's Node. Protected launch must not even construct it.
                let _cleanup = ErrorCleanup(concurrent_identity.clone());
                return Err("simulated activation/ownership error with destructive Drop".into());
            }
            if !expected {
                codexhost_platform::terminate_process_instance(&existing, true)?;
            }
            Ok(())
        });
        assert_eq!(entered, !expected);
        assert_eq!(result.is_err(), expected || fail_lower_layer);
        if expected {
            assert!(codexhost_platform::process_exists(existing.id));
            assert!(codexhost_platform::process_exists(concurrent_identity.id));
        }
    }
    #[cfg(target_os = "windows")]
    if expected {
        // Exercise the real Windows entry, before resource discovery, attaching,
        // activation, ownership-error cleanup, or Job assignment can run.
        let error = launch(options, false).unwrap_err().to_string();
        assert!(error.contains("pre-execution whole-tree isolation"));
        assert!(codexhost_platform::process_exists(existing.id));
        assert!(codexhost_platform::process_exists(concurrent_identity.id));
    }
}
