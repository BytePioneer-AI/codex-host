use std::process::{Command, Stdio};

use super::{CompatibilityChoice, CompatibilityPrompt, CompatibilityUpdateAvailability};

struct CompatibilityText {
    body: String,
    continue_codexhost: &'static str,
    latest_release: &'static str,
    stock_codex: &'static str,
}

fn simplified_chinese_locale(locale: &str) -> bool {
    let locale = locale.to_ascii_lowercase().replace('-', "_");
    locale.starts_with("zh_cn") || locale.starts_with("zh_sg") || locale.starts_with("zh_hans")
}

fn compatibility_text(prompt: &CompatibilityPrompt<'_>, chinese: bool) -> CompatibilityText {
    let capability = match (prompt.capability, chinese) {
        ("title-isolation", true) => "自动标题隔离",
        ("title-isolation", false) => "Automatic title isolation",
        (capability, _) => capability,
    };
    let update_message = match (prompt.update_availability, chinese) {
        (CompatibilityUpdateAvailability::Current, true) => {
            "当前 codexhost 已是最新版。兼容性更新即将发布，发布后 codexhost 会提示更新。你可以先继续使用当前版本。"
        }
        (CompatibilityUpdateAvailability::Unavailable, true) => {
            "兼容性更新发布后 codexhost 会提示更新；你可以先继续使用当前版本。"
        }
        (CompatibilityUpdateAvailability::Current, false) => {
            "This is the latest codexhost release. A compatibility update is coming and codexhost will notify you when it is available. You can continue with the current version for now."
        }
        (CompatibilityUpdateAvailability::Unavailable, false) => {
            "codexhost will notify you when a compatibility update is available; you can continue with the current version for now."
        }
    };
    if chinese {
        CompatibilityText {
            body: format!(
                "检测到新的 Codex 版本。\n\ncodexhost 已完成核心兼容检查，但此 Codex 版本尚未完成完整验证，部分增强功能可能存在兼容问题。{}\n\n检测位置：{}\n原因代码：{}\n内部标识：{}\nCodex Desktop：{}\ncodexhost：{}",
                update_message,
                capability,
                prompt.reason_code,
                prompt.observed_identity,
                prompt.desktop_version,
                prompt.codexhost_version,
            ),
            continue_codexhost: "继续使用当前版本",
            latest_release: "查看发布页面",
            stock_codex: "使用原版 Codex",
        }
    } else {
        CompatibilityText {
            body: format!(
                "A new Codex version was detected.\n\ncodexhost completed its core compatibility checks, but this Codex version has not completed full validation and some enhanced features may be incompatible. {}\n\nArea: {}\nReason: {}\nInternal identity: {}\nCodex Desktop: {}\ncodexhost: {}",
                update_message,
                capability,
                prompt.reason_code,
                prompt.observed_identity,
                prompt.desktop_version,
                prompt.codexhost_version,
            ),
            continue_codexhost: "Continue with current version",
            latest_release: "View releases",
            stock_codex: "Use stock Codex",
        }
    }
}

fn compatibility_choice(selected: &str, text: &CompatibilityText) -> CompatibilityChoice {
    if selected == text.latest_release {
        CompatibilityChoice::OpenLatestRelease
    } else if selected == text.stock_codex {
        CompatibilityChoice::OpenStockCodex
    } else {
        CompatibilityChoice::ContinueCodexhost
    }
}

fn user_locale() -> String {
    Command::new("/usr/bin/defaults")
        .args(["read", "-g", "AppleLocale"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|locale| !locale.is_empty())
        .or_else(|| std::env::var("LC_ALL").ok())
        .or_else(|| std::env::var("LC_MESSAGES").ok())
        .or_else(|| std::env::var("LANG").ok())
        .unwrap_or_default()
}

pub fn prompt_compatibility_warning(prompt: &CompatibilityPrompt<'_>) -> CompatibilityChoice {
    let locale = user_locale();
    let text = compatibility_text(prompt, simplified_chinese_locale(&locale));
    let script = concat!(
        "on run argv\n",
        "set bodyText to item 1 of argv\n",
        "set continueLabel to item 2 of argv\n",
        "set releaseLabel to item 3 of argv\n",
        "set stockLabel to item 4 of argv\n",
        "set selected to button returned of (display dialog bodyText with title \"codexhost\" buttons {stockLabel, releaseLabel, continueLabel} default button continueLabel with icon note)\n",
        "return selected\n",
        "end run",
    );
    let output = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .arg(&text.body)
        .arg(text.continue_codexhost)
        .arg(text.latest_release)
        .arg(text.stock_codex)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    let Ok(output) = output else {
        return CompatibilityChoice::ContinueCodexhost;
    };
    if !output.status.success() {
        return CompatibilityChoice::ContinueCodexhost;
    }
    compatibility_choice(String::from_utf8_lossy(&output.stdout).trim(), &text)
}

#[cfg(test)]
mod tests {
    use super::{compatibility_choice, compatibility_text, simplified_chinese_locale};
    use crate::{CompatibilityChoice, CompatibilityPrompt, CompatibilityUpdateAvailability};

    fn prompt() -> CompatibilityPrompt<'static> {
        CompatibilityPrompt {
            desktop_version: "26.803.41515",
            codexhost_version: "0.1.0",
            capability: "title-isolation",
            reason_code: "unreviewed-title-service-identity",
            observed_identity: "futureClass",
            update_availability: CompatibilityUpdateAvailability::Current,
        }
    }

    #[test]
    fn supports_simplified_chinese_and_english_text() {
        assert!(simplified_chinese_locale("zh-CN.UTF-8"));
        assert!(simplified_chinese_locale("zh_Hans"));
        assert!(!simplified_chinese_locale("zh-TW"));
        assert!(
            compatibility_text(&prompt(), true)
                .body
                .contains("核心兼容检查")
        );
        assert!(
            compatibility_text(&prompt(), false)
                .body
                .contains("core compatibility checks")
        );
        assert!(
            compatibility_text(&prompt(), true)
                .body
                .contains("已是最新版")
        );
        let mut unavailable = prompt();
        unavailable.update_availability = CompatibilityUpdateAvailability::Unavailable;
        let unavailable_body = compatibility_text(&unavailable, true).body;
        assert!(unavailable_body.contains("兼容性更新发布后"));
        assert!(!unavailable_body.contains("暂时无法检查"));
    }

    #[test]
    fn maps_all_three_fixed_choices_and_defaults_to_continue() {
        let text = compatibility_text(&prompt(), true);
        assert_eq!(
            compatibility_choice(text.continue_codexhost, &text),
            CompatibilityChoice::ContinueCodexhost
        );
        assert_eq!(
            compatibility_choice(text.latest_release, &text),
            CompatibilityChoice::OpenLatestRelease
        );
        assert_eq!(
            compatibility_choice(text.stock_codex, &text),
            CompatibilityChoice::OpenStockCodex
        );
        assert_eq!(
            compatibility_choice("unexpected", &text),
            CompatibilityChoice::ContinueCodexhost
        );
    }

    #[test]
    fn diagnostic_text_contains_only_bounded_compatibility_fields() {
        let body = compatibility_text(&prompt(), true).body;
        assert!(body.contains("futureClass"));
        for forbidden in ["Prompt", "Transcript", "Thread ID", "Request ID", "/Users/"] {
            assert!(!body.contains(forbidden));
        }
    }
}
