use super::*;
use std::{
    fs,
    process::Child,
    sync::atomic::{AtomicUsize, Ordering},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture {
    root: PathBuf,
    npm: NpmInstallation,
    children: Vec<Child>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "npm-recovery-scope-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("prefix")).unwrap();
        let root = root.canonicalize().unwrap();
        let prefix = root.join("prefix");
        let npm = NpmInstallation {
            node_path: "node".into(),
            npm_cli_path: root.join("unused-npm"),
            npm_launcher_path: prefix.join("node_modules/@codexhost/cli/bin/codexhost.js"),
            package_root: Some(prefix.join("node_modules/@codexhost/cli-win32-x64")),
            prefix: Some(prefix),
            installed_version: Some("1.2.3".into()),
            prepared: None,
            recovery: None,
        };
        let result = Self {
            root,
            npm,
            children: Vec::new(),
        };
        for file in recovery_entries(&result.npm, "x64").unwrap() {
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, "fixture").unwrap();
        }
        result
    }
    fn arguments(&self, script: &Path) -> Vec<OsString> {
        vec![
            self.npm.node_path.as_os_str().to_owned(),
            script.as_os_str().to_owned(),
        ]
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for child in &mut self.children {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn recovery_scope_survives_missing_cli_host_and_entire_platform_packages() {
    let f = Fixture::new();
    let expected = recovery_entries(&f.npm, "x64").unwrap();
    assert_eq!(expected.len(), 7);
    assert!(entries(&f.npm).is_ok());
    for file in [
        &f.npm.npm_launcher_path,
        &f.npm
            .package_root
            .as_ref()
            .unwrap()
            .join("app/host-runtime.mjs"),
    ] {
        fs::remove_file(file).unwrap();
        assert!(entries(&f.npm).is_err());
        assert_eq!(recovery_entries(&f.npm, "x64").unwrap(), expected);
        assert!(recovery_script_belongs(&f.arguments(file), &expected).unwrap());
    }
    fs::remove_dir_all(f.npm.prefix.as_ref().unwrap().join("node_modules")).unwrap();
    assert_eq!(recovery_entries(&f.npm, "x64").unwrap(), expected);
    for file in &expected {
        assert!(recovery_script_belongs(&f.arguments(file), &expected).unwrap());
    }
    let foreign = f
        .root
        .join("other-prefix/node_modules/@codexhost/cli/bin/codexhost.js");
    assert!(!recovery_script_belongs(&f.arguments(&foreign), &expected).unwrap());
}

#[test]
fn recovery_scope_rejects_directories_at_script_paths_and_files_at_ancestors() {
    for directory_at_script in [true, false] {
        let f = Fixture::new();
        let file = f
            .npm
            .package_root
            .as_ref()
            .unwrap()
            .join("app/host-runtime.mjs");
        if directory_at_script {
            fs::remove_file(&file).unwrap();
            fs::create_dir(&file).unwrap();
        } else {
            fs::remove_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file.parent().unwrap(), "not a directory").unwrap();
        }
        assert!(recovery_entries(&f.npm, "x64").is_err());
    }
}

#[cfg(unix)]
#[test]
fn recovery_observes_a_deleted_script_invoked_through_an_existing_prefix_alias() {
    let f = Fixture::new();
    let scripts = recovery_entries(&f.npm, "x64").unwrap();
    let prefix = f.npm.prefix.as_ref().unwrap();
    let alias = f.root.join("alias");
    std::os::unix::fs::symlink(prefix, &alias).unwrap();
    let script = alias.join(scripts[1].strip_prefix(prefix).unwrap());
    fs::remove_file(&scripts[1]).unwrap();
    assert!(recovery_script_belongs(&f.arguments(&script), &scripts).unwrap());
}

#[cfg(unix)]
#[test]
fn recovery_scope_rejects_redirected_existing_ancestors_even_when_scripts_are_missing() {
    for redirected_prefix in [true, false] {
        let f = Fixture::new();
        let target = f.root.join("foreign");
        fs::create_dir(&target).unwrap();
        let directory = if redirected_prefix {
            f.npm.prefix.as_ref().unwrap().clone()
        } else {
            f.npm.package_root.as_ref().unwrap().join("app")
        };
        fs::remove_dir_all(&directory).unwrap();
        std::os::unix::fs::symlink(&target, &directory).unwrap();
        assert!(recovery_entries(&f.npm, "x64").is_err());
    }
}

#[test]
fn recovery_recognizes_only_the_actual_script_not_node_options_or_script_arguments() {
    let f = Fixture::new();
    let scripts = recovery_entries(&f.npm, "x64").unwrap();
    let script = &scripts[0];
    fs::remove_file(script).unwrap();
    for flag in ["--", "--disable-warning=UNDICI-EHPA"] {
        let args = vec!["node".into(), flag.into(), script.as_os_str().to_owned()];
        assert!(recovery_script_belongs(&args, &scripts).unwrap());
    }
    for flag in ["--eval", "--require"] {
        let args = vec!["node".into(), flag.into(), script.as_os_str().to_owned()];
        assert!(!recovery_script_belongs(&args, &scripts).unwrap());
    }
    let mut args = f.arguments(&f.root.join("unrelated.mjs"));
    args.push(script.as_os_str().to_owned());
    assert!(!recovery_script_belongs(&args, &scripts).unwrap());
}

#[cfg(target_os = "windows")]
#[test]
fn windows_recovery_blocks_live_unlinked_scripts_in_both_layouts_without_stopping_any_process() {
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    let mut f = Fixture::new();
    let scripts = recovery_entries(&f.npm, crate::windows_installation::architecture()).unwrap();
    let foreign = f.root.join("foreign.mjs");
    let mut spawn = |script: &Path, marker: &Path| {
        fs::create_dir_all(script.parent().unwrap()).unwrap();
        fs::write(script, format!("import fs from 'node:fs'; fs.writeFileSync({}, 'ready'); setInterval(()=>{{}},1000);", serde_json::to_string(marker).unwrap())).unwrap();
        let mut child = Command::new("node")
            .arg(codexhost_platform::node_entrypoint_path(script))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !marker.is_file() {
            assert!(child.try_wait().unwrap().is_none());
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        f.npm.node_path = codexhost_platform::process_snapshot(child.id())
            .unwrap()
            .executable;
        f.children.push(child);
    };
    spawn(&foreign, &f.root.join("foreign-ready"));
    spawn(&scripts[1], &f.root.join("hoisted-ready"));
    spawn(&scripts[4], &f.root.join("nested-ready"));
    fs::remove_dir_all(f.npm.prefix.as_ref().unwrap().join("node_modules")).unwrap();
    for index in [1, 2] {
        assert!(
            ensure_quiescent(&f.npm)
                .unwrap_err()
                .to_string()
                .contains("still held")
        );
        for child in &mut f.children[index..] {
            assert!(child.try_wait().unwrap().is_none());
        }
        assert!(f.children[0].try_wait().unwrap().is_none());
        f.children[index].kill().unwrap();
        f.children[index].wait().unwrap();
    }
    ensure_quiescent(&f.npm).unwrap();
    assert!(f.children[0].try_wait().unwrap().is_none());
}
