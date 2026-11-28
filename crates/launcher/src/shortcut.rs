use std::env;
use std::error::Error;
use std::fs;
use std::io::{self, BufRead, ErrorKind, IsTerminal, Write};
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::installation_layout::is_source_checkout_build;
use crate::{
    NPM_LAUNCHER_PATH_ENV, NPM_NODE_PATH_ENV, NPM_PACKAGE_ROOT_ENV, host_service, startup_record,
};

const PROMPT_FILE: &str = "shortcut-prompt-v1.json";
const PROMPT_VERSION: u8 = 1;
const NO_PROMPT_ENV: &str = "CODEXHOST_NO_SHORTCUT_PROMPT";
#[cfg(any(target_os = "macos", test))]
const MACOS_SHORTCUT_DIR_ENV: &str = "CODEXHOST_SHORTCUT_DIR";
#[cfg(any(target_os = "macos", test))]
const MACOS_BUNDLE_NAME: &str = "codexhost.app";
#[cfg(any(target_os = "macos", test))]
const MACOS_MARKER_FILE: &str = ".codexhost-npm-shortcut";
#[cfg(target_os = "windows")]
const WINDOWS_DESKTOP_DIR_ENV: &str = "CODEXHOST_SHORTCUT_DESKTOP_DIR";
#[cfg(target_os = "windows")]
const WINDOWS_START_MENU_DIR_ENV: &str = "CODEXHOST_SHORTCUT_START_MENU_DIR";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PromptDecision {
    Installed,
    Declined,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptRecord {
    version: u8,
    decision: PromptDecision,
}

impl PromptRecord {
    fn new(decision: PromptDecision) -> Self {
        Self {
            version: PROMPT_VERSION,
            decision,
        }
    }

    fn read(data_dir: &Path) -> Result<Option<Self>, Box<dyn Error>> {
        let bytes = match fs::read(data_dir.join(PROMPT_FILE)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let record: Self = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Invalid {PROMPT_FILE}: {error}"))?;
        if record.version != PROMPT_VERSION {
            return Ok(None);
        }
        Ok(Some(record))
    }

    fn save(&self, data_dir: &Path) -> Result<(), Box<dyn Error>> {
        fs::create_dir_all(data_dir)?;
        host_service::publish_status(&data_dir.join(PROMPT_FILE), &serde_json::to_string(self)?)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortcutStatus {
    pub supported: bool,
    pub installed: bool,
    pub paths: Vec<PathBuf>,
    pub decision: Option<PromptDecision>,
}

impl ShortcutStatus {
    fn to_json(&self) -> Value {
        json!({
            "supported": self.supported,
            "installed": self.installed,
            "paths": self.paths.iter().map(|path| path.display().to_string()).collect::<Vec<_>>(),
            "decision": self.decision,
        })
    }
}

fn prefers_chinese() -> bool {
    for key in ["CODEXHOST_UI_LOCALE", "LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(value) = env::var(key) {
            let normalized = value.trim().to_ascii_lowercase();
            if normalized.starts_with("zh") {
                return true;
            }
            if !normalized.is_empty() && normalized != "c" && normalized != "posix" {
                return false;
            }
        }
    }
    false
}

fn parse_yes_no(input: &str) -> Option<bool> {
    match input.trim().to_ascii_lowercase().as_str() {
        "" | "y" | "yes" => Some(true),
        "n" | "no" => Some(false),
        _ => None,
    }
}

fn prompt_yes_no<R: BufRead, W: Write>(
    mut reader: R,
    mut writer: W,
    question: &str,
) -> io::Result<Option<bool>> {
    write!(writer, "{question}")?;
    writer.flush()?;
    let mut line = String::new();
    let bytes = reader.read_line(&mut line)?;
    if bytes == 0 {
        return Ok(None);
    }
    Ok(parse_yes_no(&line).or(Some(false)))
}

fn is_npm_installation() -> bool {
    let Some(package_root) = env::var_os(NPM_PACKAGE_ROOT_ENV) else {
        return false;
    };
    if package_root.is_empty() {
        return false;
    }
    env::current_exe()
        .map(|exe| !is_source_checkout_build(&exe))
        .unwrap_or(false)
}

fn interactive_prompt_allowed() -> bool {
    if !cfg!(any(target_os = "macos", target_os = "windows")) {
        return false;
    }
    if !is_npm_installation() {
        return false;
    }
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return false;
    }
    if env::var_os(NO_PROMPT_ENV).as_deref() == Some(std::ffi::OsStr::new("1")) {
        return false;
    }
    if env::var_os("CI").is_some()
        || env::var_os("SSH_CONNECTION").is_some()
        || env::var_os("SSH_TTY").is_some()
    {
        return false;
    }
    true
}

/// On the first interactive terminal launch of an npm installation on macOS or
/// Windows, ask whether to create a desktop/application shortcut icon.
pub fn maybe_prompt_on_first_run() {
    if !interactive_prompt_allowed() {
        return;
    }
    let Some(data_dir) = startup_record::data_directory() else {
        return;
    };
    if matches!(PromptRecord::read(&data_dir), Ok(Some(_))) {
        return;
    }
    if current_status(&data_dir).is_ok_and(|status| !status.supported || status.installed) {
        return;
    }

    let chinese = prefers_chinese();
    let question = if cfg!(target_os = "macos") {
        if chinese {
            "是否在「应用程序」(~/Applications) 创建 CodexHost 图标（支持 Spotlight 搜索）？[Y/n] "
        } else {
            "Create a CodexHost app icon in ~/Applications (for Spotlight & Launchpad)? [Y/n] "
        }
    } else if chinese {
        "是否在桌面和开始菜单创建 CodexHost 快捷方式？[Y/n] "
    } else {
        "Create Desktop and Start Menu shortcuts for CodexHost? [Y/n] "
    };

    let answer = match prompt_yes_no(io::stdin().lock(), io::stdout().lock(), question) {
        Ok(Some(choice)) => choice,
        _ => return,
    };

    if answer {
        match install_shortcuts() {
            Ok(paths) => {
                let _ = PromptRecord::new(PromptDecision::Installed).save(&data_dir);
                let joined = paths
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
                if chinese {
                    println!("已创建 CodexHost 图标：{joined}");
                    println!("随时可运行 `codexhost shortcut remove` 移除。");
                } else {
                    println!("Created CodexHost shortcut: {joined}");
                    println!("Run `codexhost shortcut remove` anytime to remove it.");
                }
            }
            Err(error) => {
                eprintln!("codexhost: could not create shortcut: {error}");
            }
        }
    } else {
        let _ = PromptRecord::new(PromptDecision::Declined).save(&data_dir);
        if chinese {
            println!("已跳过。随时可运行 `codexhost shortcut install` 创建图标。");
        } else {
            println!("Skipped. Run `codexhost shortcut install` anytime to create it later.");
        }
    }
}

pub fn run(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    let data_dir = startup_record::data_directory().ok_or("User data directory is unavailable")?;
    match arguments {
        [action] if action == "install" => {
            let paths = install_shortcuts()?;
            let _ = PromptRecord::new(PromptDecision::Installed).save(&data_dir);
            for path in paths {
                println!("{}", path.display());
            }
            Ok(())
        }
        [action] if action == "remove" => {
            let removed = remove_shortcuts()?;
            let _ = PromptRecord::new(PromptDecision::Declined).save(&data_dir);
            if removed.is_empty() {
                println!("no managed codexhost shortcut found");
            } else {
                for path in removed {
                    println!("removed {}", path.display());
                }
            }
            Ok(())
        }
        [action] if action == "status" => {
            let status = current_status(&data_dir)?;
            if !status.supported {
                println!("unsupported");
            } else if status.installed {
                println!(
                    "installed ({})",
                    status
                        .paths
                        .iter()
                        .map(|path| path.display().to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                );
            } else {
                println!("not-installed");
            }
            Ok(())
        }
        [action, flag] if action == "status" && flag == "--json" => {
            let status = current_status(&data_dir)?;
            println!("{}", status.to_json());
            Ok(())
        }
        _ => Err("usage: codexhost shortcut install|remove|status [--json]".into()),
    }
}

fn current_status(data_dir: &Path) -> Result<ShortcutStatus, Box<dyn Error>> {
    let decision = PromptRecord::read(data_dir)?.map(|record| record.decision);
    #[cfg(target_os = "macos")]
    {
        let bundle = macos_shortcut_bundle_path()?;
        let installed = is_managed_macos_shortcut(&bundle);
        Ok(ShortcutStatus {
            supported: true,
            installed,
            paths: if installed { vec![bundle] } else { Vec::new() },
            decision,
        })
    }
    #[cfg(target_os = "windows")]
    {
        let candidates = windows_shortcut_paths()?;
        let existing: Vec<PathBuf> = candidates
            .into_iter()
            .filter(|path| path.is_file())
            .collect();
        Ok(ShortcutStatus {
            supported: true,
            installed: !existing.is_empty(),
            paths: existing,
            decision,
        })
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(ShortcutStatus {
            supported: false,
            installed: false,
            paths: Vec::new(),
            decision,
        })
    }
}

#[cfg(any(target_os = "macos", test))]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(any(target_os = "macos", test))]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(any(target_os = "macos", test))]
fn macos_shortcut_info_plist(version: &str, has_icon: bool) -> String {
    let escaped_version = xml_escape(version);
    let icon_entry = if has_icon {
        "  <key>CFBundleIconFile</key>\n  <string>codexhost.icns</string>\n"
    } else {
        ""
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>codexhost</string>
  <key>CFBundleExecutable</key>
  <string>codexhost</string>
{icon_entry}  <key>CFBundleIdentifier</key>
  <string>com.codexhost.npm-shortcut</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>codexhost</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>{escaped_version}</string>
  <key>CFBundleVersion</key>
  <string>{escaped_version}</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>CodexHost uses the microphone for voice input.</string>
</dict>
</plist>
"#
    )
}

#[cfg(any(target_os = "macos", test))]
fn macos_shortcut_launcher_script(
    node_path: Option<&Path>,
    npm_launcher_path: Option<&Path>,
    executable_path: &Path,
) -> String {
    let mut lines = vec![
        "#!/bin/sh".to_string(),
        "set -eu".to_string(),
        format!("export {NO_PROMPT_ENV}=1"),
    ];
    if let (Some(node), Some(launcher)) = (node_path, npm_launcher_path) {
        if let Some(node_bin) = node.parent().and_then(|parent| parent.to_str()) {
            lines.push(format!(
                "export PATH={}:\"${{PATH:-/usr/bin:/bin:/usr/sbin:/sbin}}\"",
                shell_single_quote(node_bin)
            ));
        }
        let quoted_node = shell_single_quote(&node.to_string_lossy());
        let quoted_launcher = shell_single_quote(&launcher.to_string_lossy());
        lines.push(format!(
            "if [ -x {quoted_node} ] && [ -f {quoted_launcher} ]; then"
        ));
        lines.push(format!("  exec {quoted_node} {quoted_launcher} \"$@\""));
        lines.push("fi".to_string());
    }
    let quoted_exe = shell_single_quote(&executable_path.to_string_lossy());
    lines.push(format!("if [ -x {quoted_exe} ]; then"));
    lines.push(format!("  exec {quoted_exe} \"$@\""));
    lines.push("fi".to_string());
    lines.push("exec codexhost \"$@\"".to_string());
    lines.push(String::new());
    lines.join("\n")
}

#[cfg(target_os = "macos")]
fn macos_shortcut_bundle_path() -> Result<PathBuf, Box<dyn Error>> {
    if let Some(override_dir) = env::var_os(MACOS_SHORTCUT_DIR_ENV)
        && !override_dir.is_empty()
    {
        return Ok(PathBuf::from(override_dir).join(MACOS_BUNDLE_NAME));
    }
    let home = env::var_os("HOME").ok_or("HOME directory is unavailable")?;
    Ok(PathBuf::from(home)
        .join("Applications")
        .join(MACOS_BUNDLE_NAME))
}

#[cfg(any(target_os = "macos", test))]
fn is_managed_macos_shortcut(bundle: &Path) -> bool {
    bundle
        .join("Contents/Resources")
        .join(MACOS_MARKER_FILE)
        .is_file()
}

#[cfg(target_os = "macos")]
fn find_macos_icon_source(executable: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(package_root) = env::var_os(NPM_PACKAGE_ROOT_ENV) {
        let root = PathBuf::from(package_root);
        candidates.push(root.join("libexec/CodexHost.app/Contents/Resources/AppIcon.icns"));
    }
    if let Some(parent) = executable.parent().and_then(Path::parent) {
        candidates.push(parent.join("libexec/CodexHost.app/Contents/Resources/AppIcon.icns"));
        candidates.push(parent.join("Resources/codexhost.icns"));
        candidates.push(parent.join("Helpers/CodexHost.app/Contents/Resources/AppIcon.icns"));
    }
    candidates.into_iter().find(|candidate| candidate.is_file())
}

#[cfg(any(target_os = "macos", test))]
fn write_macos_shortcut_bundle(
    bundle: &Path,
    node_path: Option<&Path>,
    npm_launcher_path: Option<&Path>,
    executable_path: &Path,
    icon_source: Option<&Path>,
    version: &str,
) -> Result<(), Box<dyn Error>> {
    if bundle.exists() && !is_managed_macos_shortcut(bundle) {
        return Err(format!(
            "refusing to overwrite existing unmanaged app bundle at {}",
            bundle.display()
        )
        .into());
    }
    let parent = bundle
        .parent()
        .ok_or("shortcut bundle path has no parent directory")?;
    fs::create_dir_all(parent)?;
    let stage = parent.join(format!(".codexhost-shortcut-stage-{}", std::process::id()));
    let _ = fs::remove_dir_all(&stage);
    let contents = stage.join("Contents");
    let macos_dir = contents.join("MacOS");
    let resources_dir = contents.join("Resources");
    fs::create_dir_all(&macos_dir)?;
    fs::create_dir_all(&resources_dir)?;

    let mut has_icon = false;
    if let Some(icon) = icon_source
        && icon.is_file()
    {
        fs::copy(icon, resources_dir.join("codexhost.icns"))?;
        has_icon = true;
    }

    fs::write(contents.join("PkgInfo"), "APPL????")?;
    fs::write(
        contents.join("Info.plist"),
        macos_shortcut_info_plist(version, has_icon),
    )?;
    let launcher_script = macos_dir.join("codexhost");
    fs::write(
        &launcher_script,
        macos_shortcut_launcher_script(node_path, npm_launcher_path, executable_path),
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&launcher_script, fs::Permissions::from_mode(0o755))?;
    }
    fs::write(
        resources_dir.join(MACOS_MARKER_FILE),
        format!(
            "{{\"version\":1,\"managedBy\":\"codexhost-shortcut\",\"appVersion\":\"{version}\"}}\n"
        ),
    )?;

    if bundle.exists() {
        fs::remove_dir_all(bundle)?;
    }
    fs::rename(&stage, bundle)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_shortcuts() -> Result<Vec<PathBuf>, Box<dyn Error>> {
    let executable = env::current_exe()?.canonicalize()?;
    let node_path = env::var_os(NPM_NODE_PATH_ENV).map(PathBuf::from);
    let npm_launcher_path = env::var_os(NPM_LAUNCHER_PATH_ENV).map(PathBuf::from);
    let icon_source = find_macos_icon_source(&executable);
    let bundle = macos_shortcut_bundle_path()?;

    write_macos_shortcut_bundle(
        &bundle,
        node_path.as_deref(),
        npm_launcher_path.as_deref(),
        &executable,
        icon_source.as_deref(),
        env!("CARGO_PKG_VERSION"),
    )?;

    // Ad-hoc sign and register with LaunchServices so Spotlight/Launchpad index it immediately.
    let _ = Command::new("/usr/bin/codesign")
        .args(["--force", "--sign", "-"])
        .arg(&bundle)
        .status();
    let _ = Command::new(
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    )
    .args(["-f"])
    .arg(&bundle)
    .status();

    Ok(vec![bundle])
}

#[cfg(target_os = "macos")]
fn remove_shortcuts() -> Result<Vec<PathBuf>, Box<dyn Error>> {
    let bundle = macos_shortcut_bundle_path()?;
    if !bundle.exists() {
        return Ok(Vec::new());
    }
    if !is_managed_macos_shortcut(&bundle) {
        return Err(format!(
            "refusing to remove unmanaged app bundle at {}",
            bundle.display()
        )
        .into());
    }
    fs::remove_dir_all(&bundle)?;
    Ok(vec![bundle])
}

#[cfg(target_os = "windows")]
fn windows_shortcut_paths() -> Result<Vec<PathBuf>, Box<dyn Error>> {
    let desktop = if let Some(override_dir) = env::var_os(WINDOWS_DESKTOP_DIR_ENV)
        && !override_dir.is_empty()
    {
        PathBuf::from(override_dir)
    } else {
        let profile = env::var_os("USERPROFILE").ok_or("USERPROFILE is unavailable")?;
        PathBuf::from(profile).join("Desktop")
    };
    let start_menu = if let Some(override_dir) = env::var_os(WINDOWS_START_MENU_DIR_ENV)
        && !override_dir.is_empty()
    {
        PathBuf::from(override_dir)
    } else {
        let appdata = env::var_os("APPDATA").ok_or("APPDATA is unavailable")?;
        PathBuf::from(appdata).join(r"Microsoft\Windows\Start Menu\Programs")
    };
    Ok(vec![
        desktop.join("codexhost.lnk"),
        start_menu.join("codexhost.lnk"),
    ])
}

#[cfg(any(target_os = "windows", test))]
fn powershell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(any(target_os = "windows", test))]
fn build_windows_shortcut_script(
    shortcut_path: &Path,
    target_exe: &Path,
    working_dir: &Path,
) -> String {
    format!(
        "$shell = New-Object -ComObject WScript.Shell; \
         $shortcut = $shell.CreateShortcut({path}); \
         $shortcut.TargetPath = {target}; \
         $shortcut.Arguments = '--start-menu'; \
         $shortcut.WorkingDirectory = {workdir}; \
         $shortcut.IconLocation = {icon}; \
         $shortcut.Description = 'CodexHost'; \
         $shortcut.Save()",
        path = powershell_single_quote(&shortcut_path.to_string_lossy()),
        target = powershell_single_quote(&target_exe.to_string_lossy()),
        workdir = powershell_single_quote(&working_dir.to_string_lossy()),
        icon = powershell_single_quote(&format!("{},0", target_exe.to_string_lossy())),
    )
}

#[cfg(target_os = "windows")]
fn install_shortcuts() -> Result<Vec<PathBuf>, Box<dyn Error>> {
    let executable = env::current_exe()?.canonicalize()?;
    let working_dir = executable
        .parent()
        .and_then(Path::parent)
        .unwrap_or_else(|| executable.parent().unwrap_or(Path::new(".")));
    let paths = windows_shortcut_paths()?;
    for shortcut in &paths {
        if let Some(parent) = shortcut.parent() {
            fs::create_dir_all(parent)?;
        }
        let script = build_windows_shortcut_script(shortcut, &executable, working_dir);
        let status = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
            ])
            .arg(&script)
            .status()?;
        if !status.success() {
            return Err(format!(
                "could not create Windows shortcut at {} (exit {status})",
                shortcut.display()
            )
            .into());
        }
    }
    Ok(paths)
}

