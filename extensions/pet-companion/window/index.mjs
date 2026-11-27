import { createSprite, petState } from "../shared/sprite.mjs";
import { translate } from "./strings.mjs";
import { createHarnessIcons } from "./harness-icons.mjs";

const root = document.querySelector("#pet");
const locale = navigator.language;
const message = (key, values) => translate(locale, key, values);
document.documentElement.lang = locale;
root.innerHTML = `<div class="companion">
  <section class="session-panel" id="overview" aria-labelledby="overview-title" hidden>
    <header><div><p class="eyebrow">CODEXHOST</p><h1 id="overview-title" data-label="overview"></h1></div><div class="panel-tools"><button class="preferences-toggle icon-button" aria-pressed="false" aria-controls="window-preferences"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></svg></button><button class="pin icon-button" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 3 6 0-1 6 4 4v2H6v-2l4-4-1-6Zm3 12v6"/></svg></button><button class="close icon-button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></div></header>
    <div class="tasks-view">
      <div class="task-counts" role="status"><span><strong class="running-count">0</strong><small data-label="runningCount"></small></span><span><strong class="waiting-count">0</strong><small data-label="waitingCount"></small></span><span><strong class="unread-count">0</strong><small data-label="unreadCount"></small></span></div>
      <div class="session-list" aria-label="Recent sessions"></div>
      <div class="actions"><button class="open-host" data-label="open"></button><button class="ack secondary" data-label="acknowledge"></button></div>
    </div>
    <div class="window-preferences" id="window-preferences" hidden><p class="preference-intro" data-label="preferencesHint"></p><div class="preference-fields"><label class="size-setting"><span data-label="size"></span><output class="size-value"></output><input class="size" type="range" min="120" max="260" step="4"></label><label><span><strong data-label="hover"></strong><small data-label="hoverHint"></small></span><input class="hover-expand" type="checkbox" role="switch"></label><label><span><strong data-label="bubble"></strong><small data-label="bubbleHint"></small></span><input class="show-status" type="checkbox" role="switch"></label><label><span><strong data-label="lock"></strong><small data-label="lockHint"></small></span><input class="lock-position" type="checkbox" role="switch"></label></div><button class="back secondary" data-label="back"></button></div>
    <footer><span class="pet-name"></span><button class="hide quiet" data-label="hide"></button></footer>
    <p class="feedback" role="status" hidden></p>
  </section>
  <div class="pet-stage"><button class="pet-button" aria-controls="overview" aria-expanded="false"><canvas aria-hidden="true"></canvas></button>
  <button class="status" aria-controls="overview" aria-expanded="false"><strong></strong><span></span></button></div>
</div>`;
const query = (selector) => root.querySelector(selector);
for (const node of root.querySelectorAll("[data-label]"))
  node.textContent = message(node.dataset.label);
query(".session-list").setAttribute("aria-label", message("sessions"));
query(".close").setAttribute("aria-label", message("close"));
query(".hide").title = message("hideHint");
query(".size").setAttribute("aria-label", message("size"));
query(".session-list").title = message("more");
query(".preferences-toggle").setAttribute("aria-label", message("preferences"));
query(".preferences-toggle").title = message("preferences");
const controller = new AbortController();
const signal = controller.signal;
const renderHarnessIcon = createHarnessIcons(signal, message("unknownAgent"));
const on = (selector, type, listener) =>
  query(selector).addEventListener(type, listener, { signal });
let sprite, identity, snapshot, refreshing, poll, hoverTimer, leaveTimer, feedbackTimer, dragStart;
let stopped = false,
  expanded = false,
  pinned = false,
  suppressed = false;
