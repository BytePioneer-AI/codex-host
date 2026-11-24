(function () {
  "use strict";

  var ui = window.CodexHostShellUI;
  if (!ui) {
    return;
  }

  var POLL_ACTIVE_MS = 1200;
  var POLL_ERROR_MS = 3000;

  var COPY = {
    "zh-CN": {
      pageTitle: {
        starting: "CodexHost — 正在启动",
        reconnecting: "CodexHost — 正在重连",
        error: "CodexHost — 连接失败",
      },
      badge: {
        starting: "正在启动",
        reconnecting: "正在重新连接",
        error: "启动或连接异常",
      },
      title: {
        starting: "正在启动 CodexHost",
        reconnecting: "正在重新连接本地服务",
        error: "无法连接到本地服务",
      },
      description: {
        starting: "正在启动本地服务并准备窗口，请稍候…",
        reconnecting: "本地服务正在重启（例如刚刚修改了访问设置），正在等待恢复，请稍候…",
        error: "启动或连接过程中遇到问题。你可以尝试重试，或打开诊断控制台查看详情与修复。",
      },
      errorLabel: "错误摘要",
      errorFallback: "本地服务未能在预期时间内就绪，请检查日志或重试。",
      retryBtn: "重试",
      retryingBtn: "正在重试…",
      consoleBtn: "打开诊断控制台",
      consoleOpeningBtn: "正在打开…",
      reportIssueBtn: "提交 Issue",
      retryErrorPrefix: "重试失败：",
      consoleErrorPrefix: "无法打开诊断控制台：",
      actionErrorFallback: "桌面壳未能响应请求。",
      previewConsoleNotice: "离线预览模式：已模拟触发打开诊断控制台（未连接桌面壳）。",
      previewErrorSample: "本地服务在 15 秒内未就绪：端口 4400 已被其他进程占用 (EADDRINUSE)。",
      previewLabel: "预览",
      previewStarting: "启动中",
      previewReconnecting: "重连中",
      previewError: "错误态",
      previewThemeAuto: "跟随系统",
      previewThemeLight: "浅色",
      previewThemeDark: "深色",
    },
    en: {
      pageTitle: {
        starting: "CodexHost — Starting",
        reconnecting: "CodexHost — Reconnecting",
        error: "CodexHost — Connection Error",
      },
      badge: {
        starting: "Starting",
        reconnecting: "Reconnecting",
        error: "Connection error",
      },
      title: {
        starting: "Starting CodexHost",
        reconnecting: "Reconnecting to local service",
        error: "Unable to connect to local service",
      },
      description: {
        starting: "Starting local services and preparing your window…",
        reconnecting:
          "The local service is restarting (for example, after an access settings change). Waiting for recovery…",
        error:
          "Something went wrong while starting or reconnecting. You can retry, or open the diagnostic console for details and recovery.",
      },
      errorLabel: "Error summary",
      errorFallback: "The local service did not become ready in time. Check logs or try again.",
      retryBtn: "Retry",
      retryingBtn: "Retrying…",
      consoleBtn: "Open Diagnostic Console",
      consoleOpeningBtn: "Opening…",
      reportIssueBtn: "Report Issue",
      retryErrorPrefix: "Retry failed: ",
      consoleErrorPrefix: "Could not open diagnostic console: ",
      actionErrorFallback: "The desktop shell did not respond.",
      previewConsoleNotice:
        "Offline preview: simulated opening the diagnostic console (desktop shell bridge not connected).",
      previewErrorSample:
        "Local service failed to become ready within 15s: port 4400 is already in use (EADDRINUSE).",
      previewLabel: "Preview",
      previewStarting: "Starting",
      previewReconnecting: "Reconnecting",
      previewError: "Error",
      previewThemeAuto: "System",
      previewThemeLight: "Light",
      previewThemeDark: "Dark",
    },
  };

  var params = ui.getSearchParams();
  var queryState = params.get("state") || params.get("status");
  var initialStatus =
    queryState === "starting" || queryState === "reconnecting" || queryState === "error"
      ? queryState
      : "starting";
  var queryMessage = params.get("message") || "";

  var state = {
    locale: ui.detectInitialLocale(),
    localeLockedByUser: ui.getQueryLocale() !== null,
    version: "",
    platform: "",
    status: initialStatus,
    message: queryMessage,
    retrying: false,
    openingConsole: false,
    actionFeedbackKind: null,
    actionFeedbackMessage: "",
    previewTheme: ui.applyThemeFromQuery(),
    pollTimerId: null,
    pollInFlight: false,
  };

  var els = {
    langToggle: document.getElementById("lang-toggle"),
    container: document.getElementById("loading-container"),
    statusBadge: document.getElementById("status-badge"),
    statusDot: document.getElementById("status-dot"),
    statusSyncIcon: document.getElementById("status-sync-icon"),
    statusErrorIcon: document.getElementById("status-error-icon"),
    statusBadgeText: document.getElementById("status-badge-text"),
    title: document.getElementById("loading-title"),
    description: document.getElementById("loading-description"),
    hint: document.getElementById("loading-hint"),
    progressRegion: document.getElementById("progress-region"),
    errorPanel: document.getElementById("error-panel"),
    errorSummaryLabel: document.getElementById("error-summary-label"),
    errorSummaryMessage: document.getElementById("error-summary-message"),
    retryBtn: document.getElementById("btn-retry"),
    retrySpinner: document.getElementById("btn-retry-spinner"),
    retryIcon: document.getElementById("btn-retry-icon"),
    retryText: document.getElementById("btn-retry-text"),
    consoleBtn: document.getElementById("btn-console"),
    consoleSpinner: document.getElementById("btn-console-spinner"),
    consoleIcon: document.getElementById("btn-console-icon"),
    consoleText: document.getElementById("btn-console-text"),
    reportIssueBtn: document.getElementById("btn-report-issue"),
    reportIssueText: document.getElementById("btn-report-issue-text"),
    actionFeedback: document.getElementById("action-feedback"),
    actionFeedbackIconError: document.getElementById("action-feedback-icon-error"),
    actionFeedbackIconInfo: document.getElementById("action-feedback-icon-info"),
    actionFeedbackText: document.getElementById("action-feedback-text"),
    previewBar: document.getElementById("preview-bar"),
  };

  function getCopy() {
    return COPY[state.locale] || COPY["zh-CN"];
  }

  function render() {
    var t = getCopy();
    var currentStatus = state.status;
    var isError = currentStatus === "error";
    var isReconnecting = currentStatus === "reconnecting";

    document.title = t.pageTitle[currentStatus] || "CodexHost";
    ui.updateLocaleToggle(els.langToggle, state.locale);

    els.container.setAttribute("data-status", currentStatus);
    els.statusBadge.className =
      "badge status-pill " +
      (isError ? "badge--error" : isReconnecting ? "badge--warn" : "badge--brand");

    ui.setHidden(els.statusDot, isReconnecting || isError);
    ui.setHidden(els.statusSyncIcon, !isReconnecting);
    ui.setHidden(els.statusErrorIcon, !isError);
    els.statusBadgeText.textContent = t.badge[currentStatus];

    els.title.textContent = t.title[currentStatus];
    els.description.textContent = t.description[currentStatus];

    if (!isError && state.message) {
      ui.setHidden(els.hint, false);
      els.hint.textContent = state.message;
    } else {
      ui.setHidden(els.hint, true);
      els.hint.textContent = "";
    }

    ui.setHidden(els.progressRegion, isError);
    ui.setHidden(els.errorPanel, !isError);

    if (isError) {
      var fallbackError = ui.hasNativeBridge() ? t.errorFallback : t.previewErrorSample;
      var displayedError = state.message || fallbackError;
      els.errorSummaryLabel.textContent = t.errorLabel;
      els.errorSummaryMessage.textContent = displayedError;
      if (els.reportIssueBtn) {
        els.reportIssueBtn.href = ui.buildIssueUrl({
          error: state.actionFeedbackMessage || displayedError,
          version: state.version,
          platform: state.platform,
          surface: "native-shell",
        });
      }
      if (els.reportIssueText) {
        els.reportIssueText.textContent = t.reportIssueBtn;
      }
    }

    els.retryBtn.disabled = state.retrying || state.openingConsole;
    els.retryBtn.setAttribute("aria-busy", state.retrying ? "true" : "false");
    ui.setHidden(els.retrySpinner, !state.retrying);
    ui.setHidden(els.retryIcon, state.retrying);
    els.retryText.textContent = state.retrying ? t.retryingBtn : t.retryBtn;

    els.consoleBtn.disabled = state.openingConsole || state.retrying;
    els.consoleBtn.setAttribute("aria-busy", state.openingConsole ? "true" : "false");
    ui.setHidden(els.consoleSpinner, !state.openingConsole);
    ui.setHidden(els.consoleIcon, state.openingConsole);
    els.consoleText.textContent = state.openingConsole ? t.consoleOpeningBtn : t.consoleBtn;

    if (isError && state.actionFeedbackMessage) {
      var isInfo = state.actionFeedbackKind === "info";
      ui.setHidden(els.actionFeedback, false);
      els.actionFeedback.className = isInfo
        ? "feedback-banner feedback-banner--info"
        : "feedback-banner feedback-banner--error";
      els.actionFeedback.setAttribute("role", isInfo ? "status" : "alert");
      ui.setHidden(els.actionFeedbackIconError, isInfo);
      ui.setHidden(els.actionFeedbackIconInfo, !isInfo);
      els.actionFeedbackText.textContent = state.actionFeedbackMessage;
    } else {
      ui.setHidden(els.actionFeedback, true);
      els.actionFeedbackText.textContent = "";
    }

    renderPreviewBar();
  }

  function scheduleNextPoll() {
    if (state.pollTimerId !== null) {
      window.clearTimeout(state.pollTimerId);
      state.pollTimerId = null;
    }
    if (!ui.hasNativeBridge()) {
      return;
    }
    var delay = state.status === "error" ? POLL_ERROR_MS : POLL_ACTIVE_MS;
    state.pollTimerId = window.setTimeout(function () {
      state.pollTimerId = null;
      pollState();
    }, delay);
  }

  function pollState() {
    if (state.pollInFlight) {
      return Promise.resolve();
    }
    state.pollInFlight = true;

    return ui
      .readShellState({
        codexDesktopInstalled: true,
        locale: state.locale,
        status: state.status,
        message: state.message,
      })
      .then(function (result) {
        state.pollInFlight = false;
        if (!result.isNative) {
          return;
        }
        if (!state.localeLockedByUser && result.state.locale) {
          state.locale = result.state.locale;
        }
        state.version = result.state.version;
        state.platform = result.state.platform;
        if (!result.bridgeError) {
          var prevStatus = state.status;
          state.status = result.state.status;
          state.message = result.state.message;
          if (prevStatus === "error" && state.status !== "error") {
            state.actionFeedbackKind = null;
            state.actionFeedbackMessage = "";
          }
          render();
        }
        scheduleNextPoll();
      });
  }

  function handleRetry() {
    if (state.retrying || state.openingConsole) {
      return;
    }
    state.retrying = true;
    state.actionFeedbackKind = null;
    state.actionFeedbackMessage = "";
    render();

    var bridge = ui.getNativeBridge();
    if (bridge && typeof bridge.retry === "function") {
      Promise.resolve()
        .then(function () {
          return bridge.retry();
        })
        .then(
          function () {
            state.retrying = false;
            state.status = "starting";
            state.message = "";
            render();
            return pollState();
          },
          function (err) {
            var t = getCopy();
            state.retrying = false;
            state.actionFeedbackKind = "error";
            state.actionFeedbackMessage =
              t.retryErrorPrefix + ui.formatError(err, t.actionErrorFallback);
            render();
          },
        );
      return;
    }

    // Offline preview simulation
    window.setTimeout(function () {
      state.retrying = false;
      state.status = "starting";
      state.message = "";
      render();
    }, 520);
  }

  function handleOpenConsole() {
    if (state.openingConsole || state.retrying) {
      return;
    }
    state.openingConsole = true;
    state.actionFeedbackKind = null;
    state.actionFeedbackMessage = "";
    render();

    var bridge = ui.getNativeBridge();
    if (bridge && typeof bridge.openConsole === "function") {
      Promise.resolve()
        .then(function () {
          return bridge.openConsole();
        })
        .then(
          function () {
            state.openingConsole = false;
            render();
          },
          function (err) {
            var t = getCopy();
            state.openingConsole = false;
            state.actionFeedbackKind = "error";
            state.actionFeedbackMessage =
              t.consoleErrorPrefix + ui.formatError(err, t.actionErrorFallback);
            render();
          },
        );
      return;
    }

    // Offline preview simulation
    window.setTimeout(function () {
      var t = getCopy();
      state.openingConsole = false;
      state.actionFeedbackKind = "info";
      state.actionFeedbackMessage = t.previewConsoleNotice;
      render();
    }, 360);
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

    var statuses = [
      { id: "starting", label: t.previewStarting },
      { id: "reconnecting", label: t.previewReconnecting },
      { id: "error", label: t.previewError },
    ];
    for (var i = 0; i < statuses.length; i += 1) {
      (function (item) {
        els.previewBar.appendChild(
          createPreviewChip(item.label, state.status === item.id, function () {
            state.status = item.id;
            state.actionFeedbackKind = null;
            state.actionFeedbackMessage = "";
            if (item.id !== "error") {
              state.message = "";
            }
            render();
          }),
        );
      })(statuses[i]);
    }

    var divider = document.createElement("span");
    divider.className = "preview-divider";
    els.previewBar.appendChild(divider);

    var themes = [
      { id: "system", label: t.previewThemeAuto },
      { id: "light", label: t.previewThemeLight },
      { id: "dark", label: t.previewThemeDark },
    ];
    for (var j = 0; j < themes.length; j += 1) {
      (function (themeItem) {
        els.previewBar.appendChild(
          createPreviewChip(themeItem.label, state.previewTheme === themeItem.id, function () {
            state.previewTheme = themeItem.id;
            ui.setThemeOverride(themeItem.id);
            render();
          }),
        );
      })(themes[j]);
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

  els.retryBtn.addEventListener("click", handleRetry);
  els.consoleBtn.addEventListener("click", handleOpenConsole);

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && ui.hasNativeBridge()) {
      pollState();
    }
  });

  render();
  pollState();

  var loadingDitherCv = document.getElementById("loading-dither-orbit");
  if (
    loadingDitherCv &&
    window.CodexHostDitherFX &&
    typeof window.CodexHostDitherFX.startLoadingOrbitalDither === "function"
  ) {
    window.CodexHostDitherFX.startLoadingOrbitalDither(loadingDitherCv, function () {
      return state.status;
    });
  }
})();
