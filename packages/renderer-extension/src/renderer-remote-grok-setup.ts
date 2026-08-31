import {
  isRemoteSshHostId,
  sshTargetFromRemoteHostId,
  type RemoteSshOccupancyKind,
} from "@codexhost/shared-contracts";

import type { RendererSettingsLocale } from "./settings/localization.js";

export const REMOTE_GROK_SETUP_ATTRIBUTE = "data-codexhost-remote-grok-setup";

export function remoteGrokNeedsSetup(
  hostId: string | null,
  availability: string | undefined,
): boolean {
  if (!hostId || !isRemoteSshHostId(hostId)) return false;
  return availability !== "ready" && availability !== "checking";
}

export type RemoteGrokSetupVariant =
  "install" | "blocked-official" | "blocked-unknown" | "grok-missing";

export function remoteGrokSetupVariant(
  kind: RemoteSshOccupancyKind | undefined,
): RemoteGrokSetupVariant {
  if (kind === "official-remote-control") return "blocked-official";
  if (kind === "unknown-busy") return "blocked-unknown";
  if (kind === "grok-missing") return "grok-missing";
  return "install";
}

const DEFAULT_REMOTE_AGENT_LABEL = "Grok";

interface RemoteGrokSetupCopy {
  title: string;
  body: (sshTarget: string) => string;
  confirm: string | null;
  replace: string | null;
  decline: string;
  installing: string;
  doneTitle: string;
  doneBody: string;
  acknowledge: string;
  failedTitle: string;
  close: string;
}

const COPY: Record<RendererSettingsLocale, Record<RemoteGrokSetupVariant, RemoteGrokSetupCopy>> = {
  "zh-CN": {
    install: {
      title: "要在服务器上安装远程 Grok 吗？",
      body: (sshTarget) =>
        `要用 Grok 连这台远程机器，需要在 ${sshTarget} 上安装 CodexHost 总入口。\n选 Codex 和选 Grok 都还在同一个远程项目里。失败会自动回滚，不会留下半截安装。`,
      confirm: "是",
      replace: null,
      decline: "否",
      installing: "正在服务器上安装…",
      doneTitle: "安装完成",
      doneBody: "请重新打开这个远程项目，然后再选 Grok。",
      acknowledge: "确定",
      failedTitle: "安装失败",
      close: "关闭",
    },
    "blocked-official": {
      title: "需要你的允许才能建立 {agent} 的远程连接",
      body: (sshTarget) =>
        `目前 ${sshTarget} 上面已经运行着 Codex SSH daemon，所以我们连不进去。\n想要同时让 {agent} 和 Codex 都能在本 App 上连接到 SSH，必须允许我停止目前的 Codex SSH daemon，换成 CodexHost 总入口。这个入口会自动路由 {agent} 和 Codex 通过本 App 连接到 SSH 的连接。安装完成后，会替您把这条 SSH 连接的 Codex SSH daemon 重新建立起来。\n如果本次操作失败会自动回滚，请勿担心。若允许，请点击“停掉官方入口并安装”。`,
      confirm: null,
      replace: "停掉官方入口并安装",
      decline: "关闭",
      installing: "正在替换官方入口…",
      doneTitle: "安装完成",
      doneBody: "请重新打开这个远程项目，然后再选 Grok。",
      acknowledge: "确定",
      failedTitle: "安装失败，已回滚",
      close: "关闭",
    },
    "blocked-unknown": {
      title: "这台服务器现在不能自动安装",
      body: (sshTarget) =>
        `${sshTarget} 上默认 socket 已被未知进程占用。\n这次不会改服务器，以免再次弄坏 Desktop SSH。`,
      confirm: null,
      replace: null,
      decline: "关闭",
      installing: "正在服务器上安装…",
      doneTitle: "安装完成",
      doneBody: "请重新打开这个远程项目，然后再选 Grok。",
      acknowledge: "确定",
      failedTitle: "安装失败",
      close: "关闭",
    },
    "grok-missing": {
      title: "服务器上还没有 Grok",
      body: (sshTarget) =>
        `请先在 ${sshTarget} 上安装并登录 Grok CLI，然后再试。这次没有改服务器。`,
      confirm: null,
      replace: null,
      decline: "关闭",
      installing: "正在服务器上安装…",
      doneTitle: "安装完成",
      doneBody: "请重新打开这个远程项目，然后再选 Grok。",
      acknowledge: "确定",
      failedTitle: "安装失败",
      close: "关闭",
    },
  },
  en: {
    install: {
      title: "Install remote Grok on the server?",
      body: (sshTarget) =>
        `Using Grok on this remote project requires installing the CodexHost door on ${sshTarget}.\nCodex and Grok stay in the same remote project. Failure rolls back instead of leaving a half install.`,
      confirm: "Yes",
      replace: null,
      decline: "No",
      installing: "Installing on the server…",
      doneTitle: "Install complete",
      doneBody: "Reopen this remote project, then select Grok.",
      acknowledge: "OK",
      failedTitle: "Install failed",
      close: "Close",
    },
    "blocked-official": {
      title: "Need your permission to set up a remote {agent} connection",
      body: (sshTarget) =>
        `${sshTarget} already has a Codex SSH daemon running, so we cannot attach {agent} to that door.\nTo let both {agent} and Codex use SSH in this app, allow stopping that Codex SSH daemon and installing the CodexHost door. CodexHost will route {agent} and Codex through this app onto the same SSH connection. After install, the SSH listener for this connection is started again.\nIf this fails, the change is rolled back. Click “Stop official door and install” to allow it.`,
      confirm: null,
      replace: "Stop official door and install",
      decline: "Close",
      installing: "Replacing the official door…",
      doneTitle: "Install complete",
      doneBody: "Reopen this remote project, then select Grok.",
      acknowledge: "OK",
      failedTitle: "Install failed and was rolled back",
      close: "Close",
    },
    "blocked-unknown": {
      title: "Automatic install is blocked on this server",
      body: (sshTarget) =>
        `An unknown process already owns the default Codex socket on ${sshTarget}.\nNothing was changed, so Desktop SSH is left alone.`,
      confirm: null,
      replace: null,
      decline: "Close",
      installing: "Installing on the server…",
      doneTitle: "Install complete",
      doneBody: "Reopen this remote project, then select Grok.",
      acknowledge: "OK",
      failedTitle: "Install failed",
      close: "Close",
    },
    "grok-missing": {
      title: "Grok is not installed on the server",
      body: (sshTarget) =>
        `Install and sign in to Grok CLI on ${sshTarget} first. Nothing was changed on the server.`,
      confirm: null,
      replace: null,
      decline: "Close",
      installing: "Installing on the server…",
      doneTitle: "Install complete",
      doneBody: "Reopen this remote project, then select Grok.",
      acknowledge: "OK",
      failedTitle: "Install failed",
      close: "Close",
    },
  },
};

