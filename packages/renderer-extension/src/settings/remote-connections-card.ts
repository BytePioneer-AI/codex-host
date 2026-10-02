import type { RuntimeStatus } from "@codexhost/shared-contracts";
import type { CodexSshConnection } from "../codex-ssh-adapter.js";
import { remoteUpdateTarget } from "../remote-connections-control.js";
import { createRendererSettingsIcon } from "./icons.js";
import { localizeRemoteFailure } from "./remote-failure-messages.js";

export type RemoteText = (cn: string, en: string) => string;
export type RemoteTone = "neutral" | "progress" | "success" | "warning" | "danger";
export type RemoteCardAction =
  | "toggle"
  | "reconnect"
  | "edit"
  | "remove"
  | "install"
  | "update"
  | "upgrade"
  | "repair"
  | "recheck";

export interface RemoteConnectionRow {
  connection: CodexSshConnection;
  /** True until the first probe of this host has answered. */
  probing: boolean;
  state: string | null;
  stateError: string | null;
  remote: RuntimeStatus | null;
  /** Why a connected host did not report its version. */
  remoteIssue: { outdated: boolean; message: string } | null;
  installation: "installed" | "not-installed" | "unknown" | null;
  /** Label of the action currently running against this host. */
  pending: string | null;
  notice: { tone: "success" | "danger"; text: string } | null;
}

const STABLE_VERSION = /^\d+\.\d+\.\d+$/u;

export function remoteErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/** A connected service that rejects the status method predates version management. */
export function remoteVersionIssue(error: unknown): { outdated: boolean; message: string } {
  const outdated =
    typeof error === "object" && error !== null && "code" in error && error.code === -32601;
  return { outdated, message: remoteErrorMessage(error) };
}

export function remoteElement<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text) result.textContent = text;
  return result;
}

/** Version the local Host can install on a remote that has no service yet. */
export function remoteInstallVersion(local: RuntimeStatus | null): string | null {
  const version = local?.runningVersion;
  return version && STABLE_VERSION.test(version) ? version : null;
}

/** Version an update or restart would bring the remote service to, if either applies. */
export function remoteMaintenanceTarget(
  local: RuntimeStatus | null,
  remote: RuntimeStatus,
): string | null {
  if (!remote.updateSupported) return null;
  return (
    newerLocalVersion(local, remote) ?? (remote.restartRequired ? remote.installedVersion : null)
  );
}

function newerLocalVersion(local: RuntimeStatus | null, remote: RuntimeStatus): string | null {
  return remoteUpdateTarget(local, { ...remote, update: { ...remote.update, phase: "idle" } });
}

export function remoteBusy(remote: RuntimeStatus | null): boolean {
  return !!remote && ["installing", "restarting"].includes(remote.update.phase);
}

/** Troubleshooting actions stay out of the way while the service is healthy or deliberately idle. */
function remoteTroubled(row: RemoteConnectionRow): boolean {
  if (row.remote) return row.remote.update.phase === "failed";
  if (row.state === "connecting") return false;
  return !(row.state === "disconnected" && !row.connection.autoConnect);
}

function connectionState(row: RemoteConnectionRow, t: RemoteText): [RemoteTone, string] {
  switch (row.state) {
    case null:
      return ["progress", t("检测中…", "Checking…")];
    case "connected":
      return ["success", t("已连接", "Connected")];
    case "connecting":
      return ["progress", t("连接中…", "Connecting…")];
    case "disconnected":
      return ["neutral", t("未连接", "Disconnected")];
    case "error":
      return ["danger", t("连接失败", "Connection failed")];
    default:
      return ["neutral", t("状态未知", "Unknown state")];
  }
}

