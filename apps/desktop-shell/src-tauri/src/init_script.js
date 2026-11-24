function __codexhostDesktopShellInit(config) {
  if (window.top !== window) return;

  const invoke = (name, args) => window.__TAURI_INTERNALS__?.invoke?.(name, args);
  const {
    appOrigin,
    onboarding,
    loading,
    isWindows,
    isMacos,
    zoomLadder,
    initialZoomPercent,
    bootId,
  } = config;
  const isEmbeddedPage =
    location.protocol + "//" + location.host === appOrigin &&
    [onboarding, loading].includes(location.pathname);

  const ZOOM_CACHE_KEY = "codexhost:desktop-shell-zoom-v1";
  const ZOOM_LADDER = Array.isArray(zoomLadder) && zoomLadder.length > 0 ? zoomLadder : [100];
  const bootPrefix = typeof bootId === "string" && bootId.length > 0 ? `${bootId}:` : "";
  const readInitialZoomPercent = () => {
    if (isEmbeddedPage) {
      try {
        const param = new URLSearchParams(location.search).get("zoom");
        if (param !== null) {
          const parsed = Number(param);
          if (ZOOM_LADDER.includes(parsed)) return parsed;
        }
      } catch {}
    } else if (bootPrefix) {
      try {
        const raw = window.localStorage?.getItem(ZOOM_CACHE_KEY);
        if (raw !== null && raw.startsWith(bootPrefix)) {
          const parsed = Number(raw.slice(bootPrefix.length));
          if (ZOOM_LADDER.includes(parsed)) return parsed;
        }
      } catch {}
    }
    return ZOOM_LADDER.includes(initialZoomPercent) ? initialZoomPercent : 100;
  };
  const writeCachedZoomPercent = (percent) => {
    if (isEmbeddedPage || !bootPrefix) return;
    try {
      window.localStorage?.setItem(ZOOM_CACHE_KEY, `${bootPrefix}${percent}`);
    } catch {}
  };

  let currentZoomState = { percent: readInitialZoomPercent(), ladder: ZOOM_LADDER };
  let currentZoomRevision = -1;
  let currentWinTitlebarHeight = 36;
  const zoomListeners = new Set();

  let applyZoomCssVar = () => {};
  let showZoomToast = () => {};

  const normalizeZoomState = (raw) => {
    if (!raw || typeof raw !== "object") return { state: currentZoomState, revision: null };
    const ladder =
      Array.isArray(raw.ladder) && raw.ladder.length > 0
        ? raw.ladder.filter((value) => typeof value === "number" && Number.isFinite(value))
        : currentZoomState.ladder;
    const percent =
      typeof raw.percent === "number" && Number.isFinite(raw.percent)
        ? raw.percent
        : currentZoomState.percent;
    const revision =
      typeof raw.revision === "number" && Number.isFinite(raw.revision) ? raw.revision : null;
    return { state: { percent, ladder }, revision };
  };

  const commitZoomState = (next, revision, showFeedback) => {
    if (revision !== null) {
      if (revision < currentZoomRevision) return currentZoomState;
      currentZoomRevision = revision;
    }
    currentZoomState = next;
    writeCachedZoomPercent(next.percent);
    applyZoomCssVar(next.percent);
    if (showFeedback) showZoomToast(next.percent);
    for (const listener of [...zoomListeners]) {
      try {
        listener(currentZoomState);
      } catch {}
    }
    return currentZoomState;
  };

  const syncZoomFromShell = async () => {
    try {
      const raw = await invoke("window_zoom_get");
      if (!raw) return currentZoomState;
      const { state, revision } = normalizeZoomState(raw);
      return commitZoomState(state, revision, false);
    } catch {
      return currentZoomState;
    }
  };

  const mutateZoom = async (command, args, options) => {
    const raw = await invoke(command, args);
    if (!raw) return currentZoomState;
    const { state, revision } = normalizeZoomState(raw);
    return commitZoomState(state, revision, !(options && options.silent === true));
  };

  if (isEmbeddedPage) {
    window.__codexhostShell = Object.freeze({
      chooseSurface: (surface) => invoke("choose_surface", { surface }),
      retry: () => invoke("retry"),
      openConsole: () => invoke("open_console"),
      getState: () => invoke("get_state"),
      ensureWebAccess: () => invoke("ensure_web_access"),
      openWebBrowser: () => invoke("open_web_browser"),
    });
  }

  window.__codexhostZoom = Object.freeze({
    getState: () => currentZoomState,
    refresh: () => syncZoomFromShell(),
    setPercent: (percent, options) =>
      mutateZoom("window_zoom_set", { percent: Math.round(Number(percent)) }, options),
    step: (delta, options) => mutateZoom("window_zoom_step", { delta }, options),
    subscribe: (listener) => {
      if (typeof listener !== "function") return () => {};
      zoomListeners.add(listener);
      return () => {
        zoomListeners.delete(listener);
      };
    },
  });

  if (isEmbeddedPage) {
    let deadKey = false;
    const resetDeadKey = () => {
      deadKey = false;
    };
    const resolveEmbeddedZoomDelta = (event) => {
      const isDead = event.key === "Dead";
      const guarded = event.isComposing || deadKey || Boolean(event.getModifierState?.("AltGraph"));
      deadKey = isDead;
      if (event.defaultPrevented || guarded || isDead || event.altKey) {
        return null;
      }
      const primary = isMacos ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!primary) return null;
      if (event.key === "=" || event.key === "+") return 1;
      if (event.key === "-") return -1;
      if (event.key === "0") return 0;
      if (!event.shiftKey) {
        if (event.code === "Equal" || event.code === "NumpadAdd") return 1;
        if (event.code === "Minus" || event.code === "NumpadSubtract") return -1;
        if (event.code === "Digit0" || event.code === "Numpad0") return 0;
      }
      return null;
    };
    document.addEventListener("compositionstart", resetDeadKey, true);
    document.addEventListener("compositionend", resetDeadKey, true);
    document.addEventListener("focusin", resetDeadKey, true);
    document.addEventListener("pointerdown", resetDeadKey, true);
    window.addEventListener("blur", resetDeadKey);
    window.addEventListener("keydown", (event) => {
      const delta = resolveEmbeddedZoomDelta(event);
      if (delta === null) return;
      event.preventDefault();
      if (event.repeat) return;
      const request =
        delta === 0 ? window.__codexhostZoom.setPercent(100) : window.__codexhostZoom.step(delta);
      request.catch(() => {});
    });
  }

  const detectDark = () => {
    const root = document.documentElement;
    const theme = root?.getAttribute("data-theme");
    if (theme === "dark") return true;
    if (theme === "light") return false;
    if (document.body?.hasAttribute("data-ds-dark-theme")) return true;
    if (document.body && document.getElementById("root")) return false;
    return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false;
  };

  applyZoomCssVar = (percent) => {
    const root = document.documentElement;
    if (!root) return;
    const numeric = Number(percent);
    const scale = Number.isFinite(numeric) && numeric > 0 ? numeric / 100 : 1;
    root.style.setProperty("--dsh-shell-zoom", String(scale));
    if (isWindows) {
      // Below 100% zoom, compensate Windows caption bar so buttons and drag zone
      // never shrink below native 46x36 / 36 DIPs; at >=100% let them scale with
      // the page so the 28px sidebar toggle stays centered without clipping.
      const chromeScale = scale < 1 ? 1 / scale : 1;
      currentWinTitlebarHeight = Math.round(36 * chromeScale);
      const captionWidth = Math.round(138 * chromeScale);
      root.style.setProperty("--dsh-windows-titlebar-height", `${currentWinTitlebarHeight}px`);
      root.style.setProperty("--dsh-windows-caption-width", `${captionWidth}px`);
      root.style.setProperty("--dsh-windows-caption-scale", String(chromeScale));
    }
  };

  let zoomToastHost = null;
  let zoomToastPill = null;
  let zoomToastHideTimer = 0;
  let zoomToastClearTimer = 0;

  const syncZoomToastTheme = () => {
    if (!zoomToastHost) return;
    if (detectDark()) zoomToastHost.setAttribute("data-dark", "");
    else zoomToastHost.removeAttribute("data-dark");
  };

  const ensureZoomToast = () => {
    if (zoomToastHost && zoomToastPill) return true;
    if (!document.body) return false;
    const host = document.createElement("div");
    host.id = "codexhost-zoom-toast";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host {
        position: fixed;
        top: calc(var(--dsh-frame-top-clearance, 48px) + 16px / var(--dsh-shell-zoom, 1));
        left: 0;
        right: 0;
        display: flex;
        justify-content: center;
        pointer-events: none;
        z-index: 2147483630;
      }
      .pill {
        box-sizing: border-box;
        min-width: 68px;
        padding: 6px 14px;
        border-radius: 9999px;
        border: 0.5px solid rgba(15, 17, 21, 0.12);
        background: rgba(255, 255, 255, 0.92);
        color: rgba(15, 17, 21, 0.9);
        box-shadow: 0 4px 16px rgba(15, 17, 21, 0.12), 0 1px 3px rgba(15, 17, 21, 0.08);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Helvetica Neue", sans-serif;
        font-size: 13px;
        font-weight: 550;
        line-height: 18px;
        letter-spacing: 0.01em;
        font-variant-numeric: tabular-nums;
        text-align: center;
        transform-origin: top center;
        transform: scale(calc(1 / var(--dsh-shell-zoom, 1))) translateY(-4px);
        opacity: 0;
        transition: opacity 140ms ease-out, transform 140ms ease-out;
      }
      .pill[data-visible] {
        opacity: 1;
        transform: scale(calc(1 / var(--dsh-shell-zoom, 1))) translateY(0);
      }
      :host([data-dark]) .pill {
        border-color: rgba(255, 255, 255, 0.14);
        background: rgba(34, 37, 44, 0.92);
        color: rgba(255, 255, 255, 0.94);
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.36), 0 1px 4px rgba(0, 0, 0, 0.24);
      }
      @media (prefers-reduced-motion: reduce) {
        .pill {
          transition: none;
          transform: scale(calc(1 / var(--dsh-shell-zoom, 1)));
        }
        .pill[data-visible] {
          transform: scale(calc(1 / var(--dsh-shell-zoom, 1)));
        }
      }
    `;
    const pill = document.createElement("div");
    pill.className = "pill";
    pill.setAttribute("role", "status");
    pill.setAttribute("aria-atomic", "true");
    shadow.append(style, pill);
    document.body.appendChild(host);
    zoomToastHost = host;
    zoomToastPill = pill;

    const root = document.documentElement;
    if (root) {
      const observer = new MutationObserver(syncZoomToastTheme);
      observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ["data-ds-dark-theme"],
      });
    }
    window
      .matchMedia?.("(prefers-color-scheme: dark)")
      ?.addEventListener?.("change", syncZoomToastTheme);
    return true;
  };

  showZoomToast = (percent) => {
    if (!ensureZoomToast()) return;
    syncZoomToastTheme();
    window.clearTimeout(zoomToastHideTimer);
    window.clearTimeout(zoomToastClearTimer);
    zoomToastPill.textContent = `${percent}%`;
    zoomToastPill.setAttribute("data-visible", "");
    zoomToastHideTimer = window.setTimeout(() => {
      zoomToastPill?.removeAttribute("data-visible");
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
      zoomToastClearTimer = window.setTimeout(
        () => {
          if (zoomToastPill && !zoomToastPill.hasAttribute("data-visible")) {
            zoomToastPill.textContent = "";
          }
        },
        reduced ? 0 : 160,
      );
    }, 1350);
  };

  const applyRootAttributes = () => {
    const root = document.documentElement;
    if (!root) return false;
    root.setAttribute("data-codexhost-shell", "");
    root.setAttribute("data-tauri-shell", "");
    if (isWindows) {
      root.setAttribute("data-windows-titlebar", "");
    } else if (isMacos) {
      root.setAttribute("data-platform", "darwin");
    }
    applyZoomCssVar(currentZoomState.percent);
    return true;
  };

  void syncZoomFromShell();

  // Initialization scripts run at document_start before <html> is parsed in
  // both WKWebView and WebView2, so watch for documentElement creation.
  if (!applyRootAttributes()) {
    const rootObserver = new MutationObserver(() => {
      if (applyRootAttributes()) rootObserver.disconnect();
    });
    rootObserver.observe(document, { childList: true });
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        applyRootAttributes();
        rootObserver.disconnect();
      },
      { once: true },
    );
  }

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

  const isInteractiveTarget = (target) => {
    if (!(target instanceof Element)) return false;
    const hit = target.closest(INTERACTIVE_SELECTOR);
    if (!hit) return false;
    // ConversationHeader sets tabIndex=-1 on the header container for focus restoration.
    if (hit.matches("header[data-window-drag][tabindex='-1']")) return false;
    return true;
  };

  const isInDragZone = (event) => {
    if (!(event.target instanceof Element)) return false;
    if (isInteractiveTarget(event.target)) return false;
    if (isWindows && event.clientY >= 0 && event.clientY <= currentWinTitlebarHeight) return true;
    return Boolean(event.target.closest("[data-window-drag], .topbar"));
  };

  const SVG_NS = "http://www.w3.org/2000/svg";
  const createCaptionSvg = (strokeWidth, shapes) => {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "10");
    svg.setAttribute("height", "10");
    svg.setAttribute("viewBox", "0 0 10 10");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", strokeWidth);
    for (const [tag, attrs] of shapes) {
      const node = document.createElementNS(SVG_NS, tag);
      for (const [attr, value] of Object.entries(attrs)) node.setAttribute(attr, value);
      svg.appendChild(node);
    }
    return svg;
  };

  let maximized = false;
  let maxBtn = null;
  const updateMaxIcon = () => {
    if (!maxBtn) return;
    maxBtn.setAttribute("aria-label", maximized ? "Restore" : "Maximize");
    maxBtn.replaceChildren(
      createCaptionSvg(
        "1",
        maximized
          ? [
              ["path", { d: "M2.5 3.5h5v5h-5z" }],
              ["path", { d: "M3.5 3.5V1.5h5v5h-2" }],
            ]
          : [["rect", { x: "1.5", y: "1.5", width: "7", height: "7", rx: "0.5" }]],
      ),
    );
  };

  const syncChromeState = () => {
    const req = invoke("window_chrome_state");
    if (!req || typeof req.then !== "function") return;
    req
      .then((state) => {
        if (!state || typeof state !== "object") return;
        maximized = Boolean(state.maximized);
        updateMaxIcon();
        const root = document.documentElement;
        if (!root) return;
        if (state.fullscreen) root.setAttribute("data-fullscreen", "");
        else root.removeAttribute("data-fullscreen");
      })
      .catch(() => {});
  };

  if (isWindows || isMacos) {
    document.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || event.detail > 1) return;
      if (!isInDragZone(event)) return;
      invoke("window_start_dragging")?.catch?.(() => {});
    });
    document.addEventListener("dblclick", (event) => {
      if (event.button !== 0) return;
      if (!isInDragZone(event)) return;
      invoke("window_toggle_maximize")
        ?.then?.((next) => {
          if (typeof next === "boolean") {
            maximized = next;
            updateMaxIcon();
          }
        })
        ?.catch?.(() => {});
    });
    window.addEventListener("resize", () => syncChromeState());
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", syncChromeState, { once: true });
    } else {
      syncChromeState();
    }
  }

  if (isWindows) {
    const mountCaption = () => {
      if (!document.body || document.getElementById("codexhost-win-caption")) return;
      const host = document.createElement("div");
      host.id = "codexhost-win-caption";
      host.style.cssText =
        "position:fixed;top:0;right:0;height:var(--dsh-windows-titlebar-height,36px);width:var(--dsh-windows-caption-width,138px);z-index:2147483640;display:flex;justify-content:flex-end;align-items:flex-start;pointer-events:auto;";
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = `
        :host {
          --cap-fg: rgba(24, 24, 27, 0.78);
          --cap-hover: rgba(0, 0, 0, 0.06);
          --cap-active: rgba(0, 0, 0, 0.1);
        }
        :host([data-dark]) {
          --cap-fg: rgba(255, 255, 255, 0.78);
          --cap-hover: rgba(255, 255, 255, 0.08);
          --cap-active: rgba(255, 255, 255, 0.13);
        }
        .bar {
          display: flex;
          height: 36px;
          align-items: stretch;
          transform-origin: top right;
          transform: scale(var(--dsh-windows-caption-scale, 1));
          -webkit-app-region: no-drag;
        }
        button {
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
        }
        button:hover { background: var(--cap-hover); }
        button:active { background: var(--cap-active); }
        button.close:hover { background: #c42b1c; color: #ffffff; }
        button.close:active { background: #b22619; color: #ffffff; }
      `;
      const bar = document.createElement("div");
      bar.className = "bar";
      const minBtn = document.createElement("button");
      minBtn.type = "button";
      minBtn.setAttribute("aria-label", "Minimize");
      minBtn.appendChild(createCaptionSvg("1", [["line", { x1: "1", y1: "5", x2: "9", y2: "5" }]]));
      minBtn.addEventListener("click", () => invoke("window_minimize")?.catch?.(() => {}));

      maxBtn = document.createElement("button");
      maxBtn.type = "button";
      updateMaxIcon();
      maxBtn.addEventListener("click", () => {
        invoke("window_toggle_maximize")
          ?.then?.((next) => {
            if (typeof next === "boolean") {
              maximized = next;
              updateMaxIcon();
            }
          })
          ?.catch?.(() => {});
      });

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "close";
      closeBtn.setAttribute("aria-label", "Close");
      closeBtn.appendChild(
        createCaptionSvg("1.1", [
          ["line", { x1: "1.5", y1: "1.5", x2: "8.5", y2: "8.5" }],
          ["line", { x1: "8.5", y1: "1.5", x2: "1.5", y2: "8.5" }],
        ]),
      );
      closeBtn.addEventListener("click", () => invoke("window_close")?.catch?.(() => {}));

      bar.append(minBtn, maxBtn, closeBtn);
      shadow.append(style, bar);
      document.body.appendChild(host);

      const syncTheme = () => {
        if (detectDark()) host.setAttribute("data-dark", "");
        else host.removeAttribute("data-dark");
      };
      syncTheme();
      const observer = new MutationObserver(syncTheme);
      const root = document.documentElement;
      if (root) observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ["data-ds-dark-theme"],
      });
      window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", syncTheme);
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", mountCaption, { once: true });
    } else {
      mountCaption();
    }
  }
}
