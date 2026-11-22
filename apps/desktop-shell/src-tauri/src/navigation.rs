use url::Url;

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

pub(crate) fn initialization_script() -> String {
    format!(
        r#"
window.__CODEXHOST_DESKTOP_SHELL__ = true;
(() => {{
  if (window.top !== window || location.protocol + "//" + location.host !== {APP_ORIGIN:?} ||
      ![{ONBOARDING:?}, {LOADING:?}].includes(location.pathname)) return;
  const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args);
  window.__codexhostShell = Object.freeze({{
    chooseSurface: (surface) => invoke("choose_surface", {{ surface }}),
    retry: () => invoke("retry"),
    openConsole: () => invoke("open_console"),
    getState: () => invoke("get_state"),
  }});
}})();
"#,
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
}