function serviceSummary(
  row: RemoteConnectionRow,
  local: RuntimeStatus | null,
  t: RemoteText,
): { title: string; hints: [RemoteTone, string][] } {
  const { remote } = row;
  const hints: [RemoteTone, string][] = [];
  if (!remote) {
    if (row.probing) return { title: t("正在检测远程服务…", "Checking remote service…"), hints };
    if (row.installation === "not-installed") {
      const version = remoteInstallVersion(local);
      hints.push(
        version
          ? [
              "neutral",
              t(
                `将安装与本机相同的版本 ${version}`,
                `Installs version ${version}, matching this computer`,
              ),
            ]
          : [
              "warning",
              t(
                "本机版本不可用于安装，请使用正式发布版本。",
                "Install from a published local release.",
              ),
            ],
      );
      return { title: t("需要安装远程服务", "Remote service needs installation"), hints };
    }
    if (row.remoteIssue?.outdated) {
      const version = remoteInstallVersion(local);
      hints.push(
        version
          ? [
              "neutral",
              t(
                `更新到本机版本 ${version} 后可在这里查看和管理版本。`,
                `Update to this computer's version ${version} to manage versions here.`,
              ),
            ]
          : [
              "warning",
              t(
                "本机不是正式发布版本，无法从这里更新；请在远程电脑上手动更新 codexhost。",
                "This computer is not running a published release, so it cannot update the remote. Update codexhost on the remote computer manually.",
              ),
            ],
      );
      // Reached when the connection is not answered by a manageable service: an old version, or
      // a damaged installation that lets SSH sessions fall through to stock Codex. Updating
      // reinstalls the service, which fixes both.
      return { title: t("远程服务需要更新", "Remote service needs an update"), hints };
    }
    hints.push([
      "neutral",
      row.state === "connecting" || (row.state === "disconnected" && !row.connection.autoConnect)
        ? t("连接后显示远程服务版本。", "Connect to see the remote service version.")
        : t(
            "暂时无法读取远程版本，可刷新或重新连接后再试。",
            "Remote version information is temporarily unavailable. Refresh or reconnect to retry.",
          ),
    ]);
    if (row.remoteIssue)
      hints.push([
        "danger",
        `${t("原因", "Reason")}: ${localizeRemoteFailure(row.remoteIssue.message, t)}`,
      ]);
    return { title: t("远程服务", "Remote service"), hints };
  }

  const busy = remoteBusy(remote);
  // npm replaces the files mid-update, so the installed version is briefly unreadable and then
  // ahead of the running one. Keep showing the running version until the update settles.
  const installed =
    (busy ? remote.runningVersion : remote.installedVersion) ?? remote.runningVersion ?? "—";
  const title =
    !busy && remote.runningVersion && remote.runningVersion !== remote.installedVersion
      ? t(
          `远程服务 ${installed} · 运行中 ${remote.runningVersion}`,
          `Remote service ${installed} · running ${remote.runningVersion}`,
        )
      : t(`远程服务 ${installed}`, `Remote service ${installed}`);
  const phases: Record<RuntimeStatus["update"]["phase"], [RemoteTone, string] | null> = {
    idle: null,
    installing: ["progress", t("正在更新远程服务…", "Updating remote service…")],
    restarting: ["progress", t("正在重启，请稍候重连…", "Restarting; reconnecting shortly…")],
    // The record outlives the update; the version line already shows the result.
    succeeded: null,
    failed: ["danger", t("更新失败，可以重试", "Update failed; you can retry")],
  };
  const phase = phases[remote.update.phase];
  if (phase) hints.push(phase);
  if (remote.update.error) hints.push(["danger", localizeRemoteFailure(remote.update.error, t)]);
  if (remote.restartRequired && !busy)
    hints.push([
      "warning",
      t("需要重启以使用已安装的版本", "Restart needed to use the installed version"),
    ]);
  const newer = newerLocalVersion(local, remote);
  const localVersion = local?.runningVersion;
  if (remoteBusy(remote)) {
    // The running update already says what is happening.
  } else if (newer && remote.installedVersion !== localVersion)
    hints.push([
      "warning",
      t(`有更新可用 · 本机为 ${newer}`, `Update available · this computer runs ${newer}`),
    ]);
  else if (localVersion && remote.installedVersion === localVersion && !remote.restartRequired)
    hints.push(["success", t("与本机版本一致", "Matches this computer")]);
  if (localVersion && remote.installedVersion && localVersion !== remote.installedVersion && !newer)
    hints.push([
      "warning",
      t(
        "版本不同，请先检查本机更新；不会自动降低远程版本。",
        "Versions differ. Check for a local update; the remote version will not be downgraded.",
      ),
    ]);
  return { title, hints };
}

