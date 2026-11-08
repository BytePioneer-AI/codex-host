/* Static demonstration only: no Host access, uploads, persistence, or commands. */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const app = $(".app"),
  sidebar = $("#sidebar"),
  overlay = $("#overlay"),
  messages = $("#messages"),
  draft = $("#draft");
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const query = new URLSearchParams(location.search);
if (query.get("preview") === "1") document.body.classList.add("preview");
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const baseTranscript = messages.innerHTML;
const catalog = {
  main: ["修复移动端输入框遮挡", "Claude Code", "已完成"],
  approval: ["运行移动端测试", "Claude Code", "等待批准"],
  question: ["移动端测试范围", "Claude Code", "等待回答"],
  running: ["检查 Relay 重连逻辑", "Codex", "运行中"],
  pi: ["梳理 Adapter 生命周期", "Pi", "运行中"],
  error: ["整理设置页交互", "Cursor", "连接中断"],
  new: ["新对话", "Claude Code", ""],
  archived: ["旧版导航验证", "Codex", "已完成"],
};
const identities = {
  "Claude Code": ["Cl", "claude"],
  Codex: ["Co", "codex"],
  Pi: ["Pi", "pi"],
  Cursor: ["Cu", "cursor"],
};
const modelLists = {
  "Claude Code": ["Sonnet 4.6", "Opus 4.6"],
  Codex: ["GPT-5.4"],
  Pi: ["Harness 默认"],
  Cursor: ["Harness 默认"],
};
const panelTitles = {
  usage: "用量统计",
  context: "上下文占用",
  screenshot: "电脑桌面截图",
  recents: "最近访问",
  settings: "设置",
  harness: "Harness",
  model: "模型",
  attachments: "文件与指令",
  permission: "会话权限",
  workspace: "选择工作区",
  files: "文件",
  import: "导入 Thread",
  "approval-detail": "命令详情",
};
const sectionNames = {
  general: "通用",
  devices: "连接设备",
  connections: "连接",
  accounts: "账号",
  resources: "资源管理",
  usage: "用量统计",
  extensions: "界面扩展",
  updates: "更新",
  about: "关于",
};
const states = new Map(),
  decisions = new Map(),
  createdProjects = new Map();
const usageSamples = {
  main: { cache: 99.9, tps: 36.5, cost: 2.31, context: 66, capacity: 200000 },
  running: { tps: 28.4, context: 38, capacity: 200000 },
  pi: { tps: 42.1 },
};
let captureOwner = "",
  captureTimer,
  voice = { phase: "idle" },
  voiceTimer,
  transcriptionTimer;
const voiceExample = "请检查移动端输入框的安全区。";
const recentVisits =
  query.get("history") === "empty"
    ? []
    : query.get("history") === "single"
      ? ["main"]
      : ["main", "running", "error", "pi", "approval", "question"];
let active = "",
  newHarness = "Claude Code",
  pendingHarness,
  model,
  workspace = "codex-host-web",
  nextCreatedId = 1;
let overlayKind,
  returnHash = "thread",
  lastFocus,
  toastTimer,
  foldTools = true,
  currentRoute = "thread",
  focusAfterSwitch = false;