#[cfg(target_os = "windows")]
fn remove_shortcuts() -> Result<Vec<PathBuf>, Box<dyn Error>> {
    let mut removed = Vec::new();
    for shortcut in windows_shortcut_paths()? {
        if shortcut.is_file() {
            fs::remove_file(&shortcut)?;
            removed.push(shortcut);
        }
    }
    Ok(removed)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn install_shortcuts() -> Result<Vec<PathBuf>, Box<dyn Error>> {
    Err("desktop shortcuts are only supported on macOS and Windows".into())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn remove_shortcuts() -> Result<Vec<PathBuf>, Box<dyn Error>> {
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn yes_no_parser_defaults_empty_to_yes_and_handles_explicit_answers() {
        assert_eq!(parse_yes_no(""), Some(true));
        assert_eq!(parse_yes_no("\n"), Some(true));
        assert_eq!(parse_yes_no("y\n"), Some(true));
        assert_eq!(parse_yes_no("YES\r\n"), Some(true));
        assert_eq!(parse_yes_no("n\n"), Some(false));
        assert_eq!(parse_yes_no("No"), Some(false));
        assert_eq!(parse_yes_no("maybe"), None);
    }

    #[test]
    fn prompt_yes_no_reads_single_answer_and_handles_eof() {
        let mut out = Vec::new();
        assert_eq!(
            prompt_yes_no(Cursor::new(b"\n"), &mut out, "Install? [Y/n] ").unwrap(),
            Some(true)
        );
        assert_eq!(String::from_utf8(out).unwrap(), "Install? [Y/n] ");

        let mut out = Vec::new();
        assert_eq!(
            prompt_yes_no(Cursor::new(b"n\n"), &mut out, "Install? [Y/n] ").unwrap(),
            Some(false)
        );

        let mut out = Vec::new();
        assert_eq!(
            prompt_yes_no(Cursor::new(b""), &mut out, "Install? [Y/n] ").unwrap(),
            None
        );
    }

    #[test]
    fn prompt_record_persists_decision() {
        let dir = env::temp_dir().join(format!("codexhost-shortcut-prompt-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(PromptRecord::read(&dir).unwrap(), None);
        PromptRecord::new(PromptDecision::Installed)
            .save(&dir)
            .unwrap();
        assert_eq!(
            PromptRecord::read(&dir).unwrap().map(|r| r.decision),
            Some(PromptDecision::Installed)
        );
        PromptRecord::new(PromptDecision::Declined)
            .save(&dir)
            .unwrap();
        assert_eq!(
            PromptRecord::read(&dir).unwrap().map(|r| r.decision),
            Some(PromptDecision::Declined)
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn macos_shortcut_bundle_writes_valid_structure_and_guards_unmanaged_bundles() {
        let dir = env::temp_dir().join(format!("codexhost-shortcut-bundle-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let icon = dir.join("AppIcon.icns");
        fs::write(&icon, b"icns-fixture").unwrap();
        let bundle = dir.join(MACOS_BUNDLE_NAME);

        write_macos_shortcut_bundle(
            &bundle,
            Some(Path::new("/opt/node/bin/node")),
            Some(Path::new(
                "/opt/node/lib/node_modules/@codexhost/cli/bin/codexhost.js",
            )),
            Path::new("/opt/node/lib/node_modules/@codexhost/cli-darwin-arm64/bin/codexhost"),
            Some(&icon),
            "0.29.0",
        )
        .unwrap();

        assert!(is_managed_macos_shortcut(&bundle));
        let plist = fs::read_to_string(bundle.join("Contents/Info.plist")).unwrap();
        assert!(plist.contains("com.codexhost.npm-shortcut"));
        assert!(plist.contains("<string>codexhost.icns</string>"));
        assert!(bundle.join("Contents/Resources/codexhost.icns").is_file());
        let script = fs::read_to_string(bundle.join("Contents/MacOS/codexhost")).unwrap();
        assert!(script.contains("CODEXHOST_NO_SHORTCUT_PROMPT=1"));
        assert!(script.contains(
            "'/opt/node/bin/node' '/opt/node/lib/node_modules/@codexhost/cli/bin/codexhost.js'"
        ));

        // Overwriting a managed bundle succeeds.
        write_macos_shortcut_bundle(
            &bundle,
            None,
            None,
            Path::new("/usr/local/bin/codexhost"),
            None,
            "0.29.1",
        )
        .unwrap();
        assert!(
            fs::read_to_string(bundle.join("Contents/Info.plist"))
                .unwrap()
                .contains("0.29.1")
        );

        // Removing the marker turns it into an unmanaged bundle that must not be overwritten.
        fs::remove_file(bundle.join("Contents/Resources").join(MACOS_MARKER_FILE)).unwrap();
        let err = write_macos_shortcut_bundle(
            &bundle,
            None,
            None,
            Path::new("/usr/local/bin/codexhost"),
            None,
            "0.29.2",
        )
        .unwrap_err();
        assert!(err.to_string().contains("unmanaged app bundle"));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn windows_shortcut_script_escapes_single_quotes() {
        let script = build_windows_shortcut_script(
            Path::new(r"C:\Users\O'Brien\Desktop\codexhost.lnk"),
            Path::new(r"C:\Users\O'Brien\AppData\Roaming\npm\codexhost.exe"),
            Path::new(r"C:\Users\O'Brien\AppData\Roaming\npm"),
        );
        assert!(script.contains(r"'C:\Users\O''Brien\Desktop\codexhost.lnk'"));
        assert!(script.contains("$shortcut.Arguments = '--start-menu'"));
    }
}