export function renderRemoteCard(
  document: Document,
  row: RemoteConnectionRow,
  local: RuntimeStatus | null,
  t: RemoteText,
  onAction: (action: RemoteCardAction) => void,
): HTMLElement {
  const { connection, remote } = row;
  const locked = row.pending !== null;
  const command = (action: RemoteCardAction, label: string, primary = false): HTMLButtonElement => {
    const button = remoteElement(
      document,
      "button",
      primary
        ? "settings-command-button"
        : "settings-command-button settings-command-button--secondary",
      label,
    );
    button.type = "button";
    button.dataset.action = action;
    button.disabled = locked;
    button.addEventListener("click", () => onAction(action));
    return button;
  };

  const card = remoteElement(document, "section", "settings-remote-card");
  card.dataset.hostId = connection.hostId;
  card.setAttribute("aria-label", connection.displayName);
  card.setAttribute("aria-busy", String(locked));

  const head = remoteElement(document, "div", "settings-remote-card__head");
  const identity = remoteElement(document, "div", "settings-remote-card__identity");
  const titleLine = remoteElement(document, "div", "settings-remote-card__title");
  const [tone, stateLabel] = connectionState(row, t);
  const state = remoteElement(document, "span", "settings-remote-card__state", stateLabel);
  state.dataset.tone = tone;
  titleLine.append(remoteElement(document, "h3", "", connection.displayName), state);
  const address = `${connection.sshAlias ?? connection.sshHost}${connection.sshPort ? `:${connection.sshPort}` : ""}`;
  const addressLine = remoteElement(document, "div", "settings-remote-card__address", address);
  addressLine.title = address;
  if (connection.source === "discovered")
    addressLine.append(
      remoteElement(document, "span", "settings-status-badge", t("SSH 配置", "SSH config")),
    );
  identity.append(titleLine, addressLine);

  const headActions = remoteElement(document, "div", "settings-remote-card__actions");
  if (row.installation !== "not-installed" && !row.probing) {
    // A failed connection keeps auto-connect on, so offer the retry next to turning it off.
    if (row.state === "error" && connection.autoConnect)
      headActions.append(command("reconnect", t("重新连接", "Reconnect")));
    headActions.append(
      command("toggle", connection.autoConnect ? t("断开", "Disconnect") : t("连接", "Connect")),
    );
  }
  headActions.append(command("edit", t("编辑", "Edit")));
  const remove = remoteElement(
    document,
    "button",
    "settings-icon-button settings-remote-card__remove",
  );
  remove.type = "button";
  remove.dataset.action = "remove";
  remove.disabled = locked;
  remove.title = t("移除", "Remove");
  remove.setAttribute("aria-label", t("移除", "Remove"));
  remove.append(createRendererSettingsIcon("trash", 15));
  remove.addEventListener("click", () => onAction("remove"));
  headActions.append(remove);
  head.append(identity, headActions);
  card.append(head);

  if (row.stateError) {
    const detail = remoteElement(
      document,
      "p",
      "settings-remote-card__detail",
      localizeRemoteFailure(row.stateError, t),
    );
    detail.dataset.tone = "danger";
    card.append(detail);
  }

  const service = remoteElement(document, "div", "settings-remote-card__service");
  const copy = remoteElement(document, "div", "settings-remote-card__service-copy");
  const hint = (hintTone: RemoteTone, text: string, live = false): HTMLElement => {
    const line = remoteElement(document, "p", "settings-remote-card__hint");
    line.dataset.tone = hintTone;
    if (hintTone === "progress")
      line.append(remoteElement(document, "span", "settings-remote-spinner"));
    line.append(text);
    if (live) line.setAttribute("role", hintTone === "danger" ? "alert" : "status");
    return line;
  };
  const summary = serviceSummary(row, local, t);
  copy.append(remoteElement(document, "div", "settings-remote-card__service-title", summary.title));
  if (row.pending) copy.append(hint("progress", row.pending, true));
  else {
    for (const [hintTone, text] of summary.hints) copy.append(hint(hintTone, text));
    if (row.notice)
      copy.append(hint(row.notice.tone, localizeRemoteFailure(row.notice.text, t), true));
  }

  const serviceActions = remoteElement(document, "div", "settings-remote-card__actions");
  if (!row.probing) {
    // Secondary actions first, so the one recommended action always sits at the edge.
    // Without an installed service the connection reaches stock Codex, which also rejects the
    // version query; that is a missing installation, not an outdated one.
    const outdated = !remote && !!row.remoteIssue?.outdated && row.installation !== "not-installed";
    if (outdated) {
      // Repairing or rechecking cannot help a service that predates version management.
      const upgrade = command("upgrade", t("更新远程服务", "Update remote service"), true);
      upgrade.disabled ||= !remoteInstallVersion(local);
      serviceActions.append(upgrade);
    } else if (remoteTroubled(row)) {
      if (row.installation !== "not-installed") {
        const repair = command("repair", t("修复远程服务", "Repair remote service"));
        repair.title = t(
          "停止并重新配置远程服务，不会更新版本。",
          "Stops and reconfigures the remote service. It does not change the version.",
        );
        serviceActions.append(repair);
      }
      if (!remote) serviceActions.append(command("recheck", t("重新检测", "Check again")));
    }
    const target = remote ? remoteMaintenanceTarget(local, remote) : null;
    if (row.installation === "not-installed") {
      const install = command("install", t("安装并连接", "Install and connect"), true);
      install.disabled ||= !remoteInstallVersion(local);
      serviceActions.append(install);
    } else if (remote && target && !remoteBusy(remote)) {
      const update = command(
        "update",
        target === remote.installedVersion
          ? t("重启并连接", "Restart and connect")
          : t("更新到本机版本", "Match local version"),
        true,
      );
      serviceActions.append(update);
    }
  }
  service.append(copy, serviceActions);
  card.append(service);
  return card;
}