export interface RemoteGrokSetupDialog {
  readonly root: HTMLElement;
  setLog(text: string): void;
  appendLog(chunk: string): void;
  setFailed(message: string): void;
  setDone(message: string): void;
  close(): void;
}

export function resolveRemoteGrokSetupCopy(
  variant: RemoteGrokSetupVariant,
  sshTarget: string,
  agentLabel = DEFAULT_REMOTE_AGENT_LABEL,
): { title: string; body: string } {
  const copy = COPY["zh-CN"][variant];
  const agent = agentLabel.trim() || DEFAULT_REMOTE_AGENT_LABEL;
  return {
    title: copy.title.replaceAll("{agent}", agent),
    body: copy.body(sshTarget).replaceAll("{agent}", agent),
  };
}

export function openRemoteGrokSetupDialog(input: {
  hostId: string;
  locale: RendererSettingsLocale;
  variant?: RemoteGrokSetupVariant;
  agentLabel?: string;
  onConfirm(): void;
  onReplace?(): void;
  onDecline(): void;
  onAcknowledge(): void;
  ownerDocument?: Document;
}): RemoteGrokSetupDialog {
  const ownerDocument = input.ownerDocument ?? document;
  const variant = input.variant ?? "install";
  const copy = COPY["zh-CN"][variant];
  const sshTarget = sshTargetFromRemoteHostId(input.hostId) ?? input.hostId;
  const prompt = resolveRemoteGrokSetupCopy(variant, sshTarget, input.agentLabel);
  const existing = ownerDocument.querySelector(`[${REMOTE_GROK_SETUP_ATTRIBUTE}]`);
  existing?.remove();

  const root = ownerDocument.createElement("div");
  root.setAttribute(REMOTE_GROK_SETUP_ATTRIBUTE, "v1");
  root.style.position = "fixed";
  root.style.inset = "0";
  root.style.zIndex = "2147483646";
  root.style.display = "flex";
  root.style.alignItems = "center";
  root.style.justifyContent = "center";
  root.style.background = "rgba(0, 0, 0, 0.52)";
  root.style.fontFamily = '"PingFang SC", "Pingfang SC", system-ui, sans-serif';

  const panel = ownerDocument.createElement("div");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.style.width = "min(720px, calc(100vw - 32px))";
  panel.style.maxHeight = "min(80vh, calc(100vh - 32px))";
  panel.style.display = "flex";
  panel.style.flexDirection = "column";
  panel.style.gap = "12px";
  panel.style.padding = "20px";
  panel.style.overflow = "hidden";
  panel.style.minHeight = "0";
  panel.style.borderRadius = "12px";
  panel.style.background = "#181818";
  panel.style.color = "#f5f5f5";
  panel.style.border = "1px solid rgb(255 255 255 / 10%)";
  panel.style.boxShadow = "0 24px 64px rgb(0 0 0 / 38%)";
  panel.style.position = "relative";

  const header = ownerDocument.createElement("div");
  header.style.display = "flex";
  header.style.alignItems = "flex-start";
  header.style.justifyContent = "space-between";
  header.style.gap = "12px";
  header.style.flex = "none";

  const title = ownerDocument.createElement("h2");
  title.textContent = prompt.title;
  title.style.margin = "0";
  title.style.flex = "1 1 auto";
  title.style.font = '600 16px/1.4 "PingFang SC", "Pingfang SC", system-ui, sans-serif';

  const dismiss = ownerDocument.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "×";
  dismiss.setAttribute("aria-label", copy.close);
  dismiss.style.width = "28px";
  dismiss.style.height = "28px";
  dismiss.style.flex = "none";
  dismiss.style.border = "0";
  dismiss.style.borderRadius = "8px";
  dismiss.style.background = "transparent";
  dismiss.style.color = "#f5f5f5";
  dismiss.style.cursor = "pointer";
  dismiss.style.font = "600 20px/1 system-ui, sans-serif";
  header.append(title, dismiss);

  const body = ownerDocument.createElement("p");
  body.textContent = prompt.body;
  body.style.margin = "0";
  body.style.flex = "none";
  body.style.maxHeight =
    variant === "blocked-official" ? "20em" : variant === "install" ? "8em" : "12em";
  body.style.overflow = "auto";
  body.style.whiteSpace = "pre-wrap";
  body.style.color = "#cfcfcf";
  body.style.font = '14px/1.6 "PingFang SC", "Pingfang SC", system-ui, sans-serif';

  const log = ownerDocument.createElement("pre");
  log.hidden = true;
  log.style.margin = "0";
  log.style.flex = "1 1 auto";
  log.style.minHeight = "160px";
  log.style.maxHeight = "none";
  log.style.overflow = "auto";
  log.style.padding = "12px";
  log.style.borderRadius = "8px";
  log.style.background = "#111";
  log.style.color = "#d7ffb3";
  log.style.font = "12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace";
  log.style.whiteSpace = "pre-wrap";
  log.style.overflowWrap = "anywhere";

  const actions = ownerDocument.createElement("div");
  actions.style.display = "flex";
  actions.style.justifyContent = "flex-end";
  actions.style.gap = "8px";
  actions.style.flex = "none";

  const makeButton = (label: string, primary: boolean): HTMLButtonElement => {
    const button = ownerDocument.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.style.minWidth = "72px";
    button.style.height = "32px";
    button.style.padding = "0 12px";
    button.style.border = "0";
    button.style.borderRadius = "8px";
    button.style.cursor = "pointer";
    button.style.font = '500 13px/1 "PingFang SC", "Pingfang SC", system-ui, sans-serif';
    button.style.background = primary ? "#339cff" : "rgb(255 255 255 / 10%)";
    button.style.color = primary ? "#fff" : "#f5f5f5";
    return button;
  };

  const decline = makeButton(copy.decline, copy.confirm === null && copy.replace === null);
  const confirm = copy.confirm ? makeButton(copy.confirm, true) : null;
  const replace = copy.replace ? makeButton(copy.replace, true) : null;
  if (replace) actions.append(replace);
  actions.append(decline);
  if (confirm) actions.append(confirm);

  let phase: "prompt" | "running" | "done" = "prompt";
  const closeDialog = (): void => {
    root.remove();
    if (phase === "prompt") input.onDecline();
    else input.onAcknowledge();
  };

  const beginInstall = (start: () => void): void => {
    phase = "running";
    title.textContent = copy.installing;
    confirm?.remove();
    replace?.remove();
    decline.remove();
    log.hidden = false;
    start();
  };

  confirm?.addEventListener("click", () => beginInstall(input.onConfirm));
  replace?.addEventListener("click", () => beginInstall(input.onReplace ?? input.onConfirm));
  decline.addEventListener("click", closeDialog);
  dismiss.addEventListener("click", closeDialog);

  panel.append(header, body, log, actions);
  root.append(panel);
  ownerDocument.body.append(root);

  const dialog: RemoteGrokSetupDialog = {
    root,
    setLog(text) {
      log.hidden = false;
      log.textContent = text;
      log.scrollTop = log.scrollHeight;
    },
    appendLog(chunk) {
      log.hidden = false;
      log.textContent += chunk;
      log.scrollTop = log.scrollHeight;
    },
    setFailed(message) {
      phase = "done";
      title.textContent = copy.failedTitle;
      const [summary] = message.split("\n");
      body.textContent = summary || message;
      log.hidden = false;
      if (!log.textContent) {
        log.textContent = message;
        log.scrollTop = log.scrollHeight;
      }
      actions.replaceChildren();
      const close = makeButton(copy.close, true);
      close.addEventListener("click", closeDialog);
      actions.append(close);
    },
    setDone(message) {
      phase = "done";
      title.textContent = copy.doneTitle;
      body.textContent = message || copy.doneBody;
      actions.replaceChildren();
      const acknowledge = makeButton(copy.acknowledge, true);
      acknowledge.addEventListener("click", closeDialog);
      actions.append(acknowledge);
    },
    close() {
      root.remove();
    },
  };
  return dialog;
}
