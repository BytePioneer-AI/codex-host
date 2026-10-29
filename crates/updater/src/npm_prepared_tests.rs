use super::*;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicUsize, Ordering};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture {
    root: PathBuf,
    prefix: PathBuf,
    materials: Materials,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "codexhost-npm-materials-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let prefix = root.join("current-prefix");
        let directory = root.join("npm");
        fs::create_dir_all(&prefix).unwrap();
        fs::create_dir_all(directory.join("cache")).unwrap();
        let archive = |name: &str| {
            let path = directory.join(name);
            fs::write(&path, b"fixture archive").unwrap();
            Archive {
                path,
                sha256: Sha256::digest(b"fixture archive")
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect(),
            }
        };
        let user = directory.join("user.npmrc");
        let global = directory.join("global.npmrc");
        fs::write(&user, "").unwrap();
        fs::write(&global, "").unwrap();
        Self {
            materials: Materials {
                unpacked_bytes: 1024,
                cli: archive("cli.tgz"),
                platform: archive("platform.tgz"),
                cache_path: directory.join("cache"),
                user_config_path: user,
                global_config_path: global,
            },
            root,
            prefix,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[test]
fn requires_the_complete_unchanged_local_set_before_any_install_command() {
    let f = Fixture::new();
    validate(&f.materials, &f.root, &f.prefix).unwrap();
    fs::write(&f.materials.cli.path, "changed").unwrap();
    assert!(
        validate(&f.materials, &f.root, &f.prefix)
            .unwrap_err()
            .to_string()
            .contains("SHA-256")
    );
    let f = Fixture::new();
    fs::remove_file(&f.materials.platform.path).unwrap();
    assert!(validate(&f.materials, &f.root, &f.prefix).is_err());
    let f = Fixture::new();
    fs::write(&f.materials.user_config_path, "prefix=another-prefix").unwrap();
    assert!(validate(&f.materials, &f.root, &f.prefix).is_err());
}
#[test]
fn pins_prefix_and_uses_strict_offline_without_optional_resolution_or_scripts() {
    let f = Fixture::new();
    let args = arguments(&f.materials, &f.prefix);
    for flag in [
        "--offline",
        "--ignore-scripts",
        "--omit=optional",
        "--update-notifier=false",
    ] {
        assert!(args.contains(&flag.into()));
    }
    assert!(!args.contains(&"--prefer-offline".into()));
    assert_eq!(args[3], f.prefix.as_os_str());
    assert_eq!(args[args.len() - 2], f.materials.cli.path.as_os_str());
    assert_eq!(args[args.len() - 1], f.materials.platform.path.as_os_str());
    let installation: crate::request::NpmInstallation = serde_json::from_value(serde_json::json!({"node_path":"/node","npm_cli_path":"/npm","npm_launcher_path":"/cli","prepared":null})).unwrap();
    assert!(installation.prepared.is_none());
}
#[test]
fn rejects_materials_inside_the_prefix_and_redirected_or_external_files() {
    let f = Fixture::new();
    assert!(validate(&f.materials, &f.root, &f.root).is_err());
    let mut f = Fixture::new();
    f.materials.platform.path = f.root.join("external.tgz");
    fs::write(&f.materials.platform.path, b"fixture archive").unwrap();
    assert!(validate(&f.materials, &f.root, &f.prefix).is_err());
    #[cfg(unix)]
    {
        let f = Fixture::new();
        fs::remove_file(&f.materials.cli.path).unwrap();
        std::os::unix::fs::symlink(&f.materials.platform.path, &f.materials.cli.path).unwrap();
        assert!(validate(&f.materials, &f.root, &f.prefix).is_err());
    }
}

#[test]
fn records_a_real_owned_tool_failure_only_after_its_partial_write_and_exit() {
    let f = Fixture::new();
    let script = f.root.join("fixture-npm.cjs");
    let marker = f.prefix.join("partial-write");
    fs::write(
        &script,
        format!(
            "require('node:fs').writeFileSync({}, 'partial'); process.exit(17);",
            serde_json::to_string(&marker).unwrap()
        ),
    )
    .unwrap();
    let mut marked = false;
    let error = install(
        Path::new("node"),
        &script,
        &f.materials,
        &f.prefix,
        &mut || {
            marked = true;
            Ok(())
        },
    )
    .unwrap_err();
    assert!(marked);
    assert_eq!(fs::read_to_string(marker).unwrap(), "partial");
    assert!(error.downcast_ref::<InstallFailure>().unwrap().tool_stopped);
}

#[test]
fn separates_old_materials_and_requires_a_confirmed_tool_exit_for_recovery() {
    let mut f = Fixture::new();
    let old = f.root.join("npm-previous");
    fs::rename(f.root.join("npm"), &old).unwrap();
    f.materials.cli.path = old.join("cli.tgz");
    f.materials.platform.path = old.join("platform.tgz");
    f.materials.user_config_path = old.join("user.npmrc");
    f.materials.global_config_path = old.join("global.npmrc");
    f.materials.cache_path = old.join("cache");
    validate_recovery(&f.materials, &f.root, &f.prefix).unwrap();
    assert!(validate(&f.materials, &f.root, &f.prefix).is_err());
    assert!(
        !install_failure("uncertain tool".into(), false)
            .downcast_ref::<InstallFailure>()
            .unwrap()
            .tool_stopped
    );
    assert!(
        install_failure("exited tool".into(), true)
            .downcast_ref::<InstallFailure>()
            .unwrap()
            .tool_stopped
    );
}

#[test]
#[ignore = "requires an isolated real-npm fixture from the TypeScript material tests"]
fn installs_real_prepared_npm_fixture() {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Request {
        operation: PathBuf,
        node: PathBuf,
        npm: PathBuf,
        prefix: PathBuf,
        materials: Materials,
        #[serde(default)]
        recovery: bool,
    }
    let file = std::env::var_os("CODEXHOST_NPM_FIXTURE_REQUEST").expect("fixture request path");
    let request: Request = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
    if request.recovery {
        let npm = crate::request::NpmInstallation {
            node_path: request.node,
            npm_cli_path: request.npm,
            npm_launcher_path: request.operation.join("unused-cli"),
            prefix: Some(request.prefix.canonicalize().unwrap()),
            package_root: None,
            installed_version: None,
            prepared: None,
            recovery: Some(Box::new(request.materials)),
        };
        crate::npm_recovery::restore(&npm, &request.operation).unwrap();
    } else {
        validate(&request.materials, &request.operation, &request.prefix).unwrap();
        install(
            &request.node,
            &request.npm,
            &request.materials,
            &request.prefix,
            &mut || Ok(()),
        )
        .unwrap();
    }
}
