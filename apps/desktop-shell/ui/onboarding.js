(function () {
  "use strict";

  var ui = window.CodexHostShellUI;
  if (!ui) {
    return;
  }

  var COPY = {
    "zh-CN": {
      pageTitle: "CodexHost — 选择打开方式",
      title: "选择打开方式",
      subtitle: "每次启动可自由选择入口，桌面端、官方客户端与浏览器共用同一套本机后台与会话。",
      nativeBadge: "独立窗口",
      nativeTitle: "CodexHost 桌面端",
      nativeSummary: "轻量、低内存的独立原生桌面窗口",
      nativePoint1: "轻量低内存，独立原生窗口体验",
      nativePoint2: "支持多 Agent 协作与丰富扩展",
      nativePoint3: "不依赖官方客户端更新，随时可用",
      nativeCta: "使用 CodexHost 桌面端",
      nativePending: "正在打开 CodexHost 桌面端…",
      desktopBadge: "增强版",
      desktopTitle: "官方 Codex Desktop",
      desktopSummary: "保留熟悉的官方桌面界面与注入增强",
      desktopPoint1: "保留熟悉的官方桌面界面与习惯",
      desktopPoint2: "同样支持所有外部 Agent 会话",
      desktopPoint3: "保持原生 Codex 路径与交互一致",
      desktopCta: "使用官方 Codex Desktop",
      desktopPending: "正在打开官方 Codex Desktop…",
      desktopUnavailable: "未在本机检测到 Codex Desktop",
      desktopUnavailableCta: "当前不可用",
      webLabel: "Web 浏览器访问",
      webRunning: "运行中",
      webIdle: "按需启动",
      webIdleHint: "点击右侧启动或复制本机免登链接",
      webCopy: "复制地址",
      webCopying: "准备中…",
      webCopied: "已复制",
      webOpen: "浏览器打开",
      webOpening: "正在启动…",
      webOpenedInfo: "已在系统默认浏览器中打开本机 Web。",
      webErrorPrefix: "无法启动或打开 Web：",
      webErrorFallback: "请稍后重试，或从系统托盘打开诊断控制台。",
      footnote: "托盘图标随时可切换窗口、查看诊断日志或完全退出。",
      chooseErrorPrefix: "无法打开所选方式：",
      chooseErrorFallback: "请稍后重试，或从系统托盘打开诊断控制台。",
      previewNotice: function (surfaceLabel) {
        return "离线预览模式：已模拟选择「" + surfaceLabel + "」（未连接桌面壳）。";
      },
      previewErrorSample: "示例错误：无法启动所选界面（离线预览模拟）。",
      previewLabel: "预览",
      previewDesktopInstalled: "已安装 Codex Desktop",
      previewDesktopMissing: "未检测到 Codex Desktop",
      previewFail: "模拟失败",
      previewThemeAuto: "跟随系统",
      previewThemeLight: "浅色",
      previewThemeDark: "深色",
    },
    en: {
      pageTitle: "CodexHost — Choose Launch Mode",
      title: "Choose how to open CodexHost",
      subtitle:
        "Pick a launch mode each time you open CodexHost. Desktop, official client, and Web share the same local Host and sessions.",
      nativeBadge: "Standalone",
      nativeTitle: "CodexHost Desktop",
      nativeSummary: "Lightweight, low-memory native desktop window",
      nativePoint1: "Lightweight and low-memory native window",
      nativePoint2: "Multi-Agent collaboration and extensions",
      nativePoint3: "Independent of official client updates",
      nativeCta: "Use CodexHost Desktop",
      nativePending: "Opening CodexHost Desktop…",
      desktopBadge: "Enhanced",
      desktopTitle: "Official Codex Desktop",
      desktopSummary: "Keep the familiar official interface with enhancements",
      desktopPoint1: "Familiar official desktop interface and habits",
      desktopPoint2: "Full support for all external Agents",
      desktopPoint3: "Preserves the native Codex workflow",
      desktopCta: "Use Official Codex Desktop",
      desktopPending: "Opening Official Codex Desktop…",
      desktopUnavailable: "Codex Desktop was not detected on this device",
      desktopUnavailableCta: "Unavailable",
      webLabel: "Web Browser Access",
      webRunning: "Running",
      webIdle: "On demand",
      webIdleHint: "Start or copy the local sign-in link on the right",
      webCopy: "Copy URL",
      webCopying: "Starting…",
      webCopied: "Copied",
      webOpen: "Open in Browser",
      webOpening: "Starting…",
      webOpenedInfo: "Opened local Web in your default browser.",
      webErrorPrefix: "Could not open Web: ",
      webErrorFallback: "Please try again or open diagnostics from the system tray.",
      footnote: "Switch windows, open diagnostics, or quit anytime from the system tray.",
      chooseErrorPrefix: "Could not open selection: ",
      chooseErrorFallback: "Please try again or open the diagnostic console from the system tray.",
      previewNotice: function (surfaceLabel) {
        return (
          'Offline preview: simulated selecting "' +
          surfaceLabel +
          '" (desktop shell bridge not connected).'
        );
      },
      previewErrorSample: "Sample error: failed to launch surface (offline preview).",
      previewLabel: "Preview",
      previewDesktopInstalled: "Desktop installed",
      previewDesktopMissing: "Desktop missing",
      previewFail: "Simulate error",
      previewThemeAuto: "System",
      previewThemeLight: "Light",
      previewThemeDark: "Dark",
    },
  };

  var params = ui.getSearchParams();
  var state = {
    locale: ui.detectInitialLocale(),
    localeLockedByUser: ui.getQueryLocale() !== null,
    codexDesktopInstalled: params.get("installed") !== "false",
    submittingSurface: null,
    webRunning: false,
    webUrl: "",
    webLoginUrl: "",
    webBusy: null,
    webCopied: false,
    feedbackKind: null,
    feedbackMessage: "",
    previewTheme: ui.applyThemeFromQuery(),
    previewSimulateError: params.get("error") === "1" || params.get("error") === "true",
  };
  var copiedTimer = null;

  var els = {
    langToggle: document.getElementById("lang-toggle"),
    title: document.getElementById("onboarding-title"),
    subtitle: document.getElementById("onboarding-subtitle"),
    nativeCard: document.getElementById("card-native-shell"),
    nativeBadge: document.getElementById("native-badge"),
    nativeTitle: document.getElementById("native-title"),
    nativeSummary: document.getElementById("native-summary"),
    nativePoint1: document.getElementById("native-point-1"),
    nativePoint2: document.getElementById("native-point-2"),
    nativePoint3: document.getElementById("native-point-3"),
    nativeCta: document.getElementById("native-cta"),
    nativeSpinner: document.getElementById("native-spinner"),
    nativeArrow: document.getElementById("native-arrow"),
    desktopCard: document.getElementById("card-codex-desktop"),
    desktopBadge: document.getElementById("desktop-badge"),
    desktopTitle: document.getElementById("desktop-title"),
    desktopSummary: document.getElementById("desktop-summary"),
    desktopPoint1: document.getElementById("desktop-point-1"),
    desktopPoint2: document.getElementById("desktop-point-2"),
    desktopPoint3: document.getElementById("desktop-point-3"),
    desktopUnavailable: document.getElementById("desktop-unavailable"),
    desktopUnavailableText: document.getElementById("desktop-unavailable-text"),
    desktopCta: document.getElementById("desktop-cta"),
    desktopSpinner: document.getElementById("desktop-spinner"),
    desktopArrow: document.getElementById("desktop-arrow"),
    webStatusDot: document.getElementById("web-status-dot"),
    webLabel: document.getElementById("web-access-label"),
    webStatus: document.getElementById("web-access-status"),
    webUrl: document.getElementById("web-access-url"),
    webCopyBtn: document.getElementById("web-copy-btn"),
    webCopySpinner: document.getElementById("web-copy-spinner"),
    webCopyIcon: document.getElementById("web-copy-icon"),
    webCopiedIcon: document.getElementById("web-copied-icon"),
    webCopyLabel: document.getElementById("web-copy-label"),
    webOpenBtn: document.getElementById("web-open-btn"),
    webOpenSpinner: document.getElementById("web-open-spinner"),
    webOpenIcon: document.getElementById("web-open-icon"),
    webOpenLabel: document.getElementById("web-open-label"),
    feedbackBanner: document.getElementById("feedback-banner"),
    feedbackIconError: document.getElementById("feedback-icon-error"),
    feedbackIconInfo: document.getElementById("feedback-icon-info"),
    feedbackText: document.getElementById("feedback-text"),
    footnoteText: document.getElementById("onboarding-footnote-text"),
    previewBar: document.getElementById("preview-bar"),
  };

  function getCopy() {
    return COPY[state.locale] || COPY["zh-CN"];
  }

  function render() {
    var t = getCopy();
    document.title = t.pageTitle;
    ui.updateLocaleToggle(els.langToggle, state.locale);

    els.title.textContent = t.title;
    els.subtitle.textContent = t.subtitle;
    els.footnoteText.textContent = t.footnote;

    els.nativeBadge.textContent = t.nativeBadge;
    els.nativeTitle.textContent = t.nativeTitle;
    els.nativeSummary.textContent = t.nativeSummary;
    els.nativePoint1.textContent = t.nativePoint1;
    els.nativePoint2.textContent = t.nativePoint2;
    els.nativePoint3.textContent = t.nativePoint3;

    els.desktopBadge.textContent = t.desktopBadge;
    els.desktopTitle.textContent = t.desktopTitle;
    els.desktopSummary.textContent = t.desktopSummary;
    els.desktopPoint1.textContent = t.desktopPoint1;
    els.desktopPoint2.textContent = t.desktopPoint2;
    els.desktopPoint3.textContent = t.desktopPoint3;
    els.desktopUnavailableText.textContent = t.desktopUnavailable;

    var isBusy = state.submittingSurface !== null;
    var nativePending = state.submittingSurface === "native-shell";
    var desktopPending = state.submittingSurface === "codex-desktop";
    var desktopUnavailable = !state.codexDesktopInstalled;

    els.nativeCard.disabled = isBusy;
    els.nativeCard.setAttribute("aria-busy", nativePending ? "true" : "false");
    els.nativeCard.setAttribute("data-pending", nativePending ? "true" : "false");
    els.nativeCard.setAttribute("data-dimmed", isBusy && !nativePending ? "true" : "false");
    els.nativeCta.textContent = nativePending ? t.nativePending : t.nativeCta;
    ui.setHidden(els.nativeSpinner, !nativePending);
    ui.setHidden(els.nativeArrow, nativePending);

    els.desktopCard.disabled = isBusy || desktopUnavailable;
    els.desktopCard.setAttribute("aria-disabled", desktopUnavailable ? "true" : "false");
    els.desktopCard.setAttribute("aria-busy", desktopPending ? "true" : "false");
    els.desktopCard.setAttribute("data-unavailable", desktopUnavailable ? "true" : "false");
    els.desktopCard.setAttribute("data-pending", desktopPending ? "true" : "false");
    els.desktopCard.setAttribute(
      "data-dimmed",
      isBusy && !desktopPending && !desktopUnavailable ? "true" : "false",
    );
    ui.setHidden(els.desktopUnavailable, !desktopUnavailable);
    els.desktopCta.textContent = desktopPending
      ? t.desktopPending
      : desktopUnavailable
        ? t.desktopUnavailableCta
        : t.desktopCta;
    ui.setHidden(els.desktopSpinner, !desktopPending);
    ui.setHidden(els.desktopArrow, desktopPending || desktopUnavailable);

    if (els.webStatusDot) {
      els.webStatusDot.setAttribute("data-running", state.webRunning ? "true" : "false");
    }
    if (els.webLabel) {
      els.webLabel.textContent = t.webLabel;
    }
    if (els.webStatus) {
      els.webStatus.textContent = state.webRunning ? t.webRunning : t.webIdle;
      els.webStatus.setAttribute("data-running", state.webRunning ? "true" : "false");
    }
    if (els.webUrl) {
      els.webUrl.textContent = state.webUrl || t.webIdleHint;
    }
    var webDisabled = isBusy || state.webBusy !== null;
    var copying = state.webBusy === "copy";
    var opening = state.webBusy === "open";
    if (els.webCopyBtn) {
      els.webCopyBtn.disabled = webDisabled;
      els.webCopyLabel.textContent = copying
        ? t.webCopying
        : state.webCopied
          ? t.webCopied
          : t.webCopy;
      ui.setHidden(els.webCopySpinner, !copying);
      ui.setHidden(els.webCopyIcon, copying || state.webCopied);
      ui.setHidden(els.webCopiedIcon, copying || !state.webCopied);
    }
    if (els.webOpenBtn) {
      els.webOpenBtn.disabled = webDisabled;
      els.webOpenLabel.textContent = opening ? t.webOpening : t.webOpen;
      ui.setHidden(els.webOpenSpinner, !opening);
      ui.setHidden(els.webOpenIcon, opening);
    }

    if (state.feedbackMessage) {
      var isInfo = state.feedbackKind === "info";
      ui.setHidden(els.feedbackBanner, false);
      els.feedbackBanner.className = isInfo
        ? "feedback-banner feedback-banner--info"
        : "feedback-banner feedback-banner--error";
      els.feedbackBanner.setAttribute("role", isInfo ? "status" : "alert");
      ui.setHidden(els.feedbackIconError, isInfo);
      ui.setHidden(els.feedbackIconInfo, !isInfo);
      els.feedbackText.textContent = state.feedbackMessage;
    } else {
      ui.setHidden(els.feedbackBanner, true);
      els.feedbackText.textContent = "";
    }

    renderPreviewBar();
  }

  function handleChooseSurface(surface) {
    if (state.submittingSurface !== null) {
      return;
    }
    if (surface === "codex-desktop" && !state.codexDesktopInstalled) {
      return;
    }

    state.submittingSurface = surface;
    state.feedbackKind = null;
    state.feedbackMessage = "";
    render();

    var bridge = ui.getNativeBridge();
    if (bridge && typeof bridge.chooseSurface === "function") {
      Promise.resolve()
        .then(function () {
          return bridge.chooseSurface(surface);
        })
        .catch(function (err) {
          var t = getCopy();
          var detail = ui.formatError(err, t.chooseErrorFallback);
          state.submittingSurface = null;
          state.feedbackKind = "error";
          state.feedbackMessage = t.chooseErrorPrefix + detail;
          render();
        });
      return;
    }

    // Graceful offline preview when opened directly in a browser
    window.setTimeout(function () {
      var t = getCopy();
      state.submittingSurface = null;
      if (state.previewSimulateError) {
        state.feedbackKind = "error";
        state.feedbackMessage = t.chooseErrorPrefix + t.previewErrorSample;
      } else {
        var label = surface === "native-shell" ? t.nativeTitle : t.desktopTitle;
        state.feedbackKind = "info";
        state.feedbackMessage = t.previewNotice(label);
      }
      render();
    }, 520);
  }

  function createPreviewChip(text, active, onClick) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preview-chip";
    btn.textContent = text;
    btn.setAttribute("data-active", active ? "true" : "false");
    btn.addEventListener("click", onClick);
    return btn;
  }

  function renderPreviewBar() {
    if (!els.previewBar) {
      return;
    }
    if (!ui.shouldShowPreviewBar()) {
      els.previewBar.hidden = true;
      return;
    }

    var t = getCopy();
    els.previewBar.hidden = false;
    els.previewBar.textContent = "";

    var label = document.createElement("span");
    label.className = "preview-label";
    label.textContent = t.previewLabel;
    els.previewBar.appendChild(label);

    els.previewBar.appendChild(
      createPreviewChip(t.previewDesktopInstalled, state.codexDesktopInstalled, function () {
        state.codexDesktopInstalled = true;
        render();
      }),
    );
    els.previewBar.appendChild(
      createPreviewChip(t.previewDesktopMissing, !state.codexDesktopInstalled, function () {
        state.codexDesktopInstalled = false;
        render();
      }),
    );
    els.previewBar.appendChild(
      createPreviewChip(t.previewFail, state.previewSimulateError, function () {
        state.previewSimulateError = !state.previewSimulateError;
        render();
      }),
    );

    var divider = document.createElement("span");
    divider.className = "preview-divider";
    els.previewBar.appendChild(divider);

    var themes = [
      { id: "system", label: t.previewThemeAuto },
      { id: "light", label: t.previewThemeLight },
      { id: "dark", label: t.previewThemeDark },
    ];
    for (var i = 0; i < themes.length; i += 1) {
      (function (themeItem) {
        els.previewBar.appendChild(
          createPreviewChip(themeItem.label, state.previewTheme === themeItem.id, function () {
            state.previewTheme = themeItem.id;
            ui.setThemeOverride(themeItem.id);
            render();
          }),
        );
      })(themes[i]);
    }
  }

  ui.bindLocaleToggle(
    els.langToggle,
    function () {
      return state.locale;
    },
    function (nextLocale) {
      state.locale = nextLocale;
      state.localeLockedByUser = true;
      render();
    },
  );

  function copyTextToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      return navigator.clipboard.writeText(text).catch(function () {
        fallbackCopy(text);
      });
    }
    fallbackCopy(text);
    return Promise.resolve();
  }

  function fallbackCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand("copy");
    } finally {
      document.body.removeChild(area);
    }
  }

  function flashCopied() {
    state.webCopied = true;
    render();
    if (copiedTimer) {
      window.clearTimeout(copiedTimer);
    }
    copiedTimer = window.setTimeout(function () {
      copiedTimer = null;
      state.webCopied = false;
      render();
    }, 2000);
  }

  function applyWebInfo(info) {
    if (info && typeof info.webUrl === "string" && info.webUrl) {
      state.webRunning = true;
      state.webUrl = info.webUrl;
    }
    if (info && typeof info.webLoginUrl === "string" && info.webLoginUrl) {
      state.webLoginUrl = info.webLoginUrl;
    }
  }

  function handleCopyWebUrl() {
    if (state.submittingSurface !== null || state.webBusy !== null) {
      return;
    }
    state.feedbackKind = null;
    state.feedbackMessage = "";

    if (state.webLoginUrl || state.webUrl) {
      copyTextToClipboard(state.webLoginUrl || state.webUrl).then(flashCopied);
      return;
    }

    var bridge = ui.getNativeBridge();
    if (bridge && typeof bridge.ensureWebAccess === "function") {
      state.webBusy = "copy";
      render();
      Promise.resolve()
        .then(function () {
          return bridge.ensureWebAccess();
        })
        .then(function (info) {
          applyWebInfo(info);
          state.webBusy = null;
          return copyTextToClipboard(state.webLoginUrl || state.webUrl).then(flashCopied);
        })
        .catch(function (err) {
          var t = getCopy();
          state.webBusy = null;
          state.feedbackKind = "error";
          state.feedbackMessage = t.webErrorPrefix + ui.formatError(err, t.webErrorFallback);
          render();
        });
      return;
    }

    // Offline preview
    state.webRunning = true;
    state.webUrl = "http://127.0.0.1:4400";
    state.webLoginUrl = "http://127.0.0.1:4400/?token=preview";
    copyTextToClipboard(state.webUrl).then(flashCopied);
  }

  function handleOpenWebBrowser() {
    if (state.submittingSurface !== null || state.webBusy !== null) {
      return;
    }
    state.feedbackKind = null;
    state.feedbackMessage = "";

    var bridge = ui.getNativeBridge();
    if (bridge && typeof bridge.openWebBrowser === "function") {
      state.webBusy = "open";
      render();
      Promise.resolve()
        .then(function () {
          return bridge.openWebBrowser();
        })
        .then(function (info) {
          var t = getCopy();
          applyWebInfo(info);
          state.webBusy = null;
          state.feedbackKind = "info";
          state.feedbackMessage = t.webOpenedInfo;
          render();
        })
        .catch(function (err) {
          var t = getCopy();
          state.webBusy = null;
          state.feedbackKind = "error";
          state.feedbackMessage = t.webErrorPrefix + ui.formatError(err, t.webErrorFallback);
          render();
        });
      return;
    }

    var t = getCopy();
    state.webRunning = true;
    state.webUrl = "http://127.0.0.1:4400";
    state.feedbackKind = "info";
    state.feedbackMessage = t.webOpenedInfo;
    render();
  }

  els.nativeCard.addEventListener("click", function () {
    handleChooseSurface("native-shell");
  });

  els.desktopCard.addEventListener("click", function () {
    handleChooseSurface("codex-desktop");
  });

  if (els.webCopyBtn) {
    els.webCopyBtn.addEventListener("click", handleCopyWebUrl);
  }
  if (els.webOpenBtn) {
    els.webOpenBtn.addEventListener("click", handleOpenWebBrowser);
  }

  render();

  ui.readShellState({
    codexDesktopInstalled: state.codexDesktopInstalled,
    locale: state.locale,
    status: "starting",
    message: "",
    webRunning: false,
    webUrl: "",
    webLoginUrl: "",
  }).then(function (result) {
    if (!result.isNative) {
      return;
    }
    if (!state.localeLockedByUser && result.state.locale) {
      state.locale = result.state.locale;
    }
    state.codexDesktopInstalled = result.state.codexDesktopInstalled;
    state.webRunning = result.state.webRunning;
    state.webUrl = result.state.webUrl;
    state.webLoginUrl = result.state.webLoginUrl;
    if (result.state.status === "error" && result.state.message) {
      state.feedbackKind = "error";
      state.feedbackMessage = result.state.message;
    }
    render();
  });
})();
