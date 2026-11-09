/* Demonstration state is scoped to this page and never calls a Host. */
function mountLaunchDialog({ mountIcons, notify, updateQuery }) {
  const harnesses = {
    claude: { name: "Claude Code", command: "claude", logo: "✳", tone: "claude" },
    codex: { name: "Codex CLI", command: "codex", logo: "⌘", tone: "codex" },
    opencode: { name: "OpenCode", command: "opencode", logo: "o_", tone: "opencode" },
  };
  const savedPaths = new Map();
  const dialog = document.querySelector("#launch-dialog");
  const form = dialog.querySelector("form");
  const path = form.elements.namedItem("executable");
  const modes = [...form.querySelectorAll('[name="launch-mode"]')];
  let activeId;

  function syncMode() {
    const custom = form.elements.namedItem("launch-mode").value === "custom";
    path.disabled = !custom;
    path.required = custom;
    dialog.querySelector(".path-field").hidden = !custom;
  }

  function open(id) {
    const harness = harnesses[id];
    if (!harness) return;
    activeId = id;
    dialog.querySelector("#launch-name").textContent = harness.name;
    dialog.querySelector("#launch-title").textContent = `${harness.name} 设置`;
    const logo = dialog.querySelector(".harness-logo");
    logo.className = `harness-logo ${harness.tone}`;
    logo.textContent = harness.logo;
    const saved = savedPaths.get(id);
    form.elements.namedItem("launch-mode").value = saved ? "custom" : "automatic";
    path.value = saved ?? "";
    path.placeholder = `/opt/homebrew/bin/${harness.command}`;
    dialog.querySelector("#detected-path").textContent = `/opt/homebrew/bin/${harness.command}`;
    dialog.querySelector("#launch-error").textContent = "";
    syncMode();
    mountIcons(dialog);
    dialog.showModal();
    updateQuery("dialog", id);
  }

  for (const mode of modes) mode.addEventListener("change", syncMode);
  for (const button of dialog.querySelectorAll("[data-dismiss]")) {
    button.addEventListener("click", () => dialog.close());
  }
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      dialog.close();
  });
  dialog.addEventListener("close", () => updateQuery("dialog", null));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const custom = form.elements.namedItem("launch-mode").value === "custom";
    const executable = custom ? path.value.trim() : null;
    if (custom && !executable) {
      dialog.querySelector("#launch-error").textContent = "请填写启动程序的完整路径。";
      path.focus();
      return;
    }
    savedPaths.set(activeId, executable);
    dialog.close();
    notify("启动设置已保存在当前原型中。");
  });
  return { open };
}
