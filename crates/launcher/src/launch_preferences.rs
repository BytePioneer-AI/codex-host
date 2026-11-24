use std::error::Error;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    discover_desktop, host_service, installation_layout::InstalledResources, startup_record,
};

const FILE: &str = "launch-preferences-v1.json";
const VERSION: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Surface {
    NativeShell,
    CodexDesktop,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    version: u8,
    pub default_desktop_surface: Surface,
    pub onboarding_completed: bool,
}

impl Preferences {
    pub fn new(surface: Surface, onboarding_completed: bool) -> Self {
        Self {
            version: VERSION,
            default_desktop_surface: surface,
            onboarding_completed,
        }
    }

    pub fn read(data: &Path) -> Result<Option<Self>, Box<dyn Error>> {
        let bytes = match fs::read(data.join(FILE)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let preferences: Self =
            serde_json::from_slice(&bytes).map_err(|error| format!("Invalid {FILE}: {error}"))?;
        if preferences.version != VERSION {
            return Err(format!("Unsupported {FILE} version: {}", preferences.version).into());
        }
        Ok(Some(preferences))
    }

    pub fn save(&self, data: &Path) -> Result<(), Box<dyn Error>> {
        fs::create_dir_all(data)?;
        host_service::publish_status(&data.join(FILE), &serde_json::to_string(self)?)
    }
}

fn status(
    preferences: Option<Preferences>,
    codex_desktop_installed: bool,
    desktop_shell_available: bool,
) -> Value {
    json!({
        "version": VERSION,
        "defaultDesktopSurface": preferences.map(|prefs| prefs.default_desktop_surface),
        "onboardingCompleted": preferences.is_some_and(|prefs| prefs.onboarding_completed),
        "codexDesktopInstalled": codex_desktop_installed,
        "desktopShellAvailable": desktop_shell_available,
    })
}

#[derive(Debug, PartialEq, Eq)]
enum Action {
    Get,
    Set(Preferences),
}

fn parse(arguments: &[String]) -> Result<Action, Box<dyn Error>> {
    if arguments == ["get", "--json"] {
        return Ok(Action::Get);
    }
    let Some((action, options)) = arguments.split_first() else {
        return Err("launch-prefs requires get or set".into());
    };
    if action != "set" {
        return Err("expected `launch-prefs get --json` or `launch-prefs set --surface <native-shell|codex-desktop>`".into());
    }
    let mut surface = None;
    let mut onboarding_completed = None;
    for option in options.chunks(2) {
        let [flag, value] = option else {
            return Err(format!("{} requires a value", option[0]).into());
        };
        match flag.as_str() {
            "--surface" if surface.is_none() => {
                surface = Some(match value.as_str() {
                    "native-shell" => Surface::NativeShell,
                    "codex-desktop" => Surface::CodexDesktop,
                    _ => return Err("--surface must be native-shell or codex-desktop".into()),
                });
            }
            "--onboarding-completed" if onboarding_completed.is_none() => {
                onboarding_completed = Some(
                    value
                        .parse::<bool>()
                        .map_err(|_| "--onboarding-completed must be true or false")?,
                );
            }
            _ => return Err(format!("Unknown or repeated launch-prefs option: {flag}").into()),
        }
    }
    Ok(Action::Set(Preferences::new(
        surface.ok_or("--surface is required")?,
        onboarding_completed.unwrap_or(true),
    )))
}

pub fn run(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    let action = parse(arguments)?;
    let data = startup_record::data_directory().ok_or("User data directory is unavailable")?;
    match action {
        Action::Get => {
            let preferences = Preferences::read(&data)?;
            let installed = InstalledResources::from_current_executable()?;
            println!(
                "{}",
                status(
                    preferences,
                    discover_desktop(None).is_ok(),
                    installed.desktop_shell.is_some(),
                )
            );
            Ok(())
        }
        Action::Set(preferences) => preferences.save(&data),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_preferences_report_no_choice_and_incomplete_onboarding() {
        let data =
            std::env::temp_dir().join(format!("codexhost-prefs-missing-{}", std::process::id()));
        assert_eq!(
            status(Preferences::read(&data).unwrap(), true, false),
            json!({
                "version": 1,
                "defaultDesktopSurface": null,
                "onboardingCompleted": false,
                "codexDesktopInstalled": true,
                "desktopShellAvailable": false,
            })
        );
    }

    #[test]
    fn save_replaces_preferences_with_private_versioned_json() {
        let data =
            std::env::temp_dir().join(format!("codexhost-prefs-save-{}", std::process::id()));
        Preferences::new(Surface::NativeShell, true)
            .save(&data)
            .unwrap();
        // An open Unix reader still sees the old file after atomic replacement.
        #[cfg(unix)]
        let old = fs::File::open(data.join(FILE)).unwrap();
        let new = Preferences::new(Surface::CodexDesktop, false);
        new.save(&data).unwrap();
        assert_eq!(Preferences::read(&data).unwrap(), Some(new));
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(data.join(FILE)).unwrap()).unwrap(),
            json!({"version": 1, "defaultDesktopSurface": "codex-desktop", "onboardingCompleted": false})
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(data.join(FILE)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
            let old: Preferences = serde_json::from_reader(old).unwrap();
            assert_eq!(old, Preferences::new(Surface::NativeShell, true));
        }
        assert_eq!(fs::read_dir(&data).unwrap().count(), 1);
        fs::remove_dir_all(&data).unwrap();
    }

    #[test]
    fn cli_accepts_only_valid_options_and_defaults_to_completed_onboarding() {
        let action =
            |args: &[&str]| parse(&args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>());
        assert_eq!(action(&["get", "--json"]).unwrap(), Action::Get);
        assert_eq!(
            action(&["set", "--surface", "native-shell"]).unwrap(),
            Action::Set(Preferences::new(Surface::NativeShell, true))
        );
        assert_eq!(
            action(&[
                "set",
                "--onboarding-completed",
                "false",
                "--surface",
                "codex-desktop"
            ])
            .unwrap(),
            Action::Set(Preferences::new(Surface::CodexDesktop, false))
        );
        for args in [
            &["get"][..],
            &["set", "--surface", "web"],
            &[
                "set",
                "--surface",
                "native-shell",
                "--onboarding-completed",
                "1",
            ],
            &[
                "set",
                "--surface",
                "native-shell",
                "--surface",
                "codex-desktop",
            ],
            &["set", "--surface"],
        ] {
            assert!(action(args).is_err(), "{args:?}");
        }
    }
}
