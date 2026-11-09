const paths = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M21 13a9 9 0 0 1-10-10A9 9 0 1 0 21 13Z"/>',
  monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  settings:
    '<path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/>',
  box: '<path d="m12 3 9 5v9l-9 5-9-5V8l9-5ZM3 8l9 5 9-5m-9 5v9M7.5 5.5l9 5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-12 7.7L3 21l1.8-6A8.5 8.5 0 1 1 21 11.5Z"/>',
  command: '<path d="M9 7V5a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v14a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2V7Z"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.01"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
};

const labels = {
  general: "通用设置",
  resources: "资源管理",
  harnesses: "连接与 Harness",
  accounts: "账号与额度",
};
const state = { preference: "light", fontSize: 14, wrap: true, release: true, selects: {} };
const content = document.querySelector("#page-content");
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
const initialQuery = new URLSearchParams(location.search);
let toastTimeout;

function updateQuery(key, value) {
  const url = new URL(location.href);
  if (value) url.searchParams.set(key, value);
  else url.searchParams.delete(key);
  history.replaceState(null, "", url);
}

function mountIcons(root = document) {
  for (const element of root.querySelectorAll("[data-icon]")) {
    const path = paths[element.dataset.icon];
    if (path)
      element.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  }
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  updateQuery("theme", theme);
  for (const button of document.querySelectorAll("[data-view]")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === theme));
  }
}

function notify(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.hidden = true;
  }, 2600);
}

function syncControls() {
  for (const button of content.querySelectorAll("[data-preference]")) {
    button.setAttribute("aria-pressed", String(button.dataset.preference === state.preference));
  }
  for (const button of content.querySelectorAll("[data-setting]")) {
    button.setAttribute("aria-checked", String(state[button.dataset.setting]));
  }
  for (const select of content.querySelectorAll("select")) {
    if (state.selects[select.id]) select.value = state.selects[select.id];
  }
  const output = content.querySelector("#font-size");
  if (output) output.value = state.fontSize;
  for (const button of content.querySelectorAll("[data-step]")) {
    button.disabled = Number(button.dataset.step) < 0 ? state.fontSize <= 12 : state.fontSize >= 20;
  }
}

function showPage(id, focus = false) {
  const template = document.getElementById(`${id}-template`);
  if (!template) return;
  updateQuery("page", id);
  content.replaceChildren(template.content.cloneNode(true));
  content.scrollTop = 0;
  document.querySelector("#breadcrumb-current").textContent = labels[id];
  for (const button of document.querySelectorAll("[data-page]")) {
    button.classList.toggle("active", button.dataset.page === id);
    if (button.dataset.page === id) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  mountIcons(content);
  syncControls();
  if (focus) content.focus({ preventScroll: true });
}

const launchDialog = mountLaunchDialog({ mountIcons, notify, updateQuery });

document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.page) showPage(button.dataset.page, true);
  if (button.dataset.view) {
    state.preference = button.dataset.view;
    setTheme(button.dataset.view);
    syncControls();
  }
  if (button.dataset.launch) launchDialog.open(button.dataset.launch);
  if (button.dataset.preference) {
    state.preference = button.dataset.preference;
    setTheme(
      state.preference === "system" ? (systemTheme.matches ? "dark" : "light") : state.preference,
    );
    syncControls();
  }
  if (button.dataset.setting) {
    state[button.dataset.setting] = !state[button.dataset.setting];
    syncControls();
  }
  if (button.dataset.step) {
    state.fontSize = Math.max(12, Math.min(20, state.fontSize + Number(button.dataset.step)));
    syncControls();
  }
  if (button.dataset.demo) notify(`${button.dataset.demo}：仅展示入口，未连接真实服务。`);
});
content.addEventListener("change", (event) => {
  if (event.target.matches("select")) {
    state.selects[event.target.id] = event.target.value;
    notify("已更新原型选项，不会影响实际设置。");
  }
});
systemTheme.addEventListener("change", () => {
  if (state.preference === "system") setTheme(systemTheme.matches ? "dark" : "light");
});
mountIcons();
const initialTheme = initialQuery.get("theme");
if (initialTheme === "light" || initialTheme === "dark") state.preference = initialTheme;
setTheme(state.preference);
const initialPage = initialQuery.get("page");
showPage(Object.hasOwn(labels, initialPage) ? initialPage : "general");
if (initialQuery.has("capture")) document.documentElement.dataset.capture = "";
if (initialQuery.get("dialog")) {
  showPage("harnesses");
  launchDialog.open(initialQuery.get("dialog"));
}
