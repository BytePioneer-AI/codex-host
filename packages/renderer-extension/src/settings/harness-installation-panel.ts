import type { HarnessPluginDescriptor } from "@codexhost/shared-contracts";
import { harnessInstallationGuide } from "./harness-installation-guides.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

/** Installation actions and manual commands; the website link lives in the header. */
export function createHarnessInstallationPanel(
  document: Document,
  plugin: HarnessPluginDescriptor | undefined,
  hostId: string,
  messages: RendererSettingsMessages,
  copy: (button: HTMLButtonElement, command: string, label: string) => void,
  installation?: { run: () => void; status: "idle" | "installing" | "checking" },
): HTMLElement {
  const zh = messages.locale === "zh-CN";
  const guide = harnessInstallationGuide(plugin, messages.locale);
  const panel = document.createElement("div");
  panel.className = "settings-harness-installation";
  const paragraph = (text: string): void => {
    const p = document.createElement("p");
    p.textContent = text;
    panel.append(p);
  };
  if (hostId !== "local") {
    paragraph(zh ? "请在远程 Host 上安装。" : "Install on the remote Host.");
  }
  if (guide.before) paragraph(guide.before);
  const install =
    installation && guide.commands.length > 0 ? document.createElement("button") : null;
  if (install && installation) {
    install.type = "button";
    install.className = "settings-command-button";
    install.dataset.connectionAction = "install";
    install.disabled = installation.status !== "idle";
    install.textContent =
      installation.status === "installing"
        ? messages.connectionStatusInstalling
        : installation.status === "checking"
          ? messages.connectionStatusChecking
          : zh
            ? "一键安装"
            : "Install automatically";
    install.addEventListener("click", () => {
      if (install.disabled) return;
      install.disabled = true;
      install.textContent = messages.connectionStatusInstalling;
      installation.run();
    });
    if (guide.commands.length > 1) panel.append(install);
  }
  for (const { terminal, command } of guide.commands) {
    const block = document.createElement("div");
    block.className = "settings-harness-installation-command";
    const label = document.createElement("strong");
    label.textContent = terminal;
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = command;
    pre.append(code);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-command-button settings-command-button--secondary";
    button.dataset.connectionAction = "copy-install";
    const copyLabel = zh ? "复制命令" : "Copy command";
    button.setAttribute("aria-label", `${copyLabel}: ${terminal}`);
    button.append(createRendererSettingsIcon("copy", 16), copyLabel);
    button.addEventListener("click", () => copy(button, command, copyLabel));
    const actions = document.createElement("div");
    actions.className = "settings-harness-installation-actions";
    if (install && guide.commands.length === 1) actions.append(install);
    actions.append(button);
    block.append(label, pre, actions);
    panel.append(block);
  }
  for (const download of guide.downloads ?? []) {
    const link = document.createElement("a");
    link.className = "settings-command-button settings-command-button--secondary";
    link.href = download.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = zh ? "下载" : "Download";
    link.setAttribute("aria-label", `${link.textContent} ${download.label}`);
    panel.append(link);
  }
  if (guide.after) paragraph(guide.after);
  if (!plugin?.installation && guide.url) {
    const link = document.createElement("a");
    link.href = guide.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = zh ? "安装说明" : "Installation instructions";
    panel.append(link);
  }
  return panel;
}
