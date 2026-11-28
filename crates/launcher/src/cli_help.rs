pub(crate) fn subcommand_usage(arguments: &[String]) -> Option<&'static str> {
    let (command, options) = arguments.split_first()?;
    let (synopsis, switches): (&str, Option<&[&str]>) = match command.as_str() {
        "web" => (
            "codexhost web [--background] [--connect-devices] [--host <address>] [--port <port>]\n    \
             [--public-url <url>] [--trusted-proxy <addresses>] [--relay <control-host>]\n    \
             [--node <absolute-file>] [--host-runtime <absolute-file>]\n    \
             [--web-runtime <absolute-file>] [--data <absolute-directory>]",
            Some(&["--background", "--connect-devices", "--update-recovery"]),
        ),
        "launch" => (
            "codexhost launch [--shim <absolute-file>] [--node <absolute-file>]\n    \
             [--host-runtime <absolute-file>] [--desktop-controller <absolute-file>]\n    \
             [--renderer <absolute-file>] [--pi <absolute-file>]\n    \
             [--windows-direct | --custom-install <absolute-directory>]\n\
             --windows-direct and --custom-install are Windows-only.",
            Some(&["--windows-direct", "--update-recovery"]),
        ),
        "inspect" => (
            "codexhost inspect [--json] [--custom-install <absolute-directory>]\n\
             --custom-install is Windows-only.",
            Some(&["--json"]),
        ),
        "app" => (
            "codexhost app [--onboarding]",
            Some(&["--onboarding", "--update-recovery"]),
        ),
        "stop" => (
            "codexhost stop [--node <absolute-file>] [--host-runtime <absolute-file>]\n    \
             [--web-runtime <absolute-file>]",
            Some(&[]),
        ),
        "stop-for-update" => (
            "codexhost stop-for-update [--node <absolute-file>] [--host-runtime <absolute-file>]\n    \
             [--web-runtime <absolute-file>] [--data <absolute-directory>]",
            Some(&[]),
        ),
        "status" => ("codexhost status", None),
        "autostart" => ("codexhost autostart on|off|status", None),
        "shortcut" => ("codexhost shortcut install|remove|status [--json]", None),
        "macos-signing" => (
            "codexhost macos-signing status|setup|remove [--app <path>] [--json]",
            None,
        ),
        "console" => ("codexhost console", None),
        "update" => ("codexhost update", None),
        "launch-prefs" => (
            "codexhost launch-prefs get --json\n  \
             codexhost launch-prefs set --surface <native-shell|codex-desktop>\n    \
             [--onboarding-completed true|false]",
            None,
        ),
        "desktop-screenshot" => ("codexhost desktop-screenshot", None),
        "open-file" => ("codexhost open-file <file>", None),
        "reveal-file" => ("codexhost reveal-file <absolute-path>", None),
        "open-loopback-url" => (
            "codexhost open-loopback-url\nReads a loopback root URL from stdin.",
            None,
        ),
        "proxy-environment" => ("codexhost proxy-environment", None),
        "web-service" => (
            "codexhost web-service <ensure|stop|serve> --node <absolute-file>\n    \
             --host-node <absolute-file> --web-runtime <absolute-file>\n    \
             --host-runtime <absolute-file> --data <absolute-directory>\n\
             The internal serve action requires --ready-file <absolute-file>.",
            None,
        ),
        _ => return None,
    };
    let help_requested = match switches {
        Some(switches) => has_help_option(options, switches),
        None => options.first().is_some_and(|option| is_help_flag(option)),
    };
    help_requested.then_some(synopsis)
}

fn is_help_flag(option: &str) -> bool {
    matches!(option, "--help" | "-h")
}

fn has_help_option(options: &[String], switches: &[&str]) -> bool {
    let mut options = options.iter().map(String::as_str);
    while let Some(option) = options.next() {
        if is_help_flag(option) {
            return true;
        }
        if !option.starts_with("--") {
            return false;
        }
        if !switches.contains(&option) {
            // A help-shaped value belongs to its option, not to the launcher.
            options.next();
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::subcommand_usage;

    #[test]
    fn help_options_do_not_override_values_or_delegated_help() {
        for arguments in [
            ["web", "--host", "--help"],
            ["inspect", "--custom-install", "-h"],
            ["launch", "--pi", "--help"],
            ["host", "info", "--help"],
        ] {
            assert!(subcommand_usage(&arguments.map(String::from)).is_none());
        }
    }
}
