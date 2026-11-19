use std::ffi::OsString;
use std::path::Path;

const PATH_OVERRIDES: [&str; 5] = [
    "HOME",
    "USERPROFILE",
    "ZDOTDIR",
    "CODEX_HOME",
    "CODEX_ELECTRON_USER_DATA_PATH",
];

/// LaunchServices/AppX do not inherit the launcher's environment. Forward only
/// explicit directory overrides, never arbitrary variables or authentication
/// material: macOS passes these entries through `open --env` arguments.
pub(crate) fn forwarded(
    variables: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    let variables = variables.into_iter().collect::<Vec<_>>();
    if variables
        .iter()
        .any(|(name, value)| name == "CODEXHOST_REMOTE_SSH_MANAGED" && value == "1")
    {
        return Vec::new();
    }
    variables
        .into_iter()
        .filter(|(name, value)| {
            PATH_OVERRIDES.iter().any(|expected| name == *expected)
                && Path::new(value).is_absolute()
        })
        .collect()
}

/// Electron's app-level userData override does not redirect Chromium's early
/// session storage by itself. Match the official Desktop's isolated launch:
/// provide the same explicit profile as a Chromium argument as well.
/// On Linux Wayland sessions, enable the native Ozone platform and Wayland text-input
/// flags so IME candidate windows render with transparent visuals instead of opaque borders.
pub(crate) fn launch_arguments(
    base: &[OsString],
    environment: &[(OsString, OsString)],
) -> Vec<OsString> {
    let mut arguments = base.to_vec();
    if let Some((_, directory)) = environment.iter().find(|(name, directory)| {
        name == "CODEX_ELECTRON_USER_DATA_PATH" && Path::new(directory).is_absolute()
    }) {
        let mut argument = OsString::from("--user-data-dir=");
        argument.push(directory);
        arguments.push(argument);
    }
    #[cfg(target_os = "linux")]
    append_linux_wayland_arguments(&mut arguments, environment);
    arguments
}

#[cfg(target_os = "linux")]
fn append_linux_wayland_arguments(
    arguments: &mut Vec<OsString>,
    environment: &[(OsString, OsString)],
) {
    if arguments
        .iter()
        .any(|arg| arg.to_string_lossy().starts_with("--ozone-platform"))
    {
        return;
    }
    if environment.iter().any(|(name, value)| {
        name == "CODEXHOST_DISABLE_WAYLAND" && (value == "1" || value == "true")
    }) {
        return;
    }
    let is_wayland = environment.iter().any(|(name, value)| {
        (name == "WAYLAND_DISPLAY" && !value.is_empty())
            || (name == "XDG_SESSION_TYPE" && value == "wayland")
    });
    if is_wayland {
        arguments.push(OsString::from("--ozone-platform=wayland"));
        if !arguments.iter().any(|arg| arg == "--enable-wayland-ime") {
            arguments.push(OsString::from("--enable-wayland-ime"));
        }
        if !arguments.iter().any(|arg| {
            arg.to_string_lossy()
                .starts_with("--wayland-text-input-version")
        }) {
            arguments.push(OsString::from("--wayland-text-input-version=3"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{forwarded, launch_arguments};
    use std::ffi::OsString;

    #[test]
    fn rejects_relative_paths_and_unrelated_secrets() {
        let root = std::env::temp_dir().join("synthetic-desktop");
        let expected = (OsString::from("CODEX_HOME"), root.into_os_string());
        assert_eq!(
            forwarded([
                expected.clone(),
                (OsString::from("HOME"), OsString::from("relative")),
                (
                    OsString::from("CODEX_ELECTRON_USER_DATA_PATH"),
                    OsString::new()
                ),
                (
                    OsString::from("OPENAI_API_KEY"),
                    OsString::from("synthetic-secret")
                ),
                (
                    OsString::from("HTTPS_PROXY"),
                    OsString::from("https://synthetic:secret@example.invalid")
                ),
            ]),
            [expected],
        );
    }

    #[test]
    fn redirects_chromium_to_the_same_explicit_profile_without_splitting_spaces() {
        let profile = std::env::temp_dir()
            .join("synthetic profile")
            .into_os_string();
        let base = [OsString::from("--remote-debugging-port=12345")];
        let environment = [(
            OsString::from("CODEX_ELECTRON_USER_DATA_PATH"),
            profile.clone(),
        )];
        let mut expected = OsString::from("--user-data-dir=");
        expected.push(profile);
        assert_eq!(
            launch_arguments(&base, &environment),
            [base[0].clone(), expected]
        );
        assert_eq!(launch_arguments(&base, &[]), base);
    }

    #[test]
    fn does_not_install_remote_profile_paths_in_a_local_desktop() {
        let path = std::env::temp_dir()
            .join("synthetic-remote")
            .into_os_string();
        assert!(
            forwarded([
                (OsString::from("CODEX_HOME"), path.clone()),
                (OsString::from("HOME"), path),
                (
                    OsString::from("CODEXHOST_REMOTE_SSH_MANAGED"),
                    OsString::from("1")
                ),
            ])
            .is_empty()
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn appends_wayland_and_ime_flags_in_wayland_session() {
        let base = [OsString::from("--remote-debugging-port=12345")];
        let environment = [(
            OsString::from("WAYLAND_DISPLAY"),
            OsString::from("wayland-0"),
        )];
        assert_eq!(
            launch_arguments(&base, &environment),
            [
                base[0].clone(),
                OsString::from("--ozone-platform=wayland"),
                OsString::from("--enable-wayland-ime"),
                OsString::from("--wayland-text-input-version=3"),
            ]
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn respects_explicit_ozone_platform_override() {
        let base = [
            OsString::from("--remote-debugging-port=12345"),
            OsString::from("--ozone-platform=x11"),
        ];
        let environment = [(
            OsString::from("WAYLAND_DISPLAY"),
            OsString::from("wayland-0"),
        )];
        assert_eq!(launch_arguments(&base, &environment), base);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn respects_wayland_disable_flag() {
        let base = [OsString::from("--remote-debugging-port=12345")];
        let environment = [
            (
                OsString::from("WAYLAND_DISPLAY"),
                OsString::from("wayland-0"),
            ),
            (
                OsString::from("CODEXHOST_DISABLE_WAYLAND"),
                OsString::from("1"),
            ),
        ];
        assert_eq!(launch_arguments(&base, &environment), base);
    }
}
