/* Reuse the existing prototype's conversations, drafts, MRU and picker. */
const query = new URLSearchParams(location.search);
const standalone = query.get("standalone") === "1";
const initialView = standalone || query.get("view") === "light" ? "light" : "compare";

function setView(view) {
  document.body.dataset.view = view;
  document.querySelectorAll("button[data-view]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
  });
}

setView(initialView);
if (standalone) document.body.setAttribute("data-standalone", "");

for (const button of document.querySelectorAll("button[data-view]")) {
  button.addEventListener("click", () => setView(button.dataset.view));
}

for (const button of document.querySelectorAll("button[data-width]")) {
  button.addEventListener("click", () => {
    document.documentElement.style.setProperty("--preview-width", `${button.dataset.width}px`);
    document.querySelectorAll("button[data-width]").forEach((other) => {
      other.setAttribute("aria-pressed", String(other === button));
    });
  });
}

for (const frame of document.querySelectorAll("iframe[data-variant]")) {
  frame.addEventListener("load", () => {
    const document = frame.contentDocument;
    if (document === null || frame.dataset.variant !== "light") return;
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = "recent-navigation-variant.css?v=2";
    document.head.append(stylesheet);
    document
      .querySelector(".title-switcher")
      ?.setAttribute("aria-label", "查看完整会话标题，搜索或切换最近访问的对话");
  });
  frame.src = standalone ? "app.html#thread" : "app.html?preview=1#thread";
}
