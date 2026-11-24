(function () {
  "use strict";

  var VALID_STATUSES = {
    starting: true,
    reconnecting: true,
    error: true,
  };

  function getSearchParams() {
    try {
      return new URLSearchParams(window.location.search || "");
    } catch {
      return new URLSearchParams();
    }
  }

  function normalizeLocale(raw) {
    if (typeof raw !== "string") {
      return "en";
    }
    var trimmed = raw.trim().toLowerCase();
    if (trimmed === "zh" || trimmed.indexOf("zh-") === 0 || trimmed.indexOf("zh_") === 0) {
      return "zh-CN";
    }
    return "en";
  }

  function getQueryLocale() {
    var lang = getSearchParams().get("lang");
    if (!lang) {
      return null;
    }
    return normalizeLocale(lang);
  }

  function detectInitialLocale() {
    var fromQuery = getQueryLocale();
    if (fromQuery) {
      return fromQuery;
    }
    if (typeof navigator !== "undefined") {
      if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
        return normalizeLocale(navigator.languages[0]);
      }
      if (typeof navigator.language === "string" && navigator.language) {
        return normalizeLocale(navigator.language);
      }
    }
    return "zh-CN";
  }

  function applyThemeFromQuery() {
    var theme = getSearchParams().get("theme");
    if (theme === "light" || theme === "dark") {
      document.documentElement.setAttribute("data-theme", theme);
      return theme;
    }
    document.documentElement.removeAttribute("data-theme");
    return "system";
  }

  function setThemeOverride(theme) {
    if (theme === "light" || theme === "dark") {
      document.documentElement.setAttribute("data-theme", theme);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }

  function getNativeBridge() {
    var candidate = window.__codexhostShell;
    if (candidate && typeof candidate === "object") {
      return candidate;
    }
    return null;
  }

  function hasNativeBridge() {
    return getNativeBridge() !== null;
  }

  var ISSUES_NEW_URL = "https://github.com/BytePioneer-AI/codex-host/issues/new";

  function redactTokens(text) {
    return String(text || "").replace(/(token=)[^\s&#"'\)]+/gi, "$1[redacted]");
  }

  function truncateText(text, maxLen) {
    var value = String(text || "").trim();
    if (value.length <= maxLen) {
      return value;
    }
    return value.slice(0, maxLen - 1) + "…";
  }

  function buildIssueUrl(context) {
    var info = context && typeof context === "object" ? context : {};
    var cleanError = truncateText(redactTokens(info.error || ""), 500);
    var firstLine = cleanError.split(/\r?\n/)[0] || "";
    var title = firstLine ? "[Bug] " + truncateText(firstLine, 80) : "[Bug] CodexHost launch error";
    var platform =
      info.platform || (typeof navigator !== "undefined" && navigator.platform) || "unknown";
    var version = info.version ? "v" + String(info.version).replace(/^v/, "") : "unknown";
    var diagPath =
      String(platform).toLowerCase().indexOf("win") !== -1
        ? "%USERPROFILE%\\.codexhost\\diagnostics\\launcher-startup-v1.json"
        : "~/.codexhost/diagnostics/launcher-startup-v1.json";

    var lines = [
      "### 问题描述 / Description",
      "<!-- 请补充触发步骤或截图 / Please describe what you clicked or attach screenshots -->",
      "",
      "### 错误信息 / Error",
      "```text",
      cleanError || "(none)",
      "```",
      "",
      "### 环境信息 / Environment",
      "- CodexHost: " + version,
      "- Platform: " + platform,
    ];
    if (info.surface) {
      lines.push("- Entry: " + info.surface);
    }
    lines.push("- Diagnostics file: `" + diagPath + "`");

    var params = new URLSearchParams();
    params.set("title", title);
    params.set("body", lines.join("\n"));
    return ISSUES_NEW_URL + "?" + params.toString();
  }

  function normalizeState(raw, defaults) {
    var base = defaults || {};
    var source = raw && typeof raw === "object" ? raw : {};

    var codexDesktopInstalled =
      typeof source.codexDesktopInstalled === "boolean"
        ? source.codexDesktopInstalled
        : typeof base.codexDesktopInstalled === "boolean"
          ? base.codexDesktopInstalled
          : true;

    var locale =
      typeof source.locale === "string" && source.locale.trim()
        ? normalizeLocale(source.locale)
        : normalizeLocale(base.locale || detectInitialLocale());

    var version =
      typeof source.version === "string" && source.version.trim()
        ? source.version.trim()
        : typeof base.version === "string" && base.version.trim()
          ? base.version.trim()
          : "";

    var platform =
      typeof source.platform === "string" && source.platform.trim()
        ? source.platform.trim()
        : typeof base.platform === "string" && base.platform.trim()
          ? base.platform.trim()
          : "";

    var status =
      typeof source.status === "string" && VALID_STATUSES[source.status]
        ? source.status
        : typeof base.status === "string" && VALID_STATUSES[base.status]
          ? base.status
          : "starting";

    var message =
      typeof source.message === "string"
        ? source.message.trim()
        : typeof base.message === "string"
          ? base.message.trim()
          : "";

    var webRunning =
      typeof source.webRunning === "boolean"
        ? source.webRunning
        : typeof base.webRunning === "boolean"
          ? base.webRunning
          : false;

    var webUrl =
      typeof source.webUrl === "string" && source.webUrl.trim()
        ? source.webUrl.trim()
        : typeof base.webUrl === "string" && base.webUrl.trim()
          ? base.webUrl.trim()
          : "";

    var webLoginUrl =
      typeof source.webLoginUrl === "string" && source.webLoginUrl.trim()
        ? source.webLoginUrl.trim()
        : typeof base.webLoginUrl === "string" && base.webLoginUrl.trim()
          ? base.webLoginUrl.trim()
          : "";

    return {
      codexDesktopInstalled: codexDesktopInstalled,
      locale: locale,
      version: version,
      platform: platform,
      status: status,
      message: message,
      webRunning: webRunning,
      webUrl: webUrl,
      webLoginUrl: webLoginUrl,
    };
  }

  function readShellState(fallbackState) {
    var bridge = getNativeBridge();
    if (!bridge || typeof bridge.getState !== "function") {
      return Promise.resolve({
        isNative: false,
        state: normalizeState(fallbackState, fallbackState),
        bridgeError: null,
      });
    }

    try {
      return Promise.resolve(bridge.getState()).then(
        function (raw) {
          return {
            isNative: true,
            state: normalizeState(raw, fallbackState),
            bridgeError: null,
          };
        },
        function (err) {
          return {
            isNative: true,
            state: normalizeState(fallbackState, fallbackState),
            bridgeError: err,
          };
        },
      );
    } catch (err) {
      return Promise.resolve({
        isNative: true,
        state: normalizeState(fallbackState, fallbackState),
        bridgeError: err,
      });
    }
  }

  function formatError(err, fallbackText) {
    if (err && typeof err === "object" && typeof err.message === "string" && err.message.trim()) {
      return err.message.trim();
    }
    if (typeof err === "string" && err.trim()) {
      return err.trim();
    }
    return fallbackText || "";
  }

  function updateLocaleToggle(toggleEl, locale) {
    document.documentElement.lang = locale;
    if (!toggleEl) {
      return;
    }
    var options = toggleEl.querySelectorAll("[data-lang]");
    for (var i = 0; i < options.length; i += 1) {
      var opt = options[i];
      opt.setAttribute("data-active", opt.getAttribute("data-lang") === locale ? "true" : "false");
    }
    toggleEl.setAttribute(
      "aria-label",
      locale === "zh-CN" ? "切换界面语言为英文" : "Switch interface language to Chinese",
    );
  }

  function bindLocaleToggle(toggleEl, getLocale, onToggle) {
    if (!toggleEl) {
      return;
    }
    toggleEl.addEventListener("click", function () {
      var nextLocale = getLocale() === "zh-CN" ? "en" : "zh-CN";
      onToggle(nextLocale);
    });
  }

  function setHidden(el, isHidden) {
    if (!el) {
      return;
    }
    if (isHidden) {
      el.setAttribute("hidden", "");
    } else {
      el.removeAttribute("hidden");
    }
  }

  function shouldShowPreviewBar() {
    if (hasNativeBridge()) {
      return false;
    }
    return getSearchParams().get("preview") !== "0";
  }

  window.CodexHostShellUI = {
    getSearchParams: getSearchParams,
    normalizeLocale: normalizeLocale,
    getQueryLocale: getQueryLocale,
    detectInitialLocale: detectInitialLocale,
    applyThemeFromQuery: applyThemeFromQuery,
    setThemeOverride: setThemeOverride,
    getNativeBridge: getNativeBridge,
    hasNativeBridge: hasNativeBridge,
    normalizeState: normalizeState,
    readShellState: readShellState,
    formatError: formatError,
    buildIssueUrl: buildIssueUrl,
    setHidden: setHidden,
    updateLocaleToggle: updateLocaleToggle,
    bindLocaleToggle: bindLocaleToggle,
    shouldShowPreviewBar: shouldShowPreviewBar,
  };
})();
