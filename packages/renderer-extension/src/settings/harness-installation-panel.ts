import type { ExternalRendererAgent } from "../agent-selection-state.js";
import { harnessInstallationGuide } from "./harness-installation-guides.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

export function createHarnessInstallationPanel(
  document: Document,
  agent: ExternalRendererAgent,
  hostId: string,
  messages: RendererSettingsMessages,
  copy: (button: HTMLButtonElement, command: string, label: string) => void,
  refresh: () => void,
): HTMLElement {
  const zh = messages.locale === "zh-CN";
  const guide = harnessInstallationGuide(agent, messages.locale);
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
    block.append(label, pre, button);
    panel.append(block);
  }
  const link = (url: string, label: string): void => {
    const anchor = document.createElement("a");
    anchor.className = "settings-command-button settings-command-button--secondary";
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.append(label, createRendererSettingsIcon("external-link", 14));
    panel.append(anchor);
  };
  for (const download of guide.downloads ?? []) {
    link(
      download.url,
      `${download.label} · ${zh ? "下载与安装指南" : "Download and installation guide"}`,
    );
  }
  paragraph(guide.after);

  const check = document.createElement("button");
  check.type = "button";
  check.className = "settings-command-button";
  check.dataset.connectionAction = "check-install";
  check.textContent = zh ? "重新检测" : "Check again";
  check.addEventListener("click", () => {
    check.disabled = true;
    check.textContent = messages.connectionRefreshing;
    refresh();
  });
  panel.append(check);
  link(guide.url, zh ? "查看官方安装说明" : "View official installation instructions");
  return panel;
}