const rows = new Map();
const updateHitRegions = () => {
  const regions = [...root.querySelectorAll(".pet-button, .status, .session-panel")]
    .map((node) => node.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map(({ x, y, width, height }) => ({ x: Math.max(0, x), y: Math.max(0, y), width, height }));
  void window.codexhostWindow?.setHitRegions(regions).catch(() => undefined);
};
const resize = new ResizeObserver(updateHitRegions);
resize.observe(query(".companion"));
resize.observe(query(".session-panel"));
const expand = (value) => {
  expanded = value;
  query(".session-panel").hidden = !value;
  for (const node of root.querySelectorAll("[aria-controls='overview']"))
    node.setAttribute("aria-expanded", String(value));
  root.dataset.expanded = String(value);
  updateHitRegions();
};
const pin = (value) => {
  pinned = value;
  query(".pin").setAttribute("aria-pressed", String(value));
  query(".pin").setAttribute("aria-label", message(value ? "unpin" : "pin"));
  query(".pin").title = message(value ? "unpin" : "pin");
};
const toggle = () => {
  if (expanded && pinned) {
    close();
    return;
  }
  suppressed = false;
  pin(true);
  expand(true);
};
const close = () => {
  clearTimeout(hoverTimer);
  suppressed = true;
  pin(false);
  query(".pet-button").focus({ preventScroll: true });
  expand(false);
};
pin(false);
on(".companion", "pointerenter", (event) => {
  clearTimeout(leaveTimer);
  if (event.pointerType !== "mouse" || suppressed || snapshot?.settings.hoverExpand === false)
    return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => expand(true), 220);
});
on(".companion", "pointerleave", () => {
  clearTimeout(hoverTimer);
  suppressed = false;
  leaveTimer = setTimeout(() => {
    if (!pinned && !query(".companion").contains(document.activeElement)) expand(false);
  }, 280);
});
on(".companion", "focusin", () => {
  if (!suppressed) expand(true);
});
on(".companion", "focusout", () => {
  queueMicrotask(() => {
    if (
      !pinned &&
      !query(".companion").contains(document.activeElement) &&
      !query(".companion").matches(":hover")
    )
      expand(false);
  });
});
on(".close", "click", close);
on(".pin", "click", () => pin(!pinned));
const preferences = (visible) => {
  query(".window-preferences").hidden = !visible;
  query(".tasks-view").hidden = visible;
  query(".preferences-toggle").setAttribute("aria-pressed", String(visible));
  query("#overview-title").textContent = message(visible ? "preferences" : "overview");
  updateHitRegions();
};
on(".preferences-toggle", "click", () => preferences(query(".window-preferences").hidden));
on(".back", "click", () => {
  preferences(false);
  query(".preferences-toggle").focus({ preventScroll: true });
});
on(".status", "click", toggle);
on(".pet-button", "contextmenu", (event) => {
  event.preventDefault();
  pin(true);
  expand(true);
});
on(".pet-button", "pointerdown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  dragStart = { x: event.clientX, y: event.clientY, dragged: false };
  query(".pet-button").setPointerCapture(event.pointerId);
});
on(".pet-button", "pointermove", (event) => {
  if (!dragStart || dragStart.dragged || snapshot?.settings.lockPosition) return;
  if (Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y) < 6) return;
  dragStart.dragged = true;
  suppressed = true;
  clearTimeout(hoverTimer);
  pin(false);
  expand(false);
  if (query(".pet-button").hasPointerCapture(event.pointerId))
    query(".pet-button").releasePointerCapture(event.pointerId);
  void window.codexhostWindow?.startDragging().catch(() => undefined);
});
on(".pet-button", "pointerup", () => {
  if (dragStart && !dragStart.dragged) toggle();
  dragStart = undefined;
});
on(".pet-button", "pointercancel", () => {
  dragStart = undefined;
});
on(".pet-button", "click", (event) => {
  if (event.detail === 0) toggle();
});
document.addEventListener(
  "keydown",
  (event) => {
    if (event.key === "Escape" && expanded) {
      event.preventDefault();
      close();
    }
  },
  { signal },
);
const feedback = (key) => {
  clearTimeout(feedbackTimer);
  query(".feedback").textContent = message(key);
  query(".feedback").hidden = false;
  feedbackTimer = setTimeout(() => {
    query(".feedback").hidden = true;
  }, 3500);
};
const action = async (input) => {
  try {
    const response = await fetch("action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });
    if (!response.ok) throw new Error("Action failed");
    if (input.type === "open") feedback("opened");
    else if (input.type === "acknowledge") feedback("read");
    await refresh();
  } catch {
    if (!stopped) feedback("failed");
  }
};
const configure = (values) => action({ type: "configure", values });
on(".open-host", "click", () => void action({ type: "open" }));
on(".ack", "click", () => {
  if (snapshot)
    void action({
      type: "acknowledge",
      epoch: snapshot.activity.epoch,
      revision: snapshot.activity.revision,
    });
});
on(".hide", "click", () => void action({ type: "hide" }));
on(".size", "input", (event) => {
  query(".size-value").textContent = `${event.target.value}px`;
});
on(".size", "change", (event) => void configure({ size: Number(event.target.value) }));
for (const [selector, key] of [
  [".hover-expand", "hoverExpand"],
  [".show-status", "showStatus"],
  [".lock-position", "lockPosition"],
])
  on(selector, "change", (event) => void configure({ [key]: event.target.checked }));

const renderSessions = (activity) => {
  const list = query(".session-list");
  const sessions = activity.sessions ?? [];
  const ids = new Set(sessions.map((session) => session.threadId));
  for (const [id, row] of rows)
    if (!ids.has(id)) {
      row.remove();
      rows.delete(id);
    }
  query(".task-counts").setAttribute("aria-label", message("summary", activity));
  query(".running-count").textContent = String(activity.running);
  query(".waiting-count").textContent = String(activity.waiting);
  query(".unread-count").textContent = String(activity.notifications.length);
  if (!sessions.length) {
    if (!list.querySelector(".empty")) {
      const empty = document.createElement("div");
      empty.className = "empty";
      const title = document.createElement("strong");
      title.textContent = message("empty");
      const hint = document.createElement("p");
      hint.textContent = message("emptyHint");
      empty.append(title, hint);
      list.append(empty);
    }
    return;
  }
  list.querySelector(".empty")?.remove();
  sessions.forEach((session, index) => {
    let row = rows.get(session.threadId);
    if (!row) {
      row = document.createElement("button");
      row.className = "session";
      row.innerHTML = `<span class="session-avatar"><span class="harness-icon"></span><span class="indicator" aria-hidden="true"></span></span><span class="session-copy"><strong></strong><small></small></span><span class="session-end"><span class="session-state"></span><span class="unread"></span></span>`;
      row.addEventListener(
        "click",
        () => void action({ type: "open", threadId: session.threadId }),
        { signal },
      );
      rows.set(session.threadId, row);
    }
    const name = session.title || message("untitled");
    const stateKey = `state${session.state[0].toUpperCase()}${session.state.slice(1)}`;
    row.dataset.state = session.state;
    renderHarnessIcon(row.querySelector(".harness-icon"), session.harness);
    row.querySelector("strong").textContent = name;
    const agentName = session.harness?.name || message("unknownAgent");
    row.querySelector("small").textContent = `${agentName} · ${session.project}`;
    row.querySelector(".session-state").textContent = message(stateKey);
    row.title = `${message("openSession")} · ${name} · ${agentName}`;
    row.setAttribute(
      "aria-label",
      `${message("openSession")} · ${name} · ${agentName} · ${session.project} · ${message(stateKey)}`,
    );
    const unread = activity.notifications.filter(
      (item) => item.threadId === session.threadId,
    ).length;
    row.querySelector(".unread").textContent = String(unread);
    row.querySelector(".unread").hidden = !unread;
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
  });
};
const refresh = () =>
  (refreshing ??= (async () => {
    try {
      const response = await fetch("state", { signal });
      if (!response.ok) throw new Error("Window state unavailable");
      const state = await response.json();
      const pet = state.selected;
      if (pet && identity !== pet.digest) {
        const next = await createSprite(
          query("canvas"),
          `sprite?v=${encodeURIComponent(pet.digest)}`,
          signal,
          pet.renderer,
        );
        sprite?.dispose();
        sprite = next;
        identity = pet.digest;
      }
      if (stopped) return;
      snapshot = state;
      const { status, unread } = petState(state.activity);
      sprite?.setState(status);
      root.style.setProperty("--pet-size", `${state.settings.size}px`);
      root.dataset.locked = String(state.settings.lockPosition === true);
      query(".pet-button").setAttribute(
        "aria-label",
        message(state.settings.lockPosition ? "lockedPet" : "pet"),
      );
      query(".status strong").textContent = message(status);
      query(".status span").textContent = message("summary", state.activity);
      query(".status").dataset.state = status;
      query(".status").hidden = state.settings.showStatus === false;
      query(".ack").disabled = !unread.length;
      query(".pet-name").textContent = pet?.builtin
        ? message("otterName")
        : (pet?.name ?? "Pet Companion");
      if (document.activeElement !== query(".size")) {
        query(".size").value = String(state.settings.size);
        query(".size-value").textContent = `${state.settings.size}px`;
      }
      query(".hover-expand").checked = state.settings.hoverExpand !== false;
      query(".show-status").checked = state.settings.showStatus !== false;
      query(".lock-position").checked = state.settings.lockPosition === true;
      renderSessions(state.activity);
      document.title = `${pet?.name ?? "Pet Companion"} · ${message(status)}`;
      updateHitRegions();
    } catch {
      if (!stopped) query(".status strong").textContent = message("reconnecting");
    }
  })().finally(() => {
    refreshing = undefined;
  }));
const tick = async () => {
  await refresh();
  if (!stopped) poll = setTimeout(tick, 1500);
};
window.addEventListener(
  "pagehide",
  () => {
    stopped = true;
    controller.abort();
    clearTimeout(poll);
    clearTimeout(hoverTimer);
    clearTimeout(leaveTimer);
    clearTimeout(feedbackTimer);
    sprite?.dispose();
    resize.disconnect();
  },
  { once: true },
);
updateHitRegions();
void tick();
