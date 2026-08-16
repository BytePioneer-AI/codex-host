use std::io::{self, IsTerminal, Write};

use super::{CompatibilityPrompt, CompatibilityUpdateAvailability, LinuxCompatibilityChoice};

fn print_prompt(prompt: &CompatibilityPrompt<'_>, output: &mut impl Write) -> io::Result<()> {
    writeln!(output, "codexhost compatibility warning")?;
    writeln!(output, "Desktop version: {}", prompt.desktop_version)?;
    writeln!(output, "codexhost version: {}", prompt.codexhost_version)?;
    writeln!(
        output,
        "State: {}",
        if prompt.degraded {
            "degraded"
        } else {
            "warning"
        }
    )?;
    writeln!(output, "Capability: {}", prompt.capability)?;
    writeln!(output, "Reason: {}", prompt.reason_code)?;
    if let Some(identity) = prompt.observed_identity {
        writeln!(output, "Observed identity: {identity}")?;
    }
    match prompt.update_availability {
        CompatibilityUpdateAvailability::Started => {
            writeln!(
                output,
                "A newer codexhost version was detected, and the update has started in the background."
            )?;
            writeln!(
                output,
                "You can continue using the current version. The application will restart automatically when the update is complete."
            )?;
            writeln!(
                output,
                "If the update takes too long, install it manually from GitHub Releases:"
            )?;
            writeln!(
                output,
                "https://github.com/BytePioneer-AI/codex-host/releases/latest"
            )?;
        }
        CompatibilityUpdateAvailability::Current => {
            writeln!(output, "This is the current codexhost release.")?;
        }
        CompatibilityUpdateAvailability::Unavailable => {}
    }
    writeln!(output)?;
    writeln!(output, "1) Continue once")?;
    writeln!(output, "2) Continue and remember this exact warning")?;
    writeln!(output, "3) Open latest release")?;
    writeln!(output, "4) Launch stock ChatGPT")?;
    writeln!(output, "5) Cancel")?;
    write!(output, "Choice [5]: ")?;
    output.flush()
}

fn parse_choice(input: &str) -> LinuxCompatibilityChoice {
    match input.trim() {
        "1" => LinuxCompatibilityChoice::ContinueOnce,
        "2" => LinuxCompatibilityChoice::ContinueAndRemember,
        "3" => LinuxCompatibilityChoice::OpenLatestRelease,
        "4" => LinuxCompatibilityChoice::OpenStockCodex,
        _ => LinuxCompatibilityChoice::Cancel,
    }
}

pub fn prompt_linux_compatibility_warning(
    prompt: &CompatibilityPrompt<'_>,
) -> LinuxCompatibilityChoice {
    let mut output = io::stderr().lock();
    if !io::stdin().is_terminal() || !output.is_terminal() {
        return LinuxCompatibilityChoice::Cancel;
    }
    if print_prompt(prompt, &mut output).is_err() {
        return LinuxCompatibilityChoice::Cancel;
    }
    let mut input = String::new();
    match io::stdin().read_line(&mut input) {
        Ok(_) => parse_choice(&input),
        Err(_) => LinuxCompatibilityChoice::Cancel,
    }
}

#[cfg(test)]
mod tests {
    use super::{LinuxCompatibilityChoice, parse_choice};

    #[test]
    fn accepts_only_fixed_explicit_choices() {
        assert_eq!(parse_choice("1\n"), LinuxCompatibilityChoice::ContinueOnce);
        assert_eq!(
            parse_choice("2\n"),
            LinuxCompatibilityChoice::ContinueAndRemember
        );
        assert_eq!(
            parse_choice("3\n"),
            LinuxCompatibilityChoice::OpenLatestRelease
        );
        assert_eq!(
            parse_choice("4\n"),
            LinuxCompatibilityChoice::OpenStockCodex
        );
        assert_eq!(parse_choice(""), LinuxCompatibilityChoice::Cancel);
        assert_eq!(
            parse_choice("unexpected\n"),
            LinuxCompatibilityChoice::Cancel
        );
    }
}
