import type { HarnessInstallationState } from "@codexhost/shared-contracts";

import type { ExternalRendererAgent } from "../agent-selection-state.js";
import { harnessVersionLabel, harnessVersionNote } from "./harness-version-messages.js";
import type { RendererSettingsMessages } from "./localization.js";

export interface HarnessVersionPanel {
  readonly element: HTMLElement;
  readonly state: HarnessInstallationState | undefined;
  readonly updating: boolean;
  update(): Promise<boolean>;
}

export type HarnessVersionStatusKind =
  "checking" | "updating" | "idle" | "updated" | "failed" | "unsupported";

export interface HarnessVersionSession {
  readonly state: HarnessInstallationState | undefined;
  readonly statusKind: HarnessVersionStatusKind;
  readonly updating: boolean;
  /** Prepares state for a newly mounted panel; returns true when a fresh check should be scheduled. */
  prepareMount(): boolean;
  check(): Promise<void>;
  update(): Promise<boolean>;
  subscribe(listener: (pageChange: boolean) => void): () => void;
}

function isUnsupportedInstallationError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === -32601 || error.code === -32078)
  );
}

export function createHarnessVersionSession(
  client: { run(action: "check" | "update"): Promise<HarnessInstallationState> },
  options?: { readonly signal?: AbortSignal },
): HarnessVersionSession {
  let state: HarnessInstallationState | undefined;
  let statusKind: HarnessVersionStatusKind = "checking";
  let checkPromise: Promise<void> | null = null;
  let updatePromise: Promise<boolean> | null = null;
  const listeners = new Set<(pageChange: boolean) => void>();
  const signal = options?.signal;

  const notify = (pageChange: boolean): void => {
    if (signal?.aborted) return;
    for (const listener of [...listeners]) listener(pageChange);
  };

  const check = (): Promise<void> => {
    if (signal?.aborted || updatePromise) return Promise.resolve();
    if (checkPromise) return checkPromise;
    statusKind = "checking";
    notify(false);
    checkPromise = (async () => {
      try {
        const result = await client.run("check");
        if (signal?.aborted || updatePromise) return;
        state = result;
        statusKind = "idle";
      } catch (error) {
        if (signal?.aborted || updatePromise) return;
        statusKind = isUnsupportedInstallationError(error) ? "unsupported" : "failed";
        if (state) state = { ...state, canUpdate: false };
      } finally {
        checkPromise = null;
        if (!signal?.aborted && !updatePromise) {
          notify(true);
        }
      }
    })();
    return checkPromise;
  };

  const update = (): Promise<boolean> => {
    if (updatePromise) return updatePromise;
    updatePromise = (async () => {
      if (signal?.aborted) return false;
      if (checkPromise) await checkPromise;
      if (
        signal?.aborted ||
        statusKind === "unsupported" ||
        !state?.canUpdate ||
        !state.updateAvailable
      ) {
        return false;
      }
      statusKind = "updating";
      notify(true);
      try {
        const result = await client.run("update");
        if (signal?.aborted) return false;
        state = result;
        statusKind = !result.canUpdate ? "updated" : result.updateAvailable ? "failed" : "updated";
        return result.canUpdate && !result.updateAvailable;
      } catch (error) {
        if (signal?.aborted) return false;
        statusKind = isUnsupportedInstallationError(error) ? "unsupported" : "failed";
        if (state) state = { ...state, canUpdate: false };
        return false;
      } finally {
        updatePromise = null;
        if (!signal?.aborted) {
          notify(true);
        }
      }
    })();
    return updatePromise;
  };

  return {
    get state() {
      return state;
    },
    get statusKind() {
      return statusKind;
    },
    get updating() {
      return statusKind === "updating";
    },
    prepareMount() {
      if (updatePromise || checkPromise) return false;
      statusKind = "checking";
      return true;
    },
    check,
    update,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** View for one Harness CLI version card; may bind to a connection-owned session across mounts. */
export function createHarnessVersionPanel(
  document: Document,
  messages: RendererSettingsMessages,
  signal: AbortSignal,
  agent: ExternalRendererAgent,
  client: { run(action: "check" | "update"): Promise<HarnessInstallationState> },
  onChange: () => void = () => undefined,
  sharedSession?: HarnessVersionSession,
): HarnessVersionPanel {
  const session = sharedSession ?? createHarnessVersionSession(client, { signal });
  const shouldScheduleCheck = session.prepareMount();

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

  const render = (): void => {
    const state = session.state;
    const statusKind = session.statusKind;
    const busy = statusKind === "checking" || statusKind === "updating";
    heading.textContent =
      state?.versionKind === "application"
        ? messages.harnessVersionApplicationTitle
        : messages.harnessVersionTitle;
    current.textContent = `${messages.harnessVersionCurrent}: ${state?.currentVersion ?? "—"}`;
    latest.textContent = `${messages.harnessVersionLatest}: ${harnessVersionLabel(state, messages.harnessVersion)}`;
    status.textContent =
      statusKind === "checking"
        ? messages.harnessVersionChecking
        : statusKind === "updating"
          ? messages.harnessVersionUpdating
          : statusKind === "unsupported"
            ? messages.harnessVersionUnsupported
            : statusKind === "failed"
              ? messages.harnessVersionFailed
              : statusKind === "updated"
                ? !state?.canUpdate
                  ? messages.harnessVersionManual
                  : messages.harnessVersionUpdated
                : state && !state.canUpdate
                  ? messages.harnessVersionManual
                  : "";
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

  update.addEventListener("click", () => {
    if (!signal.aborted) void session.update();
  });

  const unsubscribe = session.subscribe((pageChange) => {
    if (signal.aborted) return;
    render();
    if (pageChange) onChange();
  });

  const owner = document.defaultView;
  let checkFrame: number | null = null;
  let checkTimer: number | null = null;
  signal.addEventListener(
    "abort",
    () => {
      unsubscribe();
      if (checkFrame !== null) owner?.cancelAnimationFrame(checkFrame);
      if (checkTimer !== null) owner?.clearTimeout(checkTimer);
      render();
    },
    { once: true },
  );

  render();

  // Resolving a native Host can synchronously walk React fibers. Let the
  // Connections page paint before doing that work, even when the RPC itself
  // is async. A microtask or work inside the first frame would still block it.
  if (shouldScheduleCheck && !signal.aborted) {
    if (owner?.requestAnimationFrame) {
      checkFrame = owner.requestAnimationFrame(() => {
        checkFrame = null;
        if (signal.aborted) return;
        checkTimer = owner.setTimeout(() => {
          checkTimer = null;
          if (!signal.aborted) void session.check();
        }, 0);
      });
    } else {
      void session.check();
    }
  }

  return {
    element: panel,
    get state() {
      return session.state;
    },
    get updating() {
      return session.updating;
    },
    update: () => (signal.aborted ? Promise.resolve(false) : session.update()),
  };
}
