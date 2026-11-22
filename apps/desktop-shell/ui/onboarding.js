(function () {
  "use strict";

  var ui = window.CodexHostShellUI;
  if (!ui) {
    return;
  }

  var COPY = {
    "zh-CN": {
      pageTitle: "CodexHost — 选择默认桌面方式",
      title: "选择你的默认桌面方式",
      subtitle: "同一个 CodexHost 安装包支持两种窗口形态，选定后将记住为默认启动方式。",
      nativeBadge: "推荐",
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
      footnote: "之后随时可在系统托盘或设置中切换，两个窗口共用同一批会话。",
      chooseErrorPrefix: "无法保存或打开所选方式：",
      chooseErrorFallback: "请稍后重试，或从系统托盘打开诊断控制台。",
      previewNotice: function (surfaceLabel) {
        return "离线预览模式：已模拟选择「" + surfaceLabel + "」（未连接桌面壳）。";
      },
      previewErrorSample: "示例错误：无法写入启动偏好文件（离线预览模拟）。",
      previewLabel: "预览",
      previewDesktopInstalled: "已安装 Codex Desktop",
      previewDesktopMissing: "未检测到 Codex Desktop",
      previewFail: "模拟失败",
      previewThemeAuto: "跟随系统",
      previewThemeLight: "浅色",
      previewThemeDark: "深色",
    },
    en: {
      pageTitle: "CodexHost — Choose Desktop Experience",
      title: "Choose your default desktop experience",
      subtitle:
        "One CodexHost installation supports both window experiences. Your choice will be remembered on future launches.",
      nativeBadge: "Recommended",
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
      footnote:
        "You can switch anytime from the system tray or Settings. Both windows share the same sessions.",
      chooseErrorPrefix: "Could not apply selection: ",
      chooseErrorFallback: "Please try again or open the diagnostic console from the system tray.",
      previewNotice: function (surfaceLabel) {
        return (
          'Offline preview: simulated selecting "' +
          surfaceLabel +
          '" (desktop shell bridge not connected).'
        );
      },
      previewErrorSample: "Sample error: failed to persist launch preferences (offline preview).",
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
    feedbackKind: null,
    feedbackMessage: "",
    previewTheme: ui.applyThemeFromQuery(),
    previewSimulateError: params.get("error") === "1" || params.get("error") === "true",
  };

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

  els.nativeCard.addEventListener("click", function () {
    handleChooseSurface("native-shell");
  });

  els.desktopCard.addEventListener("click", function () {
    handleChooseSurface("codex-desktop");
  });

  render();

  ui.readShellState({
    codexDesktopInstalled: state.codexDesktopInstalled,
    locale: state.locale,
    status: "starting",
    message: "",
  }).then(function (result) {
    if (!result.isNative) {
      return;
    }
    if (!state.localeLockedByUser && result.state.locale) {
      state.locale = result.state.locale;
    }
    state.codexDesktopInstalled = result.state.codexDesktopInstalled;
    if (result.state.status === "error" && result.state.message) {
      state.feedbackKind = "error";
      state.feedbackMessage = result.state.message;
    }
    render();
  });
})();
