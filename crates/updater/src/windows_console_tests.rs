use super::*;
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    fs,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "update-console-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        Self {
            root: root.canonicalize().unwrap(),
        }
    }
    fn request(&self, npm: bool, version: &str) -> (UpdateRequest, PathBuf) {
        let prefix = self.root.join("prefix");
        let resources = if npm {
            prefix.join("node_modules/@codexhost/cli-win32-x64")
        } else {
            self.root.join("installer")
        };
        fs::create_dir_all(resources.join("app")).unwrap();
        fs::create_dir_all(resources.join("bin")).unwrap();
        fs::write(resources.join("bin/codexhost.exe"), "fixture").unwrap();
        fs::write(
            resources.join("app/console-server.mjs"),
            format!(
                r#"
import fs from 'node:fs';
fs.writeFileSync(process.env.CONSOLE_TEST_RESULT, JSON.stringify({{
 version: {}, args: process.argv.slice(2), launcher: process.env.CODEXHOST_LAUNCHER_EXECUTABLE,
 platform: process.env.CODEXHOST_NPM_PACKAGE_ROOT, cli: process.env.CODEXHOST_NPM_LAUNCHER_PATH,
 data: process.env.CODEXHOST_DATA_DIR, port: process.env.CODEXHOST_CONSOLE_PORT
}}));
"#,
                serde_json::to_string(version).unwrap()
            ),
        )
        .unwrap();
        let node = Command::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .unwrap();
        assert!(node.status.success());
        let node = PathBuf::from(String::from_utf8(node.stdout).unwrap().trim());
        let installation = if npm {
            json!({"kind":"npm", "node_path":node,"npm_cli_path":self.root.join("npm/bin/npm-cli.js"),"npm_launcher_path":prefix.join("node_modules/@codexhost/cli/bin/codexhost.js"),"prefix":prefix,"package_root":prefix.join("node_modules/@codexhost/cli/node_modules/@codexhost/cli-win32-x64")})
        } else {
            json!({"kind":"windows-installer", "install_root":resources,"installer_path":self.root.join("installer.exe"),"artifact_sha256":"ab".repeat(32)})
        };
        let request = serde_json::from_value(json!({"schema_version":1,"version":version,"wait_pid":1,"wait_executable":self.root.join("old.exe"),"runtime_descriptor_path":self.root.join("runtime.json"),"status_path":self.root.join("status.json"),"installation":installation})).unwrap();
        (request, resources)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn environment(command: &Command, key: &str) -> Option<Option<OsString>> {
    command
        .get_envs()
        .find(|(name, _)| *name == OsStr::new(key))
        .map(|(_, value)| value.map(OsStr::to_os_string))
}

#[test]
fn starts_the_current_npm_console_with_hoisted_paths_and_preserves_user_configuration() {
    for version in ["1.2.4", "1.2.3"] {
        let f = Fixture::new();
        let (request, resources) = f.request(true, version);
        let mut command = console_command(&request, "x64", None).unwrap().unwrap();
        let result = f.root.join("result.json");
        command
            .env("CONSOLE_TEST_RESULT", &result)
            .env("CODEXHOST_DATA_DIR", f.root.join("data"))
            .env("CODEXHOST_CONSOLE_PORT", "4567");
        assert!(command.status().unwrap().success());
        let result: Value = serde_json::from_slice(&fs::read(result).unwrap()).unwrap();
        assert_eq!(result["version"], version);
        assert_eq!(result["args"], json!(["serve"]));
        assert_eq!(result["platform"], resources.to_str().unwrap());
        assert_eq!(
            result["launcher"],
            resources.join("bin/codexhost.exe").to_str().unwrap()
        );
        assert_eq!(
            result["cli"],
            f.root
                .join("prefix/node_modules/@codexhost/cli/bin/codexhost.js")
                .to_str()
                .unwrap()
        );
        assert_eq!(result["data"], f.root.join("data").to_str().unwrap());
        assert_eq!(result["port"], "4567");
    }
}

#[test]
fn installer_console_uses_its_own_node_and_drops_inherited_npm_routing() {
    let f = Fixture::new();
    let (request, resources) = f.request(false, "1.2.4");
    let command = console_command(&request, "x64", None).unwrap().unwrap();
    assert_eq!(command.get_program(), resources.join("runtime/node.exe"));
    assert_eq!(
        command.get_args().collect::<Vec<_>>(),
        vec![
            OsStr::new("--disable-warning=UNDICI-EHPA"),
            codexhost_platform::node_entrypoint_path(&resources.join("app/console-server.mjs"))
                .as_os_str(),
            OsStr::new("serve")
        ]
    );
    assert_eq!(command.get_current_dir(), Some(resources.as_path()));
    for key in [
        "CODEXHOST_NPM_PACKAGE_ROOT",
        "CODEXHOST_NPM_NODE_PATH",
        "CODEXHOST_NPM_CLI_PATH",
        "CODEXHOST_NPM_LAUNCHER_PATH",
    ] {
        assert_eq!(environment(&command, key), Some(None));
    }
}

#[test]
fn disabled_console_does_not_require_or_launch_console_files() {
    let f = Fixture::new();
    let (request, resources) = f.request(true, "1.2.4");
    fs::remove_dir_all(resources).unwrap();
    assert!(
        console_command(&request, "x64", Some(OsStr::new("0")))
            .unwrap()
            .is_none()
    );
    assert!(console_command(&request, "x64", None).is_err());
}

#[cfg(unix)]
#[test]
fn refuses_a_redirected_console_entry() {
    let f = Fixture::new();
    let (request, resources) = f.request(true, "1.2.4");
    let entry = resources.join("app/console-server.mjs");
    let foreign = f.root.join("foreign.mjs");
    fs::write(&foreign, "throw Error('must not execute')").unwrap();
    fs::remove_file(&entry).unwrap();
    std::os::unix::fs::symlink(&foreign, &entry).unwrap();
    assert!(console_command(&request, "x64", None).is_err());
    assert!(foreign.is_file());
}
