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
    let is_windows = cfg!(target_os = "windows");
    let is_macos = cfg!(target_os = "macos");
    format!(
        r##"
window.__CODEXHOST_DESKTOP_SHELL__ = true;
(() => {{
  if (window.top !== window) return;
  const invoke = (name, args) => window.__TAURI_INTERNALS__?.invoke?.(name, args);

  if (location.protocol + "//" + location.host === {APP_ORIGIN:?} &&
      [{ONBOARDING:?}, {LOADING:?}].includes(location.pathname)) {{
    window.__codexhostShell = Object.freeze({{
      chooseSurface: (surface) => invoke("choose_surface", {{ surface }}),
      retry: () => invoke("retry"),
      openConsole: () => invoke("open_console"),
      getState: () => invoke("get_state"),
      ensureWebAccess: () => invoke("ensure_web_access"),
      openWebBrowser: () => invoke("open_web_browser"),
    }});
  }}

  const isWindows = {is_windows};
  const isMacos = {is_macos};

  const applyRootAttributes = () => {{
    const root = document.documentElement;
    if (!root) return false;
    root.setAttribute("data-codexhost-shell", "");
    root.setAttribute("data-tauri-shell", "");
    if (isWindows) {{
      root.setAttribute("data-windows-titlebar", "");
      root.style.setProperty("--dsh-windows-titlebar-height", "36px");
    }} else if (isMacos) {{
      root.setAttribute("data-platform", "darwin");
    }}
    return true;
  }};

  // Initialization scripts run at document_start before <html> is parsed in
  // both WKWebView and WebView2, so watch for documentElement creation.
  if (!applyRootAttributes()) {{
    const rootObserver = new MutationObserver(() => {{
      if (applyRootAttributes()) rootObserver.disconnect();
    }});
    rootObserver.observe(document, {{ childList: true }});
    document.addEventListener(
      "DOMContentLoaded",
      () => {{
        applyRootAttributes();
        rootObserver.disconnect();
      }},
      {{ once: true }},
    );
  }}

  const INTERACTIVE_SELECTOR = [
    "button",
    "a",
    "input",
    "select",
    "textarea",
    "summary",
    "[contenteditable='true']",
    "[tabindex]",
    "[role='button']",
    "[role='link']",
    "[role='tab']",
    "[role='menuitem']",
    "[role='menuitemcheckbox']",
    "[role='menuitemradio']",
    "[role='option']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='switch']",
    "[role='slider']",
    "[role='combobox']",
    "[role='textbox']",
    "[role='dialog']",
    "[role='alertdialog']",
    "[role='menu']",
    "[role='listbox']",
    "[data-no-window-drag]",
    "#codexhost-win-caption",
  ].join(",");

  const isInteractiveTarget = (target) => {{
    if (!(target instanceof Element)) return false;
    const hit = target.closest(INTERACTIVE_SELECTOR);
    if (!hit) return false;
    // ConversationHeader sets tabIndex=-1 on the header container for focus restoration.
    if (hit.matches("header[data-window-drag][tabindex='-1']")) return false;
    return true;
  }};

  const isInDragZone = (event) => {{
    if (!(event.target instanceof Element)) return false;
    if (isInteractiveTarget(event.target)) return false;
    if (isWindows && event.clientY >= 0 && event.clientY <= 36) return true;
    return Boolean(event.target.closest("[data-window-drag], .topbar"));
  }};

  let maximized = false;
  let maxBtn = null;
  const updateMaxIcon = () => {{
    if (!maxBtn) return;
    maxBtn.setAttribute("aria-label", maximized ? "Restore" : "Maximize");
    maxBtn.innerHTML = maximized
      ? '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1"><path d="M2.5 3.5h5v5h-5z"/><path d="M3.5 3.5V1.5h5v5h-2"/></svg>'
      : '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1"><rect x="1.5" y="1.5" width="7" height="7" rx="0.5"/></svg>';
  }};

  const syncChromeState = () => {{
    const req = invoke("window_chrome_state");
    if (!req || typeof req.then !== "function") return;
    req.then((state) => {{
      if (!state || typeof state !== "object") return;
      maximized = Boolean(state.maximized);
      updateMaxIcon();
      const root = document.documentElement;
      if (!root) return;
      if (state.fullscreen) root.setAttribute("data-fullscreen", "");
      else root.removeAttribute("data-fullscreen");
    }}).catch(() => {{}});
  }};

  if (isWindows || isMacos) {{
    document.addEventListener("mousedown", (event) => {{
      if (event.button !== 0 || event.detail > 1) return;
      if (!isInDragZone(event)) return;
      invoke("window_start_dragging")?.catch?.(() => {{}});
    }});
    document.addEventListener("dblclick", (event) => {{
      if (event.button !== 0) return;
      if (!isInDragZone(event)) return;
      invoke("window_toggle_maximize")?.then?.((next) => {{
        if (typeof next === "boolean") {{
          maximized = next;
          updateMaxIcon();
        }}
      }})?.catch?.(() => {{}});
    }});
    window.addEventListener("resize", () => syncChromeState());
    if (document.readyState === "loading") {{
      document.addEventListener("DOMContentLoaded", syncChromeState, {{ once: true }});
    }} else {{
      syncChromeState();
    }}
  }}

  if (isWindows) {{
    const detectDark = () => {{
      const root = document.documentElement;
      const theme = root?.getAttribute("data-theme");
      if (theme === "dark") return true;
      if (theme === "light") return false;
      if (document.body?.hasAttribute("data-ds-dark-theme")) return true;
      if (document.body && document.getElementById("root")) return false;
      return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false;
    }};

    const mountCaption = () => {{
      if (!document.body || document.getElementById("codexhost-win-caption")) return;
      const host = document.createElement("div");
      host.id = "codexhost-win-caption";
      host.style.cssText = "position:fixed;top:0;right:0;height:36px;z-index:2147483640;display:flex;align-items:stretch;pointer-events:auto;";
      const shadow = host.attachShadow({{ mode: "open" }});
      const style = document.createElement("style");
      style.textContent = `
        :host {{
          --cap-fg: rgba(24, 24, 27, 0.78);
          --cap-hover: rgba(0, 0, 0, 0.06);
          --cap-active: rgba(0, 0, 0, 0.1);
        }}
        :host([data-dark]) {{
          --cap-fg: rgba(255, 255, 255, 0.78);
          --cap-hover: rgba(255, 255, 255, 0.08);
          --cap-active: rgba(255, 255, 255, 0.13);
        }}
        .bar {{
          display: flex;
          height: 36px;
          align-items: stretch;
          -webkit-app-region: no-drag;
        }}
        button {{
          width: 46px;
          height: 36px;
          border: 0;
          margin: 0;
          padding: 0;
          background: transparent;
          color: var(--cap-fg);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: default;
          outline: none;
          transition: background-color 100ms ease, color 100ms ease;
        }}
        button:hover {{ background: var(--cap-hover); }}
        button:active {{ background: var(--cap-active); }}
        button.close:hover {{ background: #c42b1c; color: #ffffff; }}
        button.close:active {{ background: #b22619; color: #ffffff; }}
      `;
      const bar = document.createElement("div");
      bar.className = "bar";
      const minBtn = document.createElement("button");
      minBtn.type = "button";
      minBtn.setAttribute("aria-label", "Minimize");
      minBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1"><line x1="1" y1="5" x2="9" y2="5"/></svg>';
      minBtn.addEventListener("click", () => invoke("window_minimize")?.catch?.(() => {{}}));

      maxBtn = document.createElement("button");
      maxBtn.type = "button";
      updateMaxIcon();
      maxBtn.addEventListener("click", () => {{
        invoke("window_toggle_maximize")?.then?.((next) => {{
          if (typeof next === "boolean") {{
            maximized = next;
            updateMaxIcon();
          }}
        }})?.catch?.(() => {{}});
      }});

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "close";
      closeBtn.setAttribute("aria-label", "Close");
      closeBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.1"><line x1="1.5" y1="1.5" x2="8.5" y2="8.5"/><line x1="8.5" y1="1.5" x2="1.5" y2="8.5"/></svg>';
      closeBtn.addEventListener("click", () => invoke("window_close")?.catch?.(() => {{}}));

      bar.append(minBtn, maxBtn, closeBtn);
      shadow.append(style, bar);
      document.body.appendChild(host);

      const syncTheme = () => {{
        if (detectDark()) host.setAttribute("data-dark", "");
        else host.removeAttribute("data-dark");
      }};
      syncTheme();
      const observer = new MutationObserver(syncTheme);
      const root = document.documentElement;
      if (root) observer.observe(root, {{ attributes: true, attributeFilter: ["data-theme"] }});
      observer.observe(document.body, {{ attributes: true, attributeFilter: ["data-ds-dark-theme"] }});
      window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", syncTheme);
    }};

    if (document.readyState === "loading") {{
      document.addEventListener("DOMContentLoaded", mountCaption, {{ once: true }});
    }} else {{
      mountCaption();
    }}
  }}
}})();
"##,
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
    fn initialization_script_defines_shell_bridge_before_dom_root_access() {
        let script = initialization_script();
        let bridge_pos = script
            .find("window.__codexhostShell = Object.freeze")
            .expect("bridge registration must exist");
        let root_pos = script
            .find("document.documentElement")
            .expect("root attribute setup must exist");
        assert!(
            bridge_pos < root_pos,
            "__codexhostShell must be registered before touching document.documentElement at document_start"
        );
        assert!(
            script.contains("if (!root) return false;"),
            "root attribute setup must guard null document.documentElement at document_start"
        );
    }
}
