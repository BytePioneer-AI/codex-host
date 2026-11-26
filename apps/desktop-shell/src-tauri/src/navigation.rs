use url::Url;

use crate::zoom::ZOOM_LADDER;

pub(crate) const APP_ORIGIN: &str = if cfg!(windows) {
    "http://tauri.localhost"
} else {
    "tauri://localhost"
};
pub(crate) const ONBOARDING: &str = "/onboarding.html";
pub(crate) const LOADING: &str = "/loading.html";

pub(crate) fn embedded(path: &str) -> Url {
    Url::parse(&format!("{APP_ORIGIN}{path}")).expect("bundled page URL")
}

#[derive(PartialEq, Eq, Debug)]
pub(crate) enum Navigation {
    Embedded,
    Web,
    Browser,
    Block,
}

pub(crate) fn classify(url: &Url, login_url: Option<&Url>) -> Navigation {
    let has_userinfo = !url.username().is_empty() || url.password().is_some();
    let is_app_origin = if cfg!(windows) {
        url.scheme() == "http" && url.host_str() == Some("tauri.localhost")
    } else {
        url.scheme() == "tauri" && url.host_str() == Some("localhost")
    } && url.port().is_none()
        && !has_userinfo;
    if is_app_origin {
        return match url.path() {
            ONBOARDING | LOADING => Navigation::Embedded,
            _ => Navigation::Block,
        };
    }
    if !has_userinfo && login_url.is_some_and(|login| login.origin() == url.origin()) {
        return Navigation::Web;
    }
    match url.scheme() {
        "http" | "https" => Navigation::Browser,
        _ => Navigation::Block,
    }
}

pub(crate) fn open_browser(url: &Url) {
    let url = url.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if codexhost_platform::open_external_url(url.as_str()).is_err() {
            // A link can contain credentials; don't write the URL to diagnostics.
            eprintln!("CodexHost: could not open the system browser");
        }
    });
}

pub(crate) fn initialization_script(initial_zoom_percent: u16, boot_id: &str) -> String {
    let config = serde_json::json!({
        "appOrigin": APP_ORIGIN,
        "onboarding": ONBOARDING,
        "loading": LOADING,
        "isWindows": cfg!(target_os = "windows"),
        "isMacos": cfg!(target_os = "macos"),
        "zoomLadder": ZOOM_LADDER,
        "initialZoomPercent": initial_zoom_percent,
        "bootId": boot_id,
    });
    format!(
        "window.__CODEXHOST_DESKTOP_SHELL__ = true;\n(() => {{\n{script}\n__codexhostDesktopShellInit({config});\n}})();\n",
        script = include_str!("init_script.js"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permits_bundled_pages_and_the_exact_live_web_origin_only() {
        let web = Url::parse("http://127.0.0.1:4400/?token=fixture").unwrap();
        for (url, expected) in [
            (embedded(ONBOARDING), Navigation::Embedded),
            (
                embedded("/loading.html?status=reconnecting"),
                Navigation::Embedded,
            ),
            (embedded("/untrusted.html"), Navigation::Block),
            (web.join("/path#updates").unwrap(), Navigation::Web),
            (
                Url::parse("http://127.0.0.1:4401/").unwrap(),
                Navigation::Browser,
            ),
            (
                Url::parse("http://localhost:4400/").unwrap(),
                Navigation::Browser,
            ),
            (
                Url::parse("https://127.0.0.1:4400/").unwrap(),
                Navigation::Browser,
            ),
            (
                Url::parse("https://example.com/").unwrap(),
                Navigation::Browser,
            ),
            (
                Url::parse("file:///example.html").unwrap(),
                Navigation::Block,
            ),
            (
                Url::parse("data:text/html,example").unwrap(),
                Navigation::Block,
            ),
        ] {
            assert_eq!(classify(&url, Some(&web)), expected, "{}", url.path());
        }
        assert_eq!(classify(&web, None), Navigation::Browser);
    }

    #[test]
    fn initialization_script_defines_shell_bridges_before_dom_root_access_and_gates_embedded_keys()
    {
        let script = initialization_script(125, "boot-test-1");
        let bridge_pos = script
            .find("window.__codexhostShell = Object.freeze")
            .expect("bridge registration must exist");
        let zoom_pos = script
            .find("window.__codexhostZoom = Object.freeze")
            .expect("zoom bridge registration must exist");
        let root_pos = script
            .find("document.documentElement")
            .expect("root attribute setup must exist");
        assert!(
            bridge_pos < root_pos && zoom_pos < root_pos,
            "bridges must be registered before any document.documentElement access at document_start"
        );

        let keydown_pos = script
            .find("window.addEventListener(\"keydown\"")
            .expect("embedded zoom keydown listener must exist");
        let embedded_gate = script[..keydown_pos]
            .rfind("if (isEmbeddedPage)")
            .expect("embedded keydown listener must be inside an isEmbeddedPage branch");
        assert!(
            embedded_gate > zoom_pos && embedded_gate < keydown_pos,
            "embedded keydown branch must be explicitly gated after __codexhostZoom"
        );
        assert_eq!(
            script
                .matches("window.addEventListener(\"keydown\"")
                .count(),
            1,
            "live Web pages must not receive a second window keydown listener from the shell"
        );
        assert!(
            script.contains("AltGraph") && script.contains("\"Dead\""),
            "embedded key handler must guard AltGraph and Dead keys"
        );
        assert!(
            script.contains("\"zoomLadder\":[50,67,75,80,90,100,110,125,150,175,200]")
                && script.contains("\"initialZoomPercent\":125")
                && script.contains("\"bootId\":\"boot-test-1\""),
            "zoom ladder, initial zoom percent, and bootId must be injected from Rust"
        );
    }
}
