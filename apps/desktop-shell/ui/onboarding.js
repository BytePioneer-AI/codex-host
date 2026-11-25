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
      nativeBadge: "轻量",
      nativeTitle: "CodexHost 桌面端",
      nativeSummary: "独立低内存窗口，支持多 Agent 与扩展",
      desktopBadge: "官方",
      desktopTitle: "Codex Desktop",
      desktopSummary: "官方桌面界面，自动接入外部 Agent",
      desktopUnavailable: "未在本机检测到 Codex Desktop",
      webLabel: "Web 浏览器",
      webRunning: "运行中",
      webIdle: "任意设备",
      webSummary: "免装客户端，任意设备浏览器随时即用",
      webCopy: "复制链接",
      webCopying: "准备中…",
      webCopied: "已复制",
      webOpenedInfo: "已在系统默认浏览器中打开本机 Web。",
      webErrorPrefix: "无法启动或打开 Web：",
      webErrorFallback: "请稍后重试，或从系统托盘打开诊断控制台。",
      hubLabel: "Host",
      hubSub: "三端会话实时同步",
      rememberDefault: "记住此选择，下次直接打开",
      footnote: "系统托盘可随时切换窗口或完全退出",
      footnoteRemembered: "下次将直接打开，随时可在系统托盘切换",
      chooseErrorPrefix: "无法打开所选方式：",
      chooseErrorFallback: "请稍后重试，或从系统托盘打开诊断控制台。",
      reportIssue: "提交 Issue",
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
      pageTitle: "CodexHost — Choose how to open",
      title: "Choose how to open",
      nativeBadge: "Lightweight",
      nativeTitle: "CodexHost Desktop",
      nativeSummary: "Low-memory native window for all Agents",
      desktopBadge: "Official",
      desktopTitle: "Codex Desktop",
      desktopSummary: "Official desktop UI with external Agents",
      desktopUnavailable: "Codex Desktop was not detected on this device",
      webLabel: "Web Browser",
      webRunning: "Running",
      webIdle: "Any Device",
      webSummary: "Zero install, open in any browser anywhere",
      webCopy: "Copy URL",
      webCopying: "Starting…",
      webCopied: "Copied",
      webOpenedInfo: "Opened local Web in your default browser.",
      webErrorPrefix: "Could not open Web: ",
      webErrorFallback: "Please try again or open diagnostics from the system tray.",
      hubLabel: "Host",
      hubSub: "Live 3-client session sync",
      rememberDefault: "Remember this choice and open it directly next time",
      footnote: "Switch windows or quit anytime from the system tray",
      footnoteRemembered: "Opens directly next time; switch anytime from the system tray",
      chooseErrorPrefix: "Could not open selection: ",
      chooseErrorFallback: "Please try again or open the diagnostic console from the system tray.",
      reportIssue: "Report Issue",
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

  function setText(el, text) {
    if (el) {
      el.textContent = text;
    }
  }

  function prefersReducedMotion() {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  var params = ui.getSearchParams();
  var state = {
    locale: ui.detectInitialLocale(),
    localeLockedByUser: ui.getQueryLocale() !== null,
    version: "",
    platform: "",
    codexDesktopInstalled: params.get("installed") !== "false",
    rememberDefault: params.get("remember") === "1" || params.get("remember") === "true",
    rememberTouchedByUser: false,
    submittingSurface: null,
    lastAttemptedSurface: "",
    webRunning: false,
    webUrl: "",
    webLoginUrl: "",
    webBusy: null,
    webCopied: false,
    feedbackKind: null,
    feedbackMessage: "",
    feedbackErrorDetail: "",
    previewTheme: ui.applyThemeFromQuery(),
    previewSimulateError: params.get("error") === "1" || params.get("error") === "true",
    hovered: -1,
  };
  var copiedTimer = null;

  var els = {
    langToggle: document.getElementById("lang-toggle"),
    title: document.getElementById("onboarding-title"),
    nativeCard: document.getElementById("card-native-shell"),
    nativeBadge: document.getElementById("native-badge"),
    nativeTitle: document.getElementById("native-title"),
    nativeSummary: document.getElementById("native-summary"),
    nativeSpinner: document.getElementById("native-spinner"),
    nativeArrow: document.getElementById("native-arrow"),
    desktopCard: document.getElementById("card-codex-desktop"),
    desktopBadge: document.getElementById("desktop-badge"),
    desktopTitle: document.getElementById("desktop-title"),
    desktopSummary: document.getElementById("desktop-summary"),
    desktopUnavailable: document.getElementById("desktop-unavailable"),
    desktopUnavailableText: document.getElementById("desktop-unavailable-text"),
    desktopSpinner: document.getElementById("desktop-spinner"),
    desktopArrow: document.getElementById("desktop-arrow"),
    webCard: document.getElementById("card-web-browser"),
    webLabel: document.getElementById("web-access-label"),
    webStatus: document.getElementById("web-access-status"),
    webSummary: document.getElementById("web-summary"),
    webCopyBtn: document.getElementById("web-copy-btn"),
    webCopySpinner: document.getElementById("web-copy-spinner"),
    webCopyIcon: document.getElementById("web-copy-icon"),
    webCopiedIcon: document.getElementById("web-copied-icon"),
    webCopyLabel: document.getElementById("web-copy-label"),
    webOpenSpinner: document.getElementById("web-open-spinner"),
    webOpenArrow: document.getElementById("web-open-arrow"),
    hubLabel: document.getElementById("hub-label"),
    hubSub: document.getElementById("hub-sub"),
    syncHub: document.getElementById("sync-hub"),
    feedbackBanner: document.getElementById("feedback-banner"),
    feedbackIconError: document.getElementById("feedback-icon-error"),
    feedbackIconInfo: document.getElementById("feedback-icon-info"),
    feedbackText: document.getElementById("feedback-text"),
    feedbackIssueLink: document.getElementById("feedback-issue-link"),
    feedbackIssueLabel: document.getElementById("feedback-issue-label"),
    rememberChoice: document.getElementById("remember-choice"),
    rememberCheckbox: document.getElementById("remember-default-checkbox"),
    rememberLabel: document.getElementById("remember-default-label"),
    footnoteText: document.getElementById("onboarding-footnote-text"),
    previewBar: document.getElementById("preview-bar"),
  };

  function getCopy() {
    return COPY[state.locale] || COPY["zh-CN"];
  }

  /* ---------------- Downward Converging Sync Beam Animation ---------------- */
  var cards = [els.nativeCard, els.desktopCard, els.webCard];
  var tracks = [0, 1, 2].map(function (i) {
    return document.getElementById("bt-" + i);
  });
  var hovers = [0, 1, 2].map(function (i) {
    return document.getElementById("bh-" + i);
  });
  var glows = [0, 1, 2].map(function (i) {
    return document.getElementById("bgl-" + i);
  });
  var cores = [0, 1, 2].map(function (i) {
    return document.getElementById("bco-" + i);
  });
  var grads = [0, 1, 2].map(function (i) {
    return document.getElementById("bg-" + i);
  });
  var lens = [80, 54, 80];

  function layoutBeams() {
    var band = document.getElementById("beam-band");
    var grid = document.getElementById("cards-grid");
    if (!band || !grid) {
      return;
    }
    var W = band.offsetWidth;
    var H = band.offsetHeight;
    if (!W || !H) {
      return;
    }
    var gr = grid.getBoundingClientRect();
    var cx = W / 2;
    var hubOff = [-20, 0, 20];
    for (var i = 0; i < 3; i += 1) {
      if (!cards[i] || !tracks[i]) {
        continue;
      }
      var r = cards[i].getBoundingClientRect();
      var xCard = r.left - gr.left + r.width / 2;
      var xHub = cx + hubOff[i];
      var d =
        i === 1
          ? "M " + xHub + " " + H + " L " + (xCard + 0.05) + " 0"
          : "M " +
            xHub +
            " " +
            H +
            " C " +
            xHub +
            " " +
            H * 0.48 +
            ", " +
            xCard +
            " " +
            H * 0.52 +
            ", " +
            xCard +
            " 0";
      tracks[i].setAttribute("d", d);
      hovers[i].setAttribute("d", d);
      glows[i].setAttribute("d", d);
      cores[i].setAttribute("d", d);
      lens[i] = tracks[i].getTotalLength() || 60;
      var pt = document.getElementById("bp-" + i);
      var rp = document.getElementById("br-" + i);
      if (pt) {
        pt.setAttribute("cx", String(xCard));
        pt.setAttribute("cy", "0");
      }
      if (rp) {
        rp.setAttribute("cx", String(xCard));
        rp.setAttribute("cy", "0");
      }
    }
  }

  function setBeam(i, tailF, headF, op) {
    var g = glows[i];
    var c = cores[i];
    var gr = grads[i];
    var tr = tracks[i];
    var L = lens[i];
    if (!g || !c || !gr || !tr) {
      return;
    }
    if (op <= 0.01 || Math.abs(headF - tailF) < 0.01) {
      g.style.opacity = "0";
      c.style.opacity = "0";
      return;
    }
    var p1 = tr.getPointAtLength(Math.max(0, Math.min(1, tailF)) * L);
    var p2 = tr.getPointAtLength(Math.max(0, Math.min(1, headF)) * L);
    gr.setAttribute("x1", String(p1.x));
    gr.setAttribute("y1", String(p1.y));
    gr.setAttribute("x2", String(p2.x));
    gr.setAttribute("y2", String(p2.y));
    var a = Math.min(tailF, headF) * L;
    var b = Math.max(tailF, headF) * L;
    var dash = Math.max(1, b - a) + " " + (L + 40);
    g.setAttribute("stroke-dasharray", dash);
    g.setAttribute("stroke-dashoffset", String(-a));
    g.style.opacity = String(op * 0.62);
    c.setAttribute("stroke-dasharray", dash);
    c.setAttribute("stroke-dashoffset", String(-a));
    c.style.opacity = String(op);
  }

  function setRip(i, p) {
    var rp = document.getElementById("br-" + i);
    if (!rp) {
      return;
    }
    if (p <= 0 || p >= 1) {
      rp.style.opacity = "0";
      return;
    }
    rp.setAttribute("r", String(3.2 + p * 8.5));
    rp.style.opacity = String((1 - p) * 0.72);
  }

  function pulseHub() {
    if (!els.syncHub) {
      return;
    }
    els.syncHub.classList.add("is-pulsing");
    window.setTimeout(function () {
      if (els.syncHub) {
        els.syncHub.classList.remove("is-pulsing");
      }
    }, 360);
  }

  function flashCard(i) {
    if (!cards[i]) {
      return;
    }
    cards[i].classList.add("is-synced");
    window.setTimeout(function () {
      if (cards[i]) {
        cards[i].classList.remove("is-synced");
      }
    }, 420);
  }

  var wave = {
    active: false,
    mode: "broadcast",
    src: 0,
    start: 0,
    dur: 1550,
    pulsed: false,
    hit: [false, false, false],
  };
  var nextAuto = performance.now() + 900;
  var cycle = 0;

  function startBroadcast() {
    wave = {
      active: true,
      mode: "broadcast",
      src: -1,
      start: performance.now(),
      dur: 1450,
      pulsed: false,
      hit: [false, false, false],
    };
    nextAuto = performance.now() + 2500;
  }

  function startRelay(src) {
    wave = {
      active: true,
      mode: "relay",
      src: src,
      start: performance.now(),
      dur: 1650,
      pulsed: false,
      hit: [false, false, false],
    };
    nextAuto = performance.now() + 2700;
  }

  function easeInOutCubic(x) {
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  }

  function tickBeams() {
    if (prefersReducedMotion()) {
      return;
    }
    var now = performance.now();
    if (!wave.active && now >= nextAuto) {
      if (cycle % 2 === 0) {
        startBroadcast();
      } else {
        startRelay(Math.floor(cycle / 2) % 3);
      }
      cycle += 1;
    }
    if (wave.active) {
      var p = (now - wave.start) / wave.dur;
      if (p >= 1) {
        wave.active = false;
        for (var k = 0; k < 3; k += 1) {
          setBeam(k, 0, 0, 0);
          setRip(k, 0);
        }
      } else if (wave.mode === "broadcast") {
        if (!wave.pulsed) {
          wave.pulsed = true;
          pulseHub();
        }
        var pb = easeInOutCubic(Math.min(1, p / 0.78));
        var fadeB = p < 0.08 ? p / 0.08 : p > 0.74 ? Math.max(0, (0.86 - p) / 0.12) : 1;
        for (var b = 0; b < 3; b += 1) {
          if (p <= 0.86) {
            setBeam(b, Math.max(0, pb - 0.38), pb, fadeB);
          } else {
            setBeam(b, 0, 0, 0);
          }
          if (p >= 0.72 && !wave.hit[b]) {
            wave.hit[b] = true;
            flashCard(b);
          }
          if (p >= 0.68) {
            setRip(b, Math.min(1, (p - 0.68) / 0.32));
          }
        }
      } else {
        if (p <= 0.44) {
          var pin = easeInOutCubic(Math.min(1, p / 0.41));
          var hd = 1 - pin;
          var tl = Math.min(1, hd + 0.36);
          setBeam(wave.src, tl, hd, p < 0.06 ? p / 0.06 : p > 0.39 ? (0.44 - p) / 0.05 : 1);
          for (var o = 0; o < 3; o += 1) {
            if (o !== wave.src) {
              setBeam(o, 0, 0, 0);
            }
          }
        }
        if (p >= 0.39 && !wave.pulsed) {
          wave.pulsed = true;
          pulseHub();
        }
        if (p >= 0.44) {
          var poutR = (p - 0.44) / 0.44;
          var pout = easeInOutCubic(Math.min(1, Math.max(0, poutR)));
          var fOut =
            poutR < 0.08 ? poutR / 0.08 : poutR > 0.85 ? Math.max(0, (1 - poutR) / 0.15) : 1;
          setBeam(wave.src, 0, 0, 0);
          for (var j = 0; j < 3; j += 1) {
            if (j === wave.src) {
              continue;
            }
            if (poutR <= 1) {
              setBeam(j, Math.max(0, pout - 0.36), pout, fOut);
            } else {
              setBeam(j, 0, 0, 0);
            }
            if (poutR >= 0.85 && !wave.hit[j]) {
              wave.hit[j] = true;
              flashCard(j);
            }
            if (poutR >= 0.8) {
              setRip(j, Math.min(1, (poutR - 0.8) / 0.4));
            }
          }
        }
      }
    }
    window.requestAnimationFrame(tickBeams);
  }

  function syncHover() {
    for (var i = 0; i < 3; i += 1) {
      var st = state.hovered === -1 ? "idle" : state.hovered === i ? "active" : "peer";
      if (hovers[i]) {
        hovers[i].setAttribute("data-state", st);
      }
      var pt = document.getElementById("bp-" + i);
      if (pt) {
        pt.setAttribute("data-state", st);
      }
    }
  }

  /* ---------------- Render & Interactions ---------------- */
  function render() {
    var t = getCopy();
    document.title = t.pageTitle;
    ui.updateLocaleToggle(els.langToggle, state.locale);

    setText(els.title, t.title);
    setText(els.nativeBadge, t.nativeBadge);
    setText(els.nativeTitle, t.nativeTitle);
    setText(els.nativeSummary, t.nativeSummary);

    setText(els.desktopBadge, t.desktopBadge);
    setText(els.desktopTitle, t.desktopTitle);
    setText(els.desktopSummary, t.desktopSummary);
    setText(els.desktopUnavailableText, t.desktopUnavailable);

    setText(els.webLabel, t.webLabel);
    setText(els.webSummary, t.webSummary);
    if (els.webStatus) {
      els.webStatus.textContent = state.webRunning ? t.webRunning : t.webIdle;
      els.webStatus.setAttribute("data-running", state.webRunning ? "true" : "false");
    }

    setText(els.hubLabel, t.hubLabel);
    setText(els.hubSub, t.hubSub);
    setText(els.rememberLabel, t.rememberDefault);
    setText(els.footnoteText, state.rememberDefault ? t.footnoteRemembered : t.footnote);

    var isBusy = state.submittingSurface !== null;
    if (els.rememberCheckbox) {
      els.rememberCheckbox.checked = Boolean(state.rememberDefault);
      els.rememberCheckbox.disabled = isBusy;
    }
    if (els.rememberChoice) {
      els.rememberChoice.setAttribute("data-disabled", isBusy ? "true" : "false");
    }
    var nativePending = state.submittingSurface === "native-shell";
    var desktopPending = state.submittingSurface === "codex-desktop";
    var desktopUnavailable = !state.codexDesktopInstalled;

    if (els.nativeCard) {
      els.nativeCard.disabled = isBusy;
      els.nativeCard.setAttribute("aria-busy", nativePending ? "true" : "false");
      els.nativeCard.setAttribute("data-pending", nativePending ? "true" : "false");
      els.nativeCard.setAttribute("data-dimmed", isBusy && !nativePending ? "true" : "false");
    }
    ui.setHidden(els.nativeSpinner, !nativePending);
    ui.setHidden(els.nativeArrow, nativePending);

    if (els.desktopCard) {
      els.desktopCard.disabled = isBusy || desktopUnavailable;
      els.desktopCard.setAttribute("aria-disabled", desktopUnavailable ? "true" : "false");
      els.desktopCard.setAttribute("aria-busy", desktopPending ? "true" : "false");
      els.desktopCard.setAttribute("data-unavailable", desktopUnavailable ? "true" : "false");
      els.desktopCard.setAttribute("data-pending", desktopPending ? "true" : "false");
      els.desktopCard.setAttribute(
        "data-dimmed",
        isBusy && !desktopPending && !desktopUnavailable ? "true" : "false",
      );
    }
    ui.setHidden(els.desktopUnavailable, !desktopUnavailable);
    ui.setHidden(els.desktopSpinner, !desktopPending);
    ui.setHidden(els.desktopArrow, desktopPending || desktopUnavailable);

    var webDisabled = isBusy || state.webBusy !== null;
    var copying = state.webBusy === "copy";
    var opening = state.webBusy === "open";
    if (els.webCard) {
      els.webCard.setAttribute("aria-disabled", webDisabled ? "true" : "false");
      els.webCard.setAttribute("aria-busy", opening ? "true" : "false");
      els.webCard.setAttribute("data-pending", opening ? "true" : "false");
      els.webCard.setAttribute("data-dimmed", isBusy ? "true" : "false");
    }
    ui.setHidden(els.webOpenSpinner, !opening);
    ui.setHidden(els.webOpenArrow, opening);


    if (els.webCopyBtn) {
      els.webCopyBtn.disabled = webDisabled;
      setText(els.webCopyLabel, copying ? t.webCopying : state.webCopied ? t.webCopied : t.webCopy);
      ui.setHidden(els.webCopySpinner, !copying);
      ui.setHidden(els.webCopyIcon, copying || state.webCopied);
      ui.setHidden(els.webCopiedIcon, copying || !state.webCopied);
    }

    if (state.feedbackMessage && els.feedbackBanner) {
      var isInfo = state.feedbackKind === "info";
      ui.setHidden(els.feedbackBanner, false);
      els.feedbackBanner.className = isInfo
        ? "feedback-banner feedback-banner--info"
        : "feedback-banner feedback-banner--error";
      els.feedbackBanner.setAttribute("role", isInfo ? "status" : "alert");
      ui.setHidden(els.feedbackIconError, isInfo);
      ui.setHidden(els.feedbackIconInfo, !isInfo);
      setText(els.feedbackText, state.feedbackMessage);
      if (els.feedbackIssueLink) {
        ui.setHidden(els.feedbackIssueLink, isInfo);
        if (!isInfo) {
          els.feedbackIssueLink.href = ui.buildIssueUrl({
            error: state.feedbackErrorDetail || state.feedbackMessage,
            version: state.version,
            platform: state.platform,
            surface: state.lastAttemptedSurface || "onboarding",
          });
          setText(els.feedbackIssueLabel, t.reportIssue);
        }
      }
    } else if (els.feedbackBanner) {
      ui.setHidden(els.feedbackBanner, true);
      setText(els.feedbackText, "");
      ui.setHidden(els.feedbackIssueLink, true);
    }

    renderPreviewBar();
    window.requestAnimationFrame(layoutBeams);
  }

  function handleChooseSurface(surface) {
    if (state.submittingSurface !== null) {
      return;
    }
    if (surface === "codex-desktop" && !state.codexDesktopInstalled) {
      return;
    }

    var rememberDefault = els.rememberCheckbox
      ? Boolean(els.rememberCheckbox.checked)
      : Boolean(state.rememberDefault);
    state.rememberDefault = rememberDefault;
    state.submittingSurface = surface;
    state.lastAttemptedSurface = surface;
    state.feedbackKind = null;
    state.feedbackMessage = "";
    state.feedbackErrorDetail = "";
    render();

    var bridge = ui.getNativeBridge();
    if (bridge && typeof bridge.chooseSurface === "function") {
      Promise.resolve()
        .then(function () {
          return bridge.chooseSurface(surface, rememberDefault);
        })
        .catch(function (err) {
          var t = getCopy();
          var detail = ui.formatError(err, t.chooseErrorFallback);
          state.submittingSurface = null;
          state.feedbackKind = "error";
          state.feedbackMessage = t.chooseErrorPrefix + detail;
          state.feedbackErrorDetail = detail;
          render();
        });
      return;
    }

    window.setTimeout(function () {
      var t = getCopy();
      state.submittingSurface = null;
      if (state.previewSimulateError) {
        state.feedbackKind = "error";
        state.feedbackMessage = t.chooseErrorPrefix + t.previewErrorSample;
        state.feedbackErrorDetail = t.previewErrorSample;
      } else {
        var label = surface === "native-shell" ? t.nativeTitle : t.desktopTitle;
        state.feedbackKind = "info";
        state.feedbackMessage = t.previewNotice(label);
        state.feedbackErrorDetail = "";
      }
      render();
    }, 420);
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

  function handleCopyWebUrl(event) {
    if (event) {
      event.stopPropagation();
    }
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
          var detail = ui.formatError(err, t.webErrorFallback);
          state.webBusy = null;
          state.lastAttemptedSurface = "web-copy";
          state.feedbackKind = "error";
          state.feedbackMessage = t.webErrorPrefix + detail;
          state.feedbackErrorDetail = detail;
          render();
        });
      return;
    }

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
    state.feedbackErrorDetail = "";

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
          state.feedbackErrorDetail = "";
          render();
        })
        .catch(function (err) {
          var t = getCopy();
          var detail = ui.formatError(err, t.webErrorFallback);
          state.webBusy = null;
          state.lastAttemptedSurface = "web-open";
          state.feedbackKind = "error";
          state.feedbackMessage = t.webErrorPrefix + detail;
          state.feedbackErrorDetail = detail;
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

  for (var idx = 0; idx < cards.length; idx += 1) {
    (function (i) {
      if (!cards[i]) {
        return;
      }
      cards[i].addEventListener("pointerenter", function () {
        state.hovered = i;
        syncHover();
        startRelay(i);
      });
      cards[i].addEventListener("pointerleave", function () {
        state.hovered = -1;
        syncHover();
      });
    })(idx);
  }

  if (els.nativeCard) {
    els.nativeCard.addEventListener("click", function () {
      handleChooseSurface("native-shell");
    });
  }
  if (els.desktopCard) {
    els.desktopCard.addEventListener("click", function () {
      handleChooseSurface("codex-desktop");
    });
  }
  if (els.webCard) {
    els.webCard.addEventListener("click", handleOpenWebBrowser);
    els.webCard.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleOpenWebBrowser();
      }
    });
  }
  if (els.webCopyBtn) {
    els.webCopyBtn.addEventListener("click", handleCopyWebUrl);
  }
  if (els.rememberCheckbox) {
    els.rememberCheckbox.addEventListener("change", function () {
      state.rememberDefault = Boolean(els.rememberCheckbox.checked);
      state.rememberTouchedByUser = true;
    });
  }

  window.addEventListener("resize", layoutBeams);

  render();
  layoutBeams();
  window.requestAnimationFrame(tickBeams);

  ui.readShellState({
    codexDesktopInstalled: state.codexDesktopInstalled,
    rememberDefault: state.rememberDefault,
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
    if (!state.rememberTouchedByUser && state.submittingSurface === null) {
      state.rememberDefault = result.state.rememberDefault;
    }
    state.version = result.state.version;
    state.platform = result.state.platform;
    state.codexDesktopInstalled = result.state.codexDesktopInstalled;
    state.webRunning = result.state.webRunning;
    state.webUrl = result.state.webUrl;
    state.webLoginUrl = result.state.webLoginUrl;
    if (result.state.status === "error" && result.state.message) {
      state.feedbackKind = "error";
      state.feedbackMessage = result.state.message;
      state.feedbackErrorDetail = result.state.message;
    }
    render();
  });
})();
