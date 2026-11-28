use std::env;
use std::error::Error;
use std::path::{Path, PathBuf};

use codexhost_platform::{
    inspect_macos_local_signing, remove_macos_local_signing, setup_macos_local_signing,
};

use crate::startup_record;

fn detect_default_macos_app_bundle() -> Option<PathBuf> {
    if let Ok(executable) = env::current_exe().and_then(|path| path.canonicalize())
        && let Some(macos_dir) = executable.parent()
        && macos_dir.file_name() == Some(std::ffi::OsStr::new("MacOS"))
        && let Some(contents_dir) = macos_dir.parent()
        && contents_dir.file_name() == Some(std::ffi::OsStr::new("Contents"))
        && let Some(app_bundle) = contents_dir.parent()
        && app_bundle.extension() == Some(std::ffi::OsStr::new("app"))
    {
        return Some(app_bundle.to_path_buf());
    }
    let system_app = PathBuf::from("/Applications/codexhost.app");
    if system_app.join("Contents/MacOS/codexhost").is_file() {
        return Some(system_app);
    }
    if let Some(home) = env::var_os("HOME") {
        let user_app = PathBuf::from(home).join("Applications/codexhost.app");
        if user_app.join("Contents/MacOS/codexhost").is_file() {
            return Some(user_app);
        }
    }
    None
}

fn parse_optional_app_flag(
    arguments: &[String],
) -> Result<(Option<PathBuf>, bool), Box<dyn Error>> {
    let mut app_path = None;
    let mut json = false;
    let mut index = 0;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--json" => {
                json = true;
                index += 1;
            }
            "--app" => {
                let value = arguments
                    .get(index + 1)
                    .ok_or("--app requires an absolute path to codexhost.app")?;
                let candidate = PathBuf::from(value);
                if !candidate.is_absolute() {
                    return Err("--app path must be absolute".into());
                }
                app_path = Some(candidate);
                index += 2;
            }
            other => {
                return Err(format!("unknown macos-signing option: {other}").into());
            }
        }
    }
    Ok((app_path, json))
}

fn resolve_app_path(explicit: Option<PathBuf>) -> Option<PathBuf> {
    explicit.or_else(detect_default_macos_app_bundle)
}

fn format_status_human(status: &codexhost_platform::MacOsLocalSigningStatus) -> String {
    if !status.supported {
        return "unsupported".to_string();
    }
    if !status.enabled {
        return "disabled".to_string();
    }
    let cert_state = if status.certificate_present {
        "certificate-ready"
    } else {
        "certificate-missing"
    };
    let app_state = if status.app_signed_with_local_cert {
        "app-signed"
    } else {
        "app-unsigned"
    };
    format!(
        "enabled ({}, {}, {})",
        status.certificate_name, cert_state, app_state
    )
}

pub fn run(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    let Some((action, rest)) = arguments.split_first() else {
        return Err(
            "usage: codexhost macos-signing status|setup|remove [--app <path>] [--json]".into(),
        );
    };
    let (explicit_app, json) = parse_optional_app_flag(rest)?;
    let data_dir = startup_record::data_directory().ok_or("User data directory is unavailable")?;
    let app_path = resolve_app_path(explicit_app);

    let status = match action.as_str() {
        "status" => inspect_macos_local_signing(&data_dir, app_path.as_deref())?,
        "setup" => {
            let target = app_path
                .ok_or("could not locate codexhost.app; pass --app /Applications/codexhost.app")?;
            setup_macos_local_signing(&data_dir, Path::new(&target))?
        }
        "remove" => remove_macos_local_signing(&data_dir, app_path.as_deref())?,
        _ => {
            return Err(
                "usage: codexhost macos-signing status|setup|remove [--app <path>] [--json]".into(),
            );
        }
    };

    if json {
        println!("{}", serde_json::to_string(&status)?);
    } else {
        println!("{}", format_status_human(&status));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_app_and_json_options() {
        let (app, json) = parse_optional_app_flag(&[
            "--json".into(),
            "--app".into(),
            "/Applications/codexhost.app".into(),
        ])
        .unwrap();
        assert!(json);
        assert_eq!(app, Some(PathBuf::from("/Applications/codexhost.app")));

        assert!(parse_optional_app_flag(&["--app".into(), "relative.app".into()]).is_err());
        assert!(parse_optional_app_flag(&["--unknown".into()]).is_err());
    }
}
