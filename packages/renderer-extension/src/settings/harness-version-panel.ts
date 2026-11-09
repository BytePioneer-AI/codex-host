import type { HarnessInstallationState } from "@codexhost/shared-contracts";

import type { ExternalRendererAgent } from "../agent-selection-state.js";
import type { RendererSettingsMessages } from "./localization.js";
import { harnessVersionLabel, harnessVersionNote } from "./harness-version-messages.js";

export interface HarnessVersionPanel {
  readonly element: HTMLElement;
  readonly state: HarnessInstallationState | undefined;
  readonly updating: boolean;
  update(): Promise<boolean>;
}

/** Owned by one Connections page, reused across diagnostic renders and row switches. */
export function createHarnessVersionPanel(
  document: Document,
  messages: RendererSettingsMessages,
  signal: AbortSignal,
  agent: ExternalRendererAgent,
  client: { run(action: "check" | "update"): Promise<HarnessInstallationState> },
  onChange: () => void = () => undefined,
): HarnessVersionPanel {
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
  const update = document.createElement("button");
  update.type = "button";
  update.className = "settings-command-button settings-command-button--secondary";
  update.dataset.harnessVersionAction = "update";
  const note = document.createElement("p");
  note.className = "settings-connection-issue-note";
  note.textContent = messages.harnessVersionNote;
  actions.append(update);
  panel.append(heading, versions, status, actions, note);
  let state: HarnessInstallationState | undefined;
  let busy = false;
  let updating = false;
  let unsupported = false;
  let updatePromise: Promise<boolean> | null = null;
  const render = (): void => {
    heading.textContent =
      state?.versionKind === "application"
        ? messages.harnessVersionApplicationTitle
        : messages.harnessVersionTitle;
    current.textContent = `${messages.harnessVersionCurrent}: ${state?.currentVersion ?? "—"}`;
    latest.textContent = `${messages.harnessVersionLatest}: ${harnessVersionLabel(state, messages.harnessVersion)}`;
    update.disabled = busy || signal.aborted || !state?.canUpdate || !state.updateAvailable;
    const manualUrl =
      !state?.canUpdate && state?.updateAvailable ? state.manualUpdateUrl : undefined;
    actions.replaceChildren(update);
    update.hidden = !busy && !signal.aborted && Boolean(manualUrl);
    if (update.hidden && manualUrl) {
      const download = document.createElement("a");
      download.className = "settings-command-button settings-command-button--secondary";
      download.dataset.harnessVersionAction = "download-update";
      download.textContent = messages.harnessVersionDownloadUpdate;
      download.href = manualUrl;
      download.target = "_blank";
      download.rel = "noopener noreferrer";
      actions.append(download);
    }
    update.textContent =
      state?.canUpdate && state.latestVersion !== "Unknown" && !state.updateAvailable
        ? messages.harnessVersionUpToDate
        : messages.harnessVersionUpdate;
    const detail = harnessVersionNote(state, messages.harnessVersion);
    note.textContent = detail
      ? !state?.canUpdate
        ? detail
        : `${detail} ${messages.harnessVersionNote}`
      : messages.harnessVersionNote;
  };
  const run = async (action: "check" | "update"): Promise<boolean> => {
    if (busy || unsupported || signal.aborted) return false;
    if (action === "update" && (!state?.canUpdate || !state.updateAvailable)) return false;
    busy = true;
    updating = action === "update";
    onChange();
    status.textContent =
      action === "check" ? messages.harnessVersionChecking : messages.harnessVersionUpdating;
    render();
    try {
      const result = await client.run(action);
      if (signal.aborted) return false;
      state = result;
      status.textContent = !result.canUpdate
        ? messages.harnessVersionManual
        : action === "update"
          ? result.updateAvailable
            ? messages.harnessVersionFailed
            : messages.harnessVersionUpdated
          : "";
      return result.canUpdate && !result.updateAvailable;
    } catch (error) {
      if (signal.aborted) return false;
      unsupported =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === -32601 || error.code === -32078);
      status.textContent = unsupported
        ? messages.harnessVersionUnsupported
        : messages.harnessVersionFailed;
      if (state) state = { ...state, canUpdate: false };
      return false;
    } finally {
      busy = false;
      updating = false;
      if (!signal.aborted) {
        render();
        onChange();
      }
    }
  };
  const updateVersion = (): Promise<boolean> => {
    updatePromise ??= run("update").finally(() => {
      updatePromise = null;
    });
    return updatePromise;
  };
  update.addEventListener("click", () => void updateVersion());
  const owner = document.defaultView;
  let checkFrame: number | null = null;
  let checkTimer: number | null = null;
  signal.addEventListener(
    "abort",
    () => {
      if (checkFrame !== null) owner?.cancelAnimationFrame(checkFrame);
      if (checkTimer !== null) owner?.clearTimeout(checkTimer);
      render();
    },
    { once: true },
  );
  status.textContent = messages.harnessVersionChecking;
  render();
  // Resolving a native Host can synchronously walk React fibers. Let the
  // Connections page paint before doing that work, even when the RPC itself
  // is async. A microtask or work inside the first frame would still block it.
  if (!signal.aborted && owner?.requestAnimationFrame) {
    checkFrame = owner.requestAnimationFrame(() => {
      checkFrame = null;
      if (signal.aborted) return;
      checkTimer = owner.setTimeout(() => {
        checkTimer = null;
        void run("check");
      }, 0);
    });
  } else {
    void run("check");
  }
  return {
    element: panel,
    get state() {
      return state;
    },
    get updating() {
      return updating;
    },
    update: updateVersion,
  };
}
