import type { HarnessInstallationState } from "@codexhost/shared-contracts";

import type { ExternalRendererAgent } from "../agent-selection-state.js";
import { harnessInstallationGuide } from "./harness-installation-guides.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

/** Owned by one Connections page, reused across diagnostic renders and row switches. */
export function createHarnessVersionPanel(
  document: Document,
  messages: RendererSettingsMessages,
  signal: AbortSignal,
  agent: ExternalRendererAgent,
  client: { run(action: "check" | "update"): Promise<HarnessInstallationState> },
): HTMLElement {
  const panel = document.createElement("section");
  panel.className = "settings-harness-version";
  panel.dataset.harnessVersion = agent;
  const heading = document.createElement("strong");
  heading.textContent = messages.harnessVersionTitle;
  const versions = document.createElement("div");
  versions.className = "settings-harness-version__values";
  const current = document.createElement("span");
  const latest = document.createElement("span");
  versions.append(current, latest);
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const actions = document.createElement("div");
  actions.className = "settings-connection-error-actions";
  const check = document.createElement("button");
  check.type = "button";
  check.className = "settings-command-button settings-command-button--secondary";
  check.dataset.harnessVersionAction = "check";
  check.textContent = messages.harnessVersionCheck;
  const update = document.createElement("button");
  update.type = "button";
  update.className = check.className;
  update.dataset.harnessVersionAction = "update";
  const guide = document.createElement("a");
  guide.className = check.className;
  guide.href = harnessInstallationGuide(agent, messages.locale).url;
  guide.target = "_blank";
  guide.rel = "noopener noreferrer";
  guide.append(
    messages.connectionOpenInstallation,
    createRendererSettingsIcon("external-link", 14),
  );
  const note = document.createElement("p");
  note.className = "settings-connection-issue-note";
  note.textContent = messages.harnessVersionNote;
  actions.append(check, update, guide);
  panel.append(heading, versions, status, actions, note);
  let state: HarnessInstallationState | undefined;
  let busy = false;
  let unsupported = false;
  const render = (): void => {
    current.textContent = `${messages.harnessVersionCurrent}: ${state?.currentVersion ?? "—"}`;
    latest.textContent = `${messages.harnessVersionLatest}: ${state?.latestVersion ?? "—"}`;
    check.disabled = busy || unsupported || signal.aborted;
    update.disabled = busy || signal.aborted || !state?.canUpdate || !state.updateAvailable;
    update.textContent =
      state?.canUpdate && state.latestVersion !== "Unknown" && !state.updateAvailable
        ? messages.harnessVersionUpToDate
        : messages.harnessVersionUpdate;
    note.textContent = state?.message
      ? `${state.message} ${messages.harnessVersionNote}`
      : messages.harnessVersionNote;
  };
  const run = async (action: "check" | "update"): Promise<void> => {
    if (busy || unsupported || signal.aborted) return;
    if (action === "update" && (!state?.canUpdate || !state.updateAvailable)) return;
    busy = true;
    status.textContent =
      action === "check" ? messages.harnessVersionChecking : messages.harnessVersionUpdating;
    render();
    try {
      const result = await client.run(action);
      if (signal.aborted) return;
      state = result;
      status.textContent = !result.canUpdate
        ? messages.harnessVersionManual
        : action === "update"
          ? result.updateAvailable
            ? messages.harnessVersionFailed
            : messages.harnessVersionUpdated
          : "";
    } catch (error) {
      if (signal.aborted) return;
      unsupported =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === -32601 || error.code === -32078);
      status.textContent = unsupported
        ? messages.harnessVersionUnsupported
        : messages.harnessVersionFailed;
      if (state) state = { ...state, canUpdate: false };
    } finally {
      busy = false;
      if (!signal.aborted) render();
    }
  };
  check.addEventListener("click", () => void run("check"));
  update.addEventListener("click", () => void run("update"));
  signal.addEventListener("abort", render, { once: true });
  render();
  void run("check");
  return panel;
}
