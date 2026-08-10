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

fn capability_name(capability: &str, chinese: bool) -> &str {
    match (capability, chinese) {
        ("title-isolation", true) => "自动标题隔离",
        ("permission-control", true) => "权限控制",
        ("sidebar-decoration", true) => "侧边栏标识",
        ("fork-control", true) => "Fork 控制",
        ("usage-surface", true) => "Usage 显示",
        ("settings-surface", true) => "设置入口",
        ("title-isolation", false) => "Automatic title isolation",
        ("permission-control", false) => "Permission control",
        ("sidebar-decoration", false) => "Sidebar decoration",
        ("fork-control", false) => "Fork control",
        ("usage-surface", false) => "Usage surface",
        ("settings-surface", false) => "Settings surface",
        (capability, _) => capability,
    }
}

fn compatibility_text(prompt: &CompatibilityPrompt<'_>, chinese: bool) -> CompatibilityText {
    let update_message = match (prompt.update_availability, chinese) {
        (CompatibilityUpdateAvailability::Started, true) => {
            "codexhost 已开始在后台准备适配更新，你可以继续使用当前版本。"
        }
        (CompatibilityUpdateAvailability::Started, false) => {
            "codexhost started preparing an adapted update in the background, and you can continue with the current version."
        }
        (CompatibilityUpdateAvailability::Current, true) => {
            "当前 codexhost 已是最新版。适配更新发布后会提示更新，你可以先继续使用当前版本。"
        }
        (CompatibilityUpdateAvailability::Unavailable, true) => {
            "适配更新发布后会提示更新，你可以先继续使用当前版本。"
        }
        (CompatibilityUpdateAvailability::Current, false) => {
            "This is the latest codexhost release. You will be notified when an adaptation is published, and you can continue with the current version."
        }
        (CompatibilityUpdateAvailability::Unavailable, false) => {
            "You will be notified when an adaptation is published, and you can continue with the current version."
        }
    };
    let summary = if chinese {
        if prompt.degraded {
            "一项非关键增强功能不可用，codexhost 已将其安全禁用。"
        } else {
            "codexhost 已完成核心兼容检查，但此 Codex 版本尚未完成完整验证。"
        }
    } else if prompt.degraded {
        "A non-critical enhancement is unavailable and has been safely disabled."
    } else {
        "codexhost completed its core compatibility checks, but this Codex version has not completed full validation."
    };
    let identity = prompt.observed_identity.map_or_else(String::new, |value| {
        if chinese {
            format!("\n内部标识：{value}")
        } else {
            format!("\nInternal identity: {value}")
        }
    });
    let body = if chinese {
        format!(
            "{summary}{update_message}\n\n检测位置：{}\n原因代码：{}{}\nCodex Desktop：{}\ncodexhost：{}",
            capability_name(prompt.capability, true),
            prompt.reason_code,
            identity,
            prompt.desktop_version,
            prompt.codexhost_version,
        )
    } else {
        format!(
            "{summary} {update_message}\n\nArea: {}\nReason: {}{}\nCodex Desktop: {}\ncodexhost: {}",
            capability_name(prompt.capability, false),
            prompt.reason_code,
            identity,
            prompt.desktop_version,
            prompt.codexhost_version,
        )
    };
    CompatibilityText {
        body,
        continue_codexhost: match (prompt.update_availability, chinese) {
            (CompatibilityUpdateAvailability::Started, true) => "继续等待更新",
            (CompatibilityUpdateAvailability::Started, false) => "Continue while updating",
            (_, true) => "继续使用当前版本",
            (_, false) => "Continue with current version",
        },
        latest_release: if chinese {
            "查看发布页面"
        } else {
            "View releases"
        },
        stock_codex: if chinese {
            "使用原版 Codex"
        } else {
            "Use stock Codex"
        },
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
    let script = if prompt.update_availability == CompatibilityUpdateAvailability::Started {
        concat!(
            "on run argv\n",
            "set bodyText to item 1 of argv\n",
            "set continueLabel to item 2 of argv\n",
            "set selected to button returned of (display dialog bodyText with title \"codexhost\" buttons {continueLabel} default button continueLabel with icon note)\n",
            "return selected\n",
            "end run",
        )
    } else {
        concat!(
            "on run argv\n",
            "set bodyText to item 1 of argv\n",
            "set continueLabel to item 2 of argv\n",
            "set releaseLabel to item 3 of argv\n",
            "set stockLabel to item 4 of argv\n",
            "set selected to button returned of (display dialog bodyText with title \"codexhost\" buttons {stockLabel, releaseLabel, continueLabel} default button continueLabel with icon note)\n",
            "return selected\n",
            "end run",
        )
    };
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
        return compatibility_choice("", &text);
    };
    if !output.status.success() {
        return compatibility_choice("", &text);
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
            observed_identity: Some("futureClass"),
            update_availability: CompatibilityUpdateAvailability::Current,
            degraded: false,
        }
    }

    #[test]
    fn supports_simplified_chinese_and_layered_text() {
        assert!(simplified_chinese_locale("zh-CN.UTF-8"));
        assert!(simplified_chinese_locale("zh_Hans"));
        assert!(!simplified_chinese_locale("zh-TW"));
        assert!(
            compatibility_text(&prompt(), true)
                .body
                .contains("核心兼容检查")
        );
        let mut unavailable = prompt();
        unavailable.update_availability = CompatibilityUpdateAvailability::Unavailable;
        let unavailable_body = compatibility_text(&unavailable, true).body;
        assert!(unavailable_body.contains("适配更新发布后"));
        assert!(!unavailable_body.contains("暂时无法检查"));
    }

    #[test]
    fn warning_prompt_defaults_to_continue() {
        let warning = compatibility_text(&prompt(), true);
        assert_eq!(
            compatibility_choice(warning.continue_codexhost, &warning),
            CompatibilityChoice::ContinueCodexhost
        );
        assert_eq!(
            compatibility_choice(warning.latest_release, &warning),
            CompatibilityChoice::OpenLatestRelease
        );
        assert_eq!(
            compatibility_choice("unexpected", &warning),
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