const sidebarControls = createSidebarControls({
  getStatus: statusFor,
  onAddWorkspace(name) {
    workspace = name;
    const button = document.createElement("button");
    button.className = "choice-button";
    button.dataset.workspace = name;
    button.textContent = name;
    $("#panel-workspace").content.querySelector(".sheet-body").append(button);
    if (location.hash === "#new") route();
    else location.hash = "new";
    toast("已添加示例工作区，未访问 Host");
  },
});
function hasWorkspace() {
  return active !== "new" || !!workspace;
}
function toast(text) {
  clearTimeout(toastTimer);
  $(".toast").textContent = text;
  $(".toast").hidden = false;
  toastTimer = setTimeout(() => ($(".toast").hidden = true), 2400);
}
function currentHarness() {
  return active === "new" ? newHarness : catalog[active][1];
}
function projectFor(id) {
  return id === "new"
    ? workspace || "未选择工作区"
    : createdProjects.get(id) || (id === "error" ? "console-ui" : "codex-host-web");
}
function branchFor(id) {
  return id === "new"
    ? ""
    : ["main", "approval", "question"].includes(id)
      ? "fix/mobile-composer"
      : "main";
}
function routeFor(id) {
  return id === "main" ? "thread" : id;
}
function statusFor(id) {
  return decisions.get(id) || catalog[id][2];
}
function statusColor(id) {
  return id === "error"
    ? "red"
    : ["approval", "question"].includes(id) && !decisions.has(id)
      ? "amber"
      : ["running", "pi"].includes(id)
        ? "green"
        : "";
}
function visit(id) {
  if (id === "new") return;
  const index = recentVisits.indexOf(id);
  if (index >= 0) recentVisits.splice(index, 1);
  recentVisits.unshift(id);
}
function updateHeaderSize() {
  app.style.setProperty("--chrome-top", `${$(".app-header").getBoundingClientRect().height}px`);
}
new ResizeObserver(updateHeaderSize).observe($(".app-header"));
function renderRecentStrip(reset = false) {
  const rail = $("#recent-shortcuts"),
    previousLeft = rail.scrollLeft;
  const others = recentVisits.filter((id) => id !== active);
  $(".recent-strip").hidden = recentVisits.length < 2 || !others.length;
  $(".title-switcher").disabled = recentVisits.length === 0;
  $("#recent-shortcuts").replaceChildren();
  others.slice(0, 6).forEach((id) => {
    const link = document.createElement("a");
    link.className = "recent-chip";
    link.href = `#${routeFor(id)}`;
    link.dataset.recent = id;
    link.setAttribute(
      "aria-label",
      `切换到 ${catalog[id][0]}，${projectFor(id)}，${statusFor(id)}`,
    );
    const line = document.createElement("span");
    line.className = "recent-chip-title";
    const title = document.createElement("strong");
    const duplicate = recentVisits.some(
      (other) => other !== id && catalog[other][0] === catalog[id][0],
    );
    title.textContent = duplicate ? `${projectFor(id)} · ${catalog[id][0]}` : catalog[id][0];
    line.append(title);
    const color = statusColor(id);
    if (color) {
      const dot = document.createElement("span");
      dot.className = `dot ${color}`;
      dot.setAttribute("aria-hidden", "true");
      line.append(dot);
    }
    link.append(line);
    rail.append(link);
  });
  updateHeaderSize();
  rail.scrollLeft = reset ? 0 : previousLeft;
}
function renderRecentList() {
  const list = $("#recent-list");
  list.replaceChildren();
  overlay.classList.toggle("recent-panel-empty", !recentVisits.length);
  recentVisits.forEach((id) => {
    const link = document.createElement("a");
    link.className = "recent-row";
    link.href = `#${routeFor(id)}`;
    link.dataset.recent = id;
    if (id === active) link.setAttribute("aria-current", "page");
    const [initials, cls] = identities[catalog[id][1]];
    const mark = document.createElement("span");
    mark.className = `harness-mark ${cls}`;
    mark.textContent = initials;
    mark.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    copy.className = "recent-row-copy";
    const title = document.createElement("strong");
    title.textContent = catalog[id][0];
    const subtitle = document.createElement("small");
    subtitle.textContent = `${projectFor(id)} · ${catalog[id][1]}`;
    const branch = document.createElement("small");
    branch.textContent = `分支 · ${branchFor(id)}`;
    const meta = document.createElement("span");
    meta.className = "recent-row-meta";
    const status = document.createElement("span");
    status.textContent = statusFor(id);
    const color = statusColor(id);
    if (color) {
      const dot = document.createElement("span");
      dot.className = `dot ${color}`;
      dot.setAttribute("aria-hidden", "true");
      status.prepend(dot);
    }
    meta.append(status);
    if (states.get(id)?.draft.trim()) {
      const badge = document.createElement("span");
      badge.textContent = "有草稿";
      meta.append(badge);
    }
    copy.append(title, subtitle);
    if (id === active) copy.append(branch);
    copy.append(meta);
    link.append(mark, copy);
    if (id === active) {
      const current = document.createElement("span");
      current.className = "recent-current";
      current.textContent = "当前";
      link.append(current);
    }
    link.dataset.search = `${catalog[id][0]} ${projectFor(id)} ${catalog[id][1]}`.toLowerCase();
    list.append(link);
  });
  $("#recent-count").textContent = recentVisits.length
    ? `${recentVisits.length} 个最近访问`
    : "从侧栏开始";
  $(".recent-empty").hidden = recentVisits.length > 0;
  $(".recent-search").hidden = !recentVisits.length;
  list.hidden = !recentVisits.length;
  $("#recent-search").addEventListener("input", (e) => {
    const term = e.target.value.trim().toLowerCase();
    const rows = $$(".recent-row", list);
    rows.forEach((row) => (row.hidden = !row.dataset.search.includes(term)));
    const count = rows.filter((row) => !row.hidden).length;
    list.hidden = count === 0;
    $(".recent-no-results").hidden = count > 0;
    $("#recent-count").textContent = term
      ? `${count} 个匹配 / ${rows.length} 个访问`
      : `${rows.length} 个最近访问`;
  });
}
function syncUsage() {
  const usage = usageSamples[active];
  const parts = !usage
    ? []
    : [
        usage.cache === undefined ? null : `CH ${usage.cache}%`,
        usage.tps === undefined ? null : `${usage.tps} tok/s`,
        usage.cost === undefined ? null : `$${usage.cost.toFixed(2)}`,
      ].filter(Boolean);
  $("#usage-summary").textContent = parts.join(" · ");
  $(".usage-summary").hidden = !parts.length;
  const context = usage?.context;
  $(".context-summary").hidden = context === undefined;
  $("#context-summary").textContent = context === undefined ? "" : `${context}%`;
  $("#context-arc").setAttribute("stroke-dasharray", `${context ?? 0} 100`);
  $(".context-summary").setAttribute(
    "aria-label",
    `上下文已用 ${context ?? "未知"}%（示例），查看详情`,
  );
  $("#usage-unavailable").hidden = !!parts.length || context !== undefined;
}
function fillUsagePanel(kind) {
  const usage = usageSamples[active];
  if (kind === "usage") {
    $$("[data-metric]", overlay).forEach((row) => {
      const value = usage?.[row.dataset.metric];
      row.hidden = value === undefined;
      $("dd", row).textContent =
        value === undefined
          ? ""
          : row.dataset.metric === "cost"
            ? `$${value.toFixed(2)}`
            : `${value}${row.dataset.metric === "cache" ? "%" : " tok/s"}`;
    });
    $(".metric-empty", overlay).hidden = !!usage;
  } else {
    const available = usage?.context !== undefined && usage?.capacity !== undefined;
    $(".context-heading", overlay).hidden = !available;
    $("#context-progress").hidden = !available;
    $(".metric-empty", overlay).hidden = available;
    if (available) {
      $("#context-percent").textContent = `${usage.context}%`;
      $("#context-tokens").textContent =
        `约 ${(usage.capacity * usage.context) / 100000}K / ${usage.capacity / 1000}K tokens`;
      $("#context-progress").value = usage.context;
    }
  }
}
function screenshotFailure(failed) {
  clearTimeout(captureTimer);
  $(".desktop-example", overlay).hidden = failed;
  $(".capture-error", overlay).hidden = !failed;
  $('[data-action="attach-screenshot"]').disabled = failed;
  $('[data-action="refresh-screenshot"]').disabled = false;
  $('[data-action="refresh-screenshot"]').textContent = "重新截图 · 演示";
}
function refreshScreenshot() {
  clearTimeout(captureTimer);
  const owner = active;
  $('[data-action="refresh-screenshot"]').disabled = true;
  $('[data-action="attach-screenshot"]').disabled = true;
  $('[data-action="refresh-screenshot"]').textContent = "正在获取示例画面…";
  captureTimer = setTimeout(() => {
    if (overlay.open && overlayKind === "screenshot" && active === owner && captureOwner === owner)
      screenshotFailure(false);
  }, 450);
}
function syncVoice() {
  const live = ["recording", "transcribing"].includes(voice.phase);
  $("#composer-form").classList.toggle("voice-live", live);
  $("#voice-controls").hidden = !live;
  $("#voice-phase").textContent = voice.phase === "transcribing" ? "转写演示…" : "模拟录音";
  const seconds = voice.phase === "recording" ? Math.floor((Date.now() - voice.started) / 1000) : 0;
  $("#voice-clock").textContent =
    `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")} · 未录音`;
  $("#voice-entry").disabled = voice.phase !== "idle" || active === "error";
  $('[data-action="voice-stop"]').disabled = voice.phase !== "recording";
  $("#voice-notice").hidden = !["text", "failed"].includes(voice.phase);
  $("#voice-notice-copy").textContent =
    voice.phase === "failed"
      ? "权限失败示例：请在浏览器站点设置中允许麦克风。本原型未申请权限，也没有录音。"
      : `草稿或会话已变化，示例转写未自动插入：${voiceExample}`;
  $('[data-action="voice-insert"]').hidden = voice.phase !== "text";
  $('[data-action="voice-insert"]').disabled = !hasWorkspace() || active === "error";
  $('[data-action="voice-retry"]').hidden = voice.phase !== "failed";
  syncInput();
  updateDockSize();
}
function discardVoice() {
  clearInterval(voiceTimer);
  clearTimeout(transcriptionTimer);
  voice = { phase: "idle" };
  syncVoice();
}
function startVoice() {
  if (active === "new" || active === "error" || !hasWorkspace()) return;
  discardVoice();
  voice = {
    phase: "recording",
    owner: active,
    draft: draft.value,
    start: draft.selectionStart,
    end: draft.selectionEnd,
    started: Date.now(),
  };
  syncVoice();
  voiceTimer = setInterval(syncVoice, 1000);
}
function finishVoice(send = false) {
  if (voice.phase !== "recording" || (send && (voice.owner !== active || voice.detached))) return;
  clearInterval(voiceTimer);
  if (send) voice.draft = draft.value;
  voice.phase = "transcribing";
  syncVoice();
  transcriptionTimer = setTimeout(() => {
    if (
      !voice.detached &&
      active === voice.owner &&
      draft.value === voice.draft &&
      !$("#composer-dock").hidden &&
      active !== "error"
    ) {
      const start = send ? draft.value.length : voice.start,
        end = send ? draft.value.length : voice.end;
      draft.value = draft.value.slice(0, start) + voiceExample + draft.value.slice(end);
      discardVoice();
      if (send) $("#composer-form").requestSubmit();
      else toast("示例转写已填入草稿，尚未发送");
    } else {
      voice.phase = "text";
      syncVoice();
    }
  }, 450);
}
function updateDockSize() {
  const el = !$("#approval-dock").hidden
    ? $("#approval-dock")
    : !$("#question-dock").hidden
      ? $("#question-dock")
      : $("#composer-dock");
  app.style.setProperty(
    "--dock-height",
    `${el.getBoundingClientRect().height + (!$("#composer-dock").hidden ? 0 : 44)}px`,
  );
}
new ResizeObserver(updateDockSize).observe($("#composer-dock"));
new ResizeObserver(updateDockSize).observe($("#approval-dock"));
new ResizeObserver(updateDockSize).observe($("#question-dock"));
function syncInput() {
  const primary = $('#composer-form [type="submit"]');
  primary.disabled =
    active === "error" ||
    !hasWorkspace() ||
    voice.phase === "transcribing" ||
    (voice.phase === "recording"
      ? voice.owner !== active || voice.detached
      : !draft.value.trim() && $(".attachment-list").hidden && $(".screenshot-attachment").hidden);
  primary.setAttribute(
    "aria-label",
    voice.phase === "recording" ? "转写并发送（本地演示）" : "发送消息",
  );
  draft.style.height = "auto";
  draft.style.height = `${Math.min(draft.scrollHeight, 140)}px`;
}
function save() {
  if (active)
    states.set(active, {
      html: messages.innerHTML,
      draft: draft.value,
      model,
      attachment: !$(".attachment-list").hidden,
      scrollTop: messages.scrollTop,
      screenshot: !$(".screenshot-attachment").hidden,
    });
}
function appendMessage(text, user = false) {
  const article = document.createElement("article");
  article.className = user ? "user-message" : "agent-message";
  const p = document.createElement("p");
  p.textContent = text;
  article.append(p);
  messages.append(article);
}
function render(id) {
  const switching = active !== id,
    state = states.get(id);
  if (switching) {
    save();
    clearTimeout(captureTimer);
    captureOwner = "";
    if (["recording", "transcribing"].includes(voice.phase)) voice.detached = true;
    active = id;
    visit(id);
    messages.innerHTML = state?.html || (["main", "approval"].includes(id) ? baseTranscript : "");
    draft.value = state?.draft ?? (id === "error" ? "请保留现有设置分类，只调整窄屏布局。" : "");
    $(".attachment-list").hidden = !state?.attachment;
    $(".screenshot-attachment").hidden = !state?.screenshot;
    model = state?.model || modelLists[currentHarness()][0];
    if (!state && !["main", "approval", "new"].includes(id) && !createdProjects.has(id)) {
      const copy = {
        running: ["检查 Relay 重连逻辑，重点关注事件恢复。", "正在读取重连流程与事件游标。"],
        pi: ["梳理 Adapter 生命周期与包边界。", "正在检查 Session 与 Turn 的公共契约。"],
        question: ["补充移动端键盘行为的测试。", "开始前请确认：这次覆盖哪些设备？"],
        error: [
          "整理设置页的移动端交互，保留原来的分类。",
          "已读取设置面板结构，正在检查窄屏样式。",
        ],
        archived: [
          "验证旧版导航的入口。",
          "这是已归档会话的示例内容，用于演示归档筛选，不读取真实历史记录。",
        ],
      }[id];
      appendMessage(copy[0], true);
      appendMessage(copy[1]);
    }
  }
  const isNew = id === "new",
    harness = currentHarness();
  app.classList.toggle("is-new", isNew);
  messages.hidden = isNew;
  $(".empty-content").hidden = !isNew;
  $("#thread-title").textContent = catalog[id][0];
  $(".title-switcher").setAttribute(
    "aria-label",
    `切换会话，当前：${catalog[id][0]}，${projectFor(id)}，${statusFor(id)}`,
  );
  $("#current-status").className = `dot ${statusColor(id)}`;
  $("#current-status").hidden = !statusColor(id);
  $("#approval-dock").hidden = id !== "approval" || decisions.has(id);
  $("#question-dock").hidden = id !== "question" || decisions.has(id);
  $("#composer-dock").hidden = !$("#approval-dock").hidden || !$("#question-dock").hidden;
  app.classList.toggle("has-request", $("#composer-dock").hidden);
  $("#connection-notice").hidden = id !== "error";
  const [initials, cls] = identities[harness];
  $("#composer-harness").textContent = initials;
  $("#composer-harness").className = `harness-mark ${cls}`;
  $("#harness-caption").textContent = harness;
  $("#model-label").textContent = model;
  $('[data-overlay="model"]').setAttribute("aria-label", `选择模型，当前 ${model}`);
  $("#screenshot-entry").hidden = isNew;
  $("#screenshot-entry").disabled = id === "error";
  $("#voice-entry").hidden = isNew;
  $("#voice-entry").disabled = id === "error";
  $("#workspace-choice-label").textContent = workspace || "选择工作区";
  draft.readOnly = !hasWorkspace();
  draft.placeholder = !hasWorkspace()
    ? "选择一个工作区开始"
    : isNew
      ? "描述你想要构建的内容，\n/ 调用指令，@ 文件或对话"
      : "发消息或创建任务，\n/ 调用指令，@ 文件或对话";
  sidebarControls.selectThread(id);
  const activity = $(".activity");
  if (activity && switching && !state) activity.open = !foldTools;
  renderRecentStrip(switching);
  syncUsage();
  syncVoice();
  if (switching) messages.scrollTop = state?.scrollTop || 0;
}
function motion(el, axis, sign, finish) {
  let position = 0,
    velocity = 0,
    target = 0,
    raf = 0,
    previous = 0,
    closing = false,
    drag;
  const dimension = () => (axis === "X" ? el.offsetWidth : el.offsetHeight);
  const paint = () => (el.style.transform = `translate${axis}(${position * sign}px)`);
  function step(time) {
    cancelAnimationFrame(raf);
    if (reduced.matches) {
      position = target;
      paint();
      if (closing) finish();
      return;
    }
    const dt = Math.min((time - previous) / 1000 || 1 / 60, 1 / 30);
    previous = time || performance.now();
    const omega = (2 * Math.PI) / 0.32;
    velocity += (-omega * omega * (position - target) - 2 * omega * velocity) * dt;
    position += velocity * dt;
    paint();
    if (Math.abs(position - target) < 0.4 && Math.abs(velocity) < 3) {
      position = target;
      paint();
      if (closing) finish();
      return;
    }
    raf = requestAnimationFrame(step);
  }
  return {
    open() {
      closing = false;
      position = reduced.matches ? 0 : axis === "X" ? dimension() : 40;
      velocity = 0;
      target = 0;
      previous = performance.now();
      paint();
      step();
    },
    close() {
      closing = true;
      target = dimension() + 30;
      previous = performance.now();
      step();
    },
    stop() {
      cancelAnimationFrame(raf);
      el.style.transform = "";
      closing = false;
    },
    bind(handle) {
      handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || !el.open) return;
        cancelAnimationFrame(raf);
        handle.setPointerCapture(e.pointerId);
        closing = false;
        drag = {
          start: axis === "X" ? e.clientX : e.clientY,
          origin: position,
          history: [{ p: position, t: performance.now() }],
          active: false,
        };
      });
      handle.addEventListener("pointermove", (e) => {
        if (!drag) return;
        const delta = ((axis === "X" ? e.clientX : e.clientY) - drag.start) * sign;
        if (!drag.active && Math.abs(delta) < 8) return;
        drag.active = true;
        const next = drag.origin + delta;
        position =
          next < 0 ? (reduced.matches ? 0 : (next * 132) / (240 + 0.55 * Math.abs(next))) : next;
        const now = performance.now();
        drag.history.push({ p: position, t: now });
        drag.history = drag.history.filter((p) => now - p.t < 90);
        paint();
      });
      const release = (e) => {
        if (!drag) return;
        const first = drag.history[0],
          last = drag.history.at(-1);
        velocity =
          performance.now() - last.t < 100
            ? (last.p - first.p) / Math.max(0.001, (last.t - first.t) / 1000)
            : 0;
        closing =
          e.type !== "pointercancel" &&
          drag.active &&
          position + velocity * 0.499 > dimension() * 0.35;
        target = closing ? dimension() + 30 : 0;
        drag = null;
        previous = performance.now();
        step();
      };
      handle.addEventListener("pointerup", release);
      handle.addEventListener("pointercancel", release);
    },
  };
}
function restoreFocus() {
  if (lastFocus?.isConnected && lastFocus.getClientRects().length)
    lastFocus.focus({ preventScroll: true });
  else $('[data-action="sidebar"]').focus({ preventScroll: true });
}
function finishSidebar() {
  sideMotion.stop();
  sidebar.close();
  if (
    [
      "threads",
      "sidebar-more",
      "view-options",
      "add-workspace",
      "recents",
      "recent-empty",
    ].includes(location.hash.slice(1))
  )
    history.replaceState(null, "", `#${returnHash}`);
  restoreFocus();
}
function finishOverlay() {
  overlayMotion.stop();
  filesMotion.stop();
  overlay.close();
  if (
    [
      "settings",
      "harness",
      "files",
      "recents",
      "recent-empty",
      "usage",
      "context",
      "screenshot",
    ].includes(location.hash.slice(1))
  )
    history.replaceState(null, "", `#${returnHash}`);
  restoreFocus();
}
const sideMotion = motion(sidebar, "X", -1, finishSidebar);
const overlayMotion = motion(overlay, "Y", 1, finishOverlay);
const filesMotion = motion(overlay, "X", 1, finishOverlay);
const overlayController = {
  close() {
    (overlayKind === "files" ? filesMotion : overlayMotion).close();
  },
};
sideMotion.bind($(".sidebar-drag-edge"));
overlayMotion.bind($(".sheet-handle"));
function openSidebar() {
  sidebarControls.reset();
  if (overlay.open) {
    overlayMotion.stop();
    filesMotion.stop();
    overlay.close();
  }
  lastFocus = document.activeElement;
  returnHash = [
    "threads",
    "sidebar-more",
    "view-options",
    "add-workspace",
    "recents",
    "recent-empty",
  ].includes(currentRoute)
    ? routeFor(active)
    : currentRoute;
  sidebar.showModal();
  $(".sidebar-head").focus({ preventScroll: true });
  sideMotion.open();
}
function openOverlay(kind) {
  lastFocus = document.activeElement;
  if (sidebar.open) {
    sideMotion.stop();
    sidebar.close();
  }
  if (overlay.open) {
    overlayMotion.stop();
    filesMotion.stop();
    overlay.close();
  }
  returnHash = active === "new" ? "new" : active === "main" ? "thread" : active;
  overlayKind = kind;
  overlay.className = `sheet glass ${kind === "settings" ? "settings-panel" : kind === "files" ? "files-panel" : kind === "recents" ? "recent-panel" : ""}`;
  $("#overlay-title").textContent = panelTitles[kind];
  $("#overlay-content").replaceChildren($(`#panel-${kind}`).content.cloneNode(true));
  if (kind === "recents") {
    save();
    renderRecentList();
  }
  if (["usage", "context"].includes(kind)) fillUsagePanel(kind);
  if (kind === "screenshot") {
    clearTimeout(captureTimer);
    captureOwner = active;
  }
  if (kind === "harness") {
    pendingHarness = currentHarness();
    const bound = active !== "new";
    $("#harness-note").textContent = bound
      ? "当前 Thread 已绑定 Harness。其他 Harness 仅可用于新对话。"
      : "为新 Thread 选择 Harness，Model 单独选择。";
    $$("[data-harness]", overlay).forEach((b) => {
      b.setAttribute("aria-checked", String(b.dataset.harness === pendingHarness));
      b.disabled = bound && b.dataset.harness !== pendingHarness;
    });
    $('[data-action="confirm-harness"]').hidden = bound;
    $("#new-with-harness").hidden = !bound;
  }
  if (kind === "model") {
    const body = $(".sheet-body", overlay);
    $$("[data-model]", body).forEach((b) => b.remove());
    modelLists[currentHarness()].forEach((name) => {
      const b = document.createElement("button");
      b.className = "choice-button";
      b.dataset.model = name;
      b.textContent = name;
      if (name === model) b.insertAdjacentHTML("beforeend", icon("check"));
      body.append(b);
    });
  }
  if (kind === "settings") {
    syncMaterialControls();
    $('[data-action="fold"]').setAttribute("aria-checked", String(foldTools));
    $("#font-label").textContent = document.body.classList.contains("large-text") ? "较大" : "标准";
  }
  overlay.showModal();
  $("#overlay-title").focus({ preventScroll: true });
  (kind === "files" ? filesMotion : overlayMotion).open();
}
function route() {
  if (sidebar.open) {
    sideMotion.stop();
    sidebar.close();
  }
  if (overlay.open) {
    overlayMotion.stop();
    filesMotion.stop();
    overlay.close();
  }
  const name = location.hash.slice(1) || "thread";
  currentRoute = name;
  if (["threads", "sidebar-more", "view-options", "add-workspace"].includes(name)) {
    if (!active) render("main");
    openSidebar();
    if (name !== "threads") sidebarControls.show(name);
  } else if (["settings", "files", "recents", "usage", "context", "screenshot"].includes(name)) {
    if (!active) render(name === "recents" && !recentVisits.length ? "new" : "main");
    openOverlay(name);
  } else if (name === "recent-empty") {
    recentVisits.length = 0;
    render("new");
    openOverlay("recents");
  } else if (name === "harness") {
    render("new");
    openOverlay("harness");
  } else if (["new", "empty"].includes(name)) {
    if (name === "empty") workspace = "";
    else if (!workspace) workspace = "codex-host-web";
    render("new");
  } else {
    render(
      name === "thread" || name === "composer" || name === "diff"
        ? "main"
        : catalog[name]
          ? name
          : "main",
    );
  }
  if (name === "composer" && !draft.value) {
    draft.value = "也请检查横屏时的安全区，\n不要改变桌面端布局。";
    syncInput();
  }
  if (name === "diff") showDiff();
  if (name === "voice") startVoice();
  if (name === "voice-error") {
    discardVoice();
    voice = { phase: "failed" };
    syncVoice();
  }
  if (focusAfterSwitch) {
    focusAfterSwitch = false;
    $(".title-switcher").focus({ preventScroll: true });
  }
  document.title = `codexhost · ${catalog[active][0]} · 移动适配原型`;
  if (parent !== window) parent.postMessage({ prototypeRoute: name }, "*");
}
function showDiff() {
  const diff = $("#inline-diff");
  if (!diff) return;
  diff.open = true;
  requestAnimationFrame(() => {
    messages.scrollTop +=
      diff.getBoundingClientRect().top - $(".app-header").getBoundingClientRect().bottom - 24;
  });
}
function syncMaterialControls() {
  $$("[data-material]").forEach((b) =>
    b.setAttribute(
      "aria-pressed",
      String(
        (b.dataset.material === "solid") === document.body.classList.contains("solid-material"),
      ),
    ),
  );
}
function material(value) {
  document.body.classList.toggle("solid-material", value === "solid");
  syncMaterialControls();
}
material(query.get("material"));
window.addEventListener("message", (e) => {
  if (e.source === parent && ["glass", "solid"].includes(e.data?.prototypeMaterial))
    material(e.data.prototypeMaterial);
});
for (const [dialog, animation] of [
  [sidebar, sideMotion],
  [overlay, overlayController],
]) {
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    animation.close();
  });
  dialog.addEventListener("click", (e) => {
    const r = dialog.getBoundingClientRect();
    if (
      e.target === dialog &&
      (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
    )
      animation.close();
  });
}
draft.addEventListener("input", syncInput);
draft.addEventListener("click", () => {
  if (!hasWorkspace()) openOverlay("workspace");
});
$("#composer-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (voice.phase === "recording") {
    finishVoice(true);
    return;
  }
  if (voice.phase === "transcribing") return;
  const text = draft.value.trim(),
    screenshot = !$(".screenshot-attachment").hidden;
  if (
    (!text && $(".attachment-list").hidden && !screenshot) ||
    active === "error" ||
    !hasWorkspace()
  )
    return;
  if (active === "new") {
    const id = `created-${nextCreatedId++}`;
    catalog[id] = [text.split(/\r?\n/)[0].slice(0, 60), newHarness, "演示已记录"];
    createdProjects.set(id, workspace);
    states.set(id, { html: "", draft: "", model, attachment: false, scrollTop: 0 });
    states.delete("new");
    active = "";
    render(id);
    history.replaceState(null, "", `#${id}`);
    currentRoute = id;
    sidebarControls.addThread({
      id,
      title: catalog[id][0],
      harness: newHarness,
      project: workspace,
    });
  }
  appendMessage(text || (screenshot ? "示例桌面截图" : "示例文件：viewport-notes.txt"), true);
  if (screenshot) {
    const image = document.createElement("img");
    image.src = "assets/sample-desktop.png";
    image.alt = "本地示例截图，未上传";
    image.className = "message-screenshot";
    messages.lastElementChild.append(image);
  }
  appendMessage("已记录在本地原型中，未发送到 Host。");
  draft.value = "";
  $(".attachment-list").hidden = true;
  $(".screenshot-attachment").hidden = true;
  syncInput();
  draft.blur();
  requestAnimationFrame(() => (messages.scrollTop = messages.scrollHeight));
  toast("消息已记录 · 本地演示");
});
document.addEventListener("click", (e) => {
  const b = e.target.closest("button,a");
  if (!b || b.disabled) return;
  if (b.dataset.recent) {
    e.preventDefault();
    if (b.dataset.recent === active) {
      overlayController.close();
      return;
    }
    focusAfterSwitch = true;
    const target = routeFor(b.dataset.recent);
    if (location.hash === `#${target}`) route();
    else location.hash = target;
    return;
  }
  if (b.matches('a[href^="#"]') && b.hash === location.hash) {
    e.preventDefault();
    route();
  }
  if (b.dataset.overlay) openOverlay(b.dataset.overlay);
  if (b.dataset.harness) {
    pendingHarness = b.dataset.harness;
    $$("[data-harness]", overlay).forEach((el) =>
      el.setAttribute("aria-checked", String(el === b)),
    );
  }
  if (b.dataset.model) {
    model = b.dataset.model;
    $("#model-label").textContent = model;
    $('[data-overlay="model"]').setAttribute("aria-label", `选择模型，当前 ${model}`);
    overlayMotion.close();
  }
  if (b.dataset.workspace) {
    if (active === "new") {
      workspace = b.dataset.workspace;
      render("new");
    } else toast("当前 Thread 项目保持固定；请新建对话选择工作区。");
    overlayMotion.close();
  }
  if (b.dataset.material) material(b.dataset.material);
  if (b.dataset.section) {
    const general = b.dataset.section === "general";
    $$("[data-section]").forEach((el) => el.setAttribute("aria-pressed", String(el === b)));
    $('[data-settings="general"]').hidden = !general;
    $('[data-settings="other"]').hidden = general;
    $("#settings-section-title").textContent = sectionNames[b.dataset.section];
    $("#settings-section-copy").textContent =
      b.dataset.section === "devices"
        ? "沿用现有「连接设备」入口。本原型不生成访问令牌或二维码，也不连接真实设备。"
        : `保留现有「${sectionNames[b.dataset.section]}」分类与入口。本次只演示窄屏容器和毛玻璃材质，不重做该功能。`;
  }
  if (b.dataset.decision) {
    const text = b.dataset.decision === "approve" ? "已批准一次 · 演示" : "已拒绝 · 演示";
    decisions.set(active, text);
    appendMessage(`${text}。未执行命令或提交真实决定。`);
    render(active);
    toast(text);
  }
  switch (b.dataset.action) {
    case "sidebar":
      openSidebar();
      break;
    case "browse-sidebar":
      openSidebar();
      lastFocus = $('[data-action="sidebar"]');
      break;
    case "close-sidebar":
      sideMotion.close();
      break;
    case "close-overlay":
      overlayController.close();
      break;
    case "show-diff":
      if (overlay.open) {
        overlayMotion.stop();
        filesMotion.stop();
        overlay.close();
      }
      if (active !== "main" && active !== "approval") render("main");
      showDiff();
      break;
    case "answer": {
      const value = $('input[name="device"]:checked').value;
      decisions.set(active, "已回答 · 演示");
      appendMessage(value, true);
      appendMessage("回答仅记录在本地原型中。");
      render(active);
      toast("回答已记录");
      break;
    }
    case "confirm-harness":
      if (active === "new") {
        newHarness = pendingHarness;
        model = modelLists[newHarness][0];
        render("new");
      }
      overlayMotion.close();
      break;
    case "attach":
      $(".attachment-list").hidden = false;
      syncInput();
      overlayMotion.close();
      break;
    case "remove-attachment":
      $(".attachment-list").hidden = true;
      syncInput();
      break;
    case "attach-screenshot":
      if (captureOwner === active) {
        $(".screenshot-attachment").hidden = false;
        syncInput();
        overlayMotion.close();
      }
      break;
    case "remove-screenshot":
      $(".screenshot-attachment").hidden = true;
      syncInput();
      break;
    case "refresh-screenshot":
      refreshScreenshot();
      break;
    case "screenshot-error":
      screenshotFailure(true);
      break;
    case "voice-start":
      startVoice();
      break;
    case "voice-stop":
      finishVoice();
      break;
    case "voice-discard":
      discardVoice();
      break;
    case "voice-retry":
      startVoice();
      break;
    case "voice-insert":
      if (voice.phase === "text" && hasWorkspace() && active !== "error") {
        draft.value =
          draft.value.slice(0, draft.selectionStart) +
          voiceExample +
          draft.value.slice(draft.selectionEnd);
        discardVoice();
      }
      break;
    case "command":
      draft.value += "/";
      syncInput();
      overlayMotion.stop();
      overlay.close();
      draft.focus();
      break;
    case "font":
      document.body.classList.toggle("large-text");
      $("#font-label").textContent = document.body.classList.contains("large-text")
        ? "较大"
        : "标准";
      break;
    case "fold":
      foldTools = !foldTools;
      b.setAttribute("aria-checked", String(foldTools));
      if ($(".activity")) $(".activity").open = !foldTools;
      break;
    case "retry":
      b.disabled = true;
      $("span", b).textContent = "正在连接…";
      setTimeout(() => {
        b.disabled = false;
        $("span", b).textContent = "重新连接";
        $("#connection-copy").textContent = "示例：Host 仍未响应。草稿保留，消息不会自动重发。";
      }, 800);
      break;
  }
});
overlay.addEventListener("keydown", (e) => {
  if (
    !e.target.matches("[data-harness]") ||
    !["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)
  )
    return;
  e.preventDefault();
  const list = $$("[data-harness]:not(:disabled)", overlay),
    n = list.indexOf(e.target),
    dir = ["ArrowDown", "ArrowRight"].includes(e.key) ? 1 : -1;
  const next = list[(n + dir + list.length) % list.length];
  next.focus();
  next.click();
});
document.addEventListener("keydown", (e) => {
  if (
    e.key === "Escape" &&
    !overlay.open &&
    !sidebar.open &&
    ["recording", "transcribing"].includes(voice.phase)
  ) {
    e.preventDefault();
    discardVoice();
  }
});
function viewport() {
  const vv = visualViewport;
  if (!vv || vv.scale !== 1) return;
  document.documentElement.style.setProperty("--visible-height", `${vv.height}px`);
  document.documentElement.style.setProperty("--viewport-top", `${vv.offsetTop}px`);
  document.documentElement.style.setProperty(
    "--keyboard-bottom",
    `${Math.max(0, innerHeight - vv.height - vv.offsetTop)}px`,
  );
  document.body.classList.toggle("keyboard-open", innerHeight - vv.height > 120);
}
visualViewport?.addEventListener("resize", viewport);
visualViewport?.addEventListener("scroll", viewport);
window.addEventListener("hashchange", route);
viewport();
route();
