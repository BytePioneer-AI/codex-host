use super::*;

fn wait_for(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "missing fixture marker: {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn orphaned_descendant(parent_exits_before_observation: bool) {
    let (mut fixture, check) = fixture("ready", true);
    check.wait(Duration::from_secs(8)).unwrap();
    let pid_file = fixture.root.join("tree-pids.json");
    let release = fixture.root.join("release-intermediate");
    let exited = fixture.root.join("intermediate-exited");
    let intermediate = fixture.root.join("intermediate.cjs");
    fs::write(&intermediate,r#"const cp=require('node:child_process'),fs=require('node:fs');
const b=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});b.unref();
fs.writeFileSync(process.argv[2]+'.tmp',JSON.stringify({a:process.pid,b:b.pid}));fs.renameSync(process.argv[2]+'.tmp',process.argv[2]);
const timer=setInterval(()=>{if(fs.existsSync(process.argv[3]))clearInterval(timer)},10);"#).unwrap();
    let source = format!(
        r#"const cp=require('node:child_process'),fs=require('node:fs');
const a=cp.spawn(process.execPath,[{},{},{}],{{stdio:'ignore'}});
a.on('exit',()=>fs.writeFileSync({},'reaped'));setInterval(()=>{{}},1000);"#,
        serde_json::to_string(&intermediate).unwrap(),
        serde_json::to_string(&pid_file).unwrap(),
        serde_json::to_string(&release).unwrap(),
        serde_json::to_string(&exited).unwrap()
    );
    let root = Command::new("node")
        .args(["-e", &source])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let root_id = root.id();
    fixture.children.push(root);
    wait_for(&pid_file);
    let pids: serde_json::Value = serde_json::from_slice(&fs::read(&pid_file).unwrap()).unwrap();
    let a = process_snapshot(pids["a"].as_u64().unwrap() as u32).unwrap();
    fixture.owned.push(a.clone());
    let b = process_snapshot(pids["b"].as_u64().unwrap() as u32).unwrap();
    fixture.owned.push(b.clone());
    assert_eq!(a.parent_id, root_id);
    assert_eq!(b.parent_id, a.id);
    if !parent_exits_before_observation {
        // Observation begins with A visible, but the next descendant enumeration
        // can occur after A exits. Keeping root alive does not close that gap.
        assert_eq!(process_snapshot(root_id).unwrap().id, root_id);
        assert!(codexhost_platform::process_exists(a.id));
        assert!(check.stop_failed_launch().is_err());
    }
    fs::write(&release, "exit").unwrap();
    wait_for(&exited);
    assert!(!codexhost_platform::process_exists(a.id));
    let observed_root = process_snapshot(root_id).unwrap();
    assert!(codexhost_platform::process_exists(b.id));
    let file = fixture.root.join("diagnostics/launcher-startup-v1.json");
    let mut data: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    // A legacy claim, even with a matching root identity, is not an isolation
    // witness and must never authorize restoration over the surviving B.
    data["records"][0]["desktop"] = serde_json::json!({"process":{"pid":root_id,"startedAtMicros":observed_root.started_at_micros.to_string(),"executable":observed_root.executable},"cleanupComplete":true});
    fs::write(&file, data.to_string()).unwrap();
    assert!(
        check
            .stop_failed_launch()
            .unwrap_err()
            .to_string()
            .contains("pre-execution whole-tree isolation")
    );
    assert!(codexhost_platform::process_exists(root_id));
    assert!(codexhost_platform::process_exists(b.id));
    fixture.children.last_mut().unwrap().kill().unwrap();
    fixture.children.last_mut().unwrap().wait().unwrap();
    codexhost_platform::terminate_process_instance(&fixture.owned[0], true).unwrap();
    fixture.children[0].wait().unwrap();
    fixture.children[1].kill().unwrap();
    fixture.children[1].wait().unwrap();
    for outcome in ["ready", "attached", "failed"] {
        data["records"][0]["outcome"] = outcome.into();
        fs::write(&file, data.to_string()).unwrap();
        assert!(check.stop_failed_launch().is_err());
        assert!(codexhost_platform::process_exists(b.id));
    }
    fs::remove_file(&file).unwrap();
    assert!(check.stop_failed_launch().is_err());
}
#[cfg(target_os = "windows")]
#[test]
fn caller_held_job_not_persisted_flags_controls_cleanup_admission() {
    let (mut fixture, mut check) = fixture("ready", true);
    check.wait(Duration::from_secs(8)).unwrap();
    let job = codexhost_platform::WindowsLaunchJob::create_unique().unwrap();
    let mut command = Command::new("node");
    command
        .args(["-e", "setInterval(()=>{},1000)"])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut own = job.spawn_supervised(&mut command).unwrap();
    check.job = Some(job);
    let file = fixture.root.join("diagnostics/launcher-startup-v1.json");
    let mut data: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    data["records"][0]["launchJob"] = "ff".repeat(16).into();
    data["records"][0]["desktop"] = serde_json::json!({"cleanupComplete":true});
    fs::write(&file, data.to_string()).unwrap();
    assert!(check.stop_failed_launch().is_err());
    assert!(own.try_wait().unwrap().is_none());
    own.force_terminate().unwrap();
    own.wait_for_tree_exit(Duration::from_secs(2)).unwrap();
    assert!(check.job.as_ref().unwrap().had_bound_processes().unwrap());
    data["records"][0]
        .as_object_mut()
        .unwrap()
        .remove("launchJob");
    fs::write(&file, data.to_string()).unwrap();
    let native = fixture.owned[0].clone();
    let mut wrapper = fixture.children.remove(0);
    let observer = std::thread::spawn(move || {
        // Fixture-only exit notification substitutes for the real Launcher's
        // Job monitor. Native Job membership/termination itself is not mocked.
        std::thread::sleep(Duration::from_millis(100));
        codexhost_platform::terminate_process_instance(&native, true).unwrap();
        wrapper.wait().unwrap();
    });
    check.stop_failed_launch().unwrap();
    observer.join().unwrap();
    own.wait_for_tree_exit(Duration::from_secs(2)).unwrap();
    assert!(
        fixture.children[0].try_wait().unwrap().is_none(),
        "unassigned Host fixture must not be killed; production quiescence check blocks its overwrite separately"
    );
    let fresh = codexhost_platform::WindowsLaunchJob::create_unique().unwrap();
    data["records"][0]["launchJob"] = fresh.key().into();
    check.job = Some(fresh);
    fs::write(&file, data.to_string()).unwrap();
    assert!(
        check.stop_failed_launch().is_err(),
        "a persisted key cannot manufacture a native binding"
    );
}

#[test]
fn refuses_tree_completeness_when_intermediate_exits_before_observation() {
    orphaned_descendant(true);
}
#[test]
fn refuses_tree_completeness_when_intermediate_exits_during_observation() {
    orphaned_descendant(false);
}
