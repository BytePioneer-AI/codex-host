import type {
  UpdateCheckResult,
  UpdateInstallation,
  UpdateStartResult,
  UpdateStatus,
  UpdateStatusResult,
} from "@codexhost/shared-contracts";

import {
  readRendererReasoningDisplayPreference,
  setRendererReasoningDisplayPreference,
} from "../renderer-reasoning-preference.js";

import {
  createRendererSettingsPageRegistry,
  type RendererSettingsPageDefinition,
  type RendererSettingsPageMountContext,
  type RendererSettingsPageRegistry,
} from "./core.js";
import { createRendererSettingsIcon } from "./icons.js";
import {
  DEFAULT_RENDERER_SETTINGS_MESSAGES,
  type RendererSettingsMessages,
} from "./localization.js";
import {
  createConnectionsSettingsPage,
  type RendererConnectionDiagnostics,
} from "./connections-page.js";
import { createReleaseNotesElement } from "./release-notes.js";

export type {
  RendererConnectionAgentSnapshot,
  RendererConnectionDiagnostics,
  RendererConnectionHostSnapshot,
  RendererConnectionSnapshot,
} from "./connections-page.js";
import {
  RendererUpdateRequestTimeoutError,
  runBoundedRendererUpdateRequest,
} from "./update-request.js";

export const CODEXHOST_RELEASES_LATEST_URL =
  "https://github.com/BytePioneer-AI/codex-host/releases/latest";
export const CODEXHOST_NPM_MANUAL_UPDATE_COMMAND = "npm install -g @codexhost/cli@latest";

export const DEFAULT_RENDERER_SETTINGS_PAGE_IDS = [
  "connections",
  "model-pool",
  "routes",
  "gateway",
  "updates",
] as const;

export type DefaultRendererSettingsPageId = (typeof DEFAULT_RENDERER_SETTINGS_PAGE_IDS)[number];
type UnavailableRendererSettingsPageId = Exclude<
  DefaultRendererSettingsPageId,
  "connections" | "model-pool" | "updates"
>;

export interface RendererReasoningDisplayPreference {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
}

const DEFAULT_REASONING_DISPLAY_PREFERENCE: RendererReasoningDisplayPreference = Object.freeze({
  isEnabled: () => readRendererReasoningDisplayPreference(),
  setEnabled: (enabled: boolean) => setRendererReasoningDisplayPreference(enabled),
});

export interface RendererUpdateClient {
  checkUpdate(): Promise<UpdateCheckResult>;
  startUpdate(): Promise<UpdateStartResult>;
  readUpdateStatus(): Promise<UpdateStatusResult>;
}

function appendUnavailableStatus(content: HTMLElement, messages: RendererSettingsMessages): void {
  const status = content.ownerDocument.createElement("div");
  status.className = "settings-empty";

  const copy = content.ownerDocument.createElement("div");
  const title = content.ownerDocument.createElement("strong");
  title.textContent = messages.inDevelopment;
  copy.append(title);
  status.append(copy);
  content.append(status);
}

function unavailablePage(
  id: UnavailableRendererSettingsPageId,
  messages: RendererSettingsMessages,
): RendererSettingsPageDefinition {
  return Object.freeze({
    id,
    label: messages.pageLabels[id],
    icon: id,
    mount(context: RendererSettingsPageMountContext) {
      appendUnavailableStatus(context.content, messages);
      return undefined;
    },
  });
}

function modelPoolPage(
  messages: RendererSettingsMessages,
  preference: RendererReasoningDisplayPreference,
): RendererSettingsPageDefinition {
  return Object.freeze({
    id: "model-pool",
    label: messages.pageLabels["model-pool"],
    icon: "model-pool",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const heading = document.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = messages.pageLabels["model-pool"];
      const description = document.createElement("p");
      description.className = "settings-page-description";
      description.textContent = messages.modelPoolDescription;

      const row = document.createElement("div");
      row.className = "settings-preference-row";
      const copy = document.createElement("div");
      copy.className = "settings-preference-row__copy";
      const title = document.createElement("strong");
      title.textContent = messages.reasoningDisplayTitle;
      const detail = document.createElement("span");
      detail.textContent = messages.reasoningDisplayDescription;
      copy.append(title, detail);

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "settings-preference-switch";
      toggle.setAttribute("role", "switch");
      const thumb = document.createElement("span");
      thumb.className = "settings-preference-switch__thumb";
      toggle.append(thumb);
      const render = (enabled: boolean): void => {
        toggle.setAttribute("aria-checked", String(enabled));
        toggle.setAttribute(
          "aria-label",
          `${messages.reasoningDisplayTitle}: ${enabled ? messages.enabled : messages.disabled}`,
        );
        toggle.title = enabled ? messages.enabled : messages.disabled;
      };
      render(preference.isEnabled());
      toggle.addEventListener("click", () => {
        const enabled = toggle.getAttribute("aria-checked") !== "true";
        preference.setEnabled(enabled);
        render(enabled);
      });
      row.append(copy, toggle);
      context.content.append(heading, description, row);
      return undefined;
    },
  });
}

function versionRow(
  context: RendererSettingsPageMountContext,
  label: string,
  version: string,
): HTMLElement {
  const row = context.content.ownerDocument.createElement("div");
  row.className = "settings-update-version-row";
  const name = context.content.ownerDocument.createElement("span");
  name.textContent = label;
  const value = context.content.ownerDocument.createElement("strong");
  value.textContent = `v${version}`;
  row.append(name, value);
  return row;
}

function installationLabel(
  installation: UpdateInstallation | null,
  messages: RendererSettingsMessages,
): string {
  if (installation === "npm") return messages.updateInstallationNpm;
  if (installation === "windows-installer") {
    return messages.updateInstallationWindowsInstaller;
  }
  if (installation === "macos-dmg") return messages.updateInstallationMacOsDmg;
  return messages.updateInstallationUnknown;
}

function isPendingStatus(status: UpdateStatus | null): boolean {
  return status !== null && status.phase !== "succeeded" && status.phase !== "failed";
}

function statusMessage(
  status: UpdateStatus | null,
  messages: RendererSettingsMessages,
): string | null {
  if (!status) return null;
  if (status.phase === "succeeded") return messages.updateSucceeded;
  if (status.phase === "failed") return status.error ?? messages.updateFailed;
  if (status.phase === "waiting-for-exit") return messages.updateWaitingForExit;
  if (status.phase === "installing") {
    return status.installation === "npm" ? messages.updateInstallingNpm : messages.updateInstalling;
  }
  if (status.phase === "restarting") return messages.updateRestarting;
  if (status.phase === "downloading") return messages.updateDownloading;
  return messages.updatePreparing;
}

function formatUpdateBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let scaled = value;
  let unit = "B";
  for (const nextUnit of units) {
    scaled /= 1024;
    unit = nextUnit;
    if (scaled < 1024 || nextUnit === units.at(-1)) break;
  }
  return `${scaled.toFixed(scaled >= 10 ? 0 : 1)} ${unit}`;
}

function updatesPage(
  messages: RendererSettingsMessages,
  getClient: () => RendererUpdateClient | null,
): RendererSettingsPageDefinition {
  return Object.freeze({
    id: "updates",
    label: messages.pageLabels.updates,
    icon: "updates",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const heading = document.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = messages.pageLabels.updates;
      const metadata = document.createElement("div");
      metadata.className = "settings-update-metadata";
      const currentVersion = document.createElement("div");
      currentVersion.className = "settings-update-metadata__item";
      const currentVersionLabel = document.createElement("span");
      currentVersionLabel.textContent = messages.updateCurrentVersion;
      const currentVersionValue = document.createElement("strong");
      currentVersionValue.textContent = "-";
      currentVersion.append(currentVersionLabel, currentVersionValue);
      const installation = document.createElement("div");
      installation.className = "settings-update-metadata__item";
      const installationName = document.createElement("span");
      installationName.textContent = messages.updateInstallation;
      const installationValue = document.createElement("strong");
      installationValue.textContent = "-";
      installation.append(installationName, installationValue);
      metadata.append(currentVersion, installation);
      const panel = document.createElement("section");
      panel.className = "settings-update-panel";
      panel.setAttribute("aria-live", "polite");
      const manualNpm = document.createElement("div");
      manualNpm.className = "settings-update-manual";
      manualNpm.hidden = true;
      const manualNpmDescription = document.createElement("span");
      manualNpmDescription.textContent = messages.updateManualNpmDescription;
      const manualNpmCommand = document.createElement("code");
      manualNpmCommand.textContent = CODEXHOST_NPM_MANUAL_UPDATE_COMMAND;
      manualNpm.append(manualNpmDescription, manualNpmCommand);
      const actions = document.createElement("div");
      actions.className = "settings-update-actions";
      const releaseLink = document.createElement("a");
      releaseLink.className = "settings-update-link";
      releaseLink.href = CODEXHOST_RELEASES_LATEST_URL;
      releaseLink.target = "_blank";
      releaseLink.rel = "noopener noreferrer";
      releaseLink.append(
        messages.updateDownloadFromReleases,
        createRendererSettingsIcon("external-link", 14),
      );
      actions.append(releaseLink);
      context.content.append(heading, metadata, panel, manualNpm, actions);
      let pollTimer: number | undefined;
      let pollAttempts = 0;
      let pending = false;

      const clearPoll = (): void => {
        if (pollTimer !== undefined) {
          document.defaultView?.clearTimeout(pollTimer);
          pollTimer = undefined;
        }
      };

      const renderUnavailable = (detail: string): void => {
        panel.dataset.updateState = "unavailable";
        panel.replaceChildren();
        const title = document.createElement("strong");
        title.textContent = messages.notAvailable;
        const copy = document.createElement("span");
        copy.textContent = detail;
        panel.append(title, copy);
      };

      const renderRequestFailure = (error: unknown): void => {
        renderPendingStatus(
          null,
          error instanceof RendererUpdateRequestTimeoutError
            ? messages.updateRequestTimeout
            : error instanceof Error
              ? error.message
              : messages.updateFailed,
          "failed",
        );
      };

      const scheduleStatusPoll = (client: RendererUpdateClient, resetAttempts = false): void => {
        clearPoll();
        if (resetAttempts) pollAttempts = 0;
        if (pollAttempts >= 320) {
          renderPendingStatus(null, messages.updateRequestTimeout, "failed");
          return;
        }
        pollAttempts += 1;
        pollTimer = document.defaultView?.setTimeout(() => {
          void context.runLatest(
            (signal) => runBoundedRendererUpdateRequest(() => client.readUpdateStatus(), signal),
            {
              success(result) {
                const message = statusMessage(result.status, messages);
                if (isPendingStatus(result.status)) scheduleStatusPoll(client);
                if (message) renderPendingStatus(result.status, message);
              },
              failure(error) {
                renderRequestFailure(error);
              },
            },
          );
        }, 750);
      };

      const renderPendingStatus = (
        status: UpdateStatus | null,
        message: string,
        viewPhase: UpdateStatus["phase"] | "pending" = status?.phase ?? "pending",
      ): void => {
        panel.dataset.updateState = viewPhase;
        panel.replaceChildren();
        const state = document.createElement("strong");
        state.textContent = message;
        panel.append(state);
        if (
          status?.phase === "downloading" &&
          status.totalBytes !== undefined &&
          status.downloadedBytes !== undefined
        ) {
          const progress = document.createElement("progress");
          progress.className = "settings-update-progress";
          progress.max = status.totalBytes;
          progress.value = Math.min(status.downloadedBytes, status.totalBytes);
          progress.setAttribute("aria-label", messages.updateDownloading);
          const detail = document.createElement("span");
          detail.className = "settings-update-progress-detail";
          const percent = Math.min(
            100,
            Math.round((status.downloadedBytes / status.totalBytes) * 1000) / 10,
          );
          detail.textContent = `${percent}% · ${formatUpdateBytes(status.downloadedBytes)} / ${formatUpdateBytes(status.totalBytes)}`;
          panel.append(progress, detail);
        }
        if (viewPhase === "failed") {
          const retry = document.createElement("button");
          retry.type = "button";
          retry.className = "settings-command-button";
          retry.append(createRendererSettingsIcon("refresh", 16), messages.updateRetry);
          retry.addEventListener("click", () => void load());
          panel.append(retry);
        }
      };

      const start = (client: RendererUpdateClient): void => {
        if (pending) return;
        pending = true;
        renderPendingStatus(null, messages.updatePreparing);
        void context.runLatest(
          (signal) => runBoundedRendererUpdateRequest(() => client.startUpdate(), signal),
          {
            success(result) {
              pending = false;
              renderPendingStatus(
                result.status,
                statusMessage(result.status, messages) ?? messages.updatePreparing,
              );
              if (isPendingStatus(result.status)) scheduleStatusPoll(client, true);
            },
            failure(error) {
              pending = false;
              renderRequestFailure(error);
            },
          },
        );
      };

      const renderCheck = (result: UpdateCheckResult, client: RendererUpdateClient): void => {
        currentVersionValue.textContent = `v${result.currentVersion}`;
        installationValue.textContent = installationLabel(result.installation, messages);
        manualNpm.hidden = result.installation !== "npm";
        if (result.releaseNotesUrl) releaseLink.href = result.releaseNotesUrl;
        const operationMessage = statusMessage(result.status, messages);
        if (isPendingStatus(result.status)) {
          renderPendingStatus(result.status, operationMessage ?? messages.updatePreparing);
          scheduleStatusPoll(client, true);
          return;
        }
        panel.dataset.updateState = result.error
          ? "error"
          : result.updateAvailable
            ? "available"
            : "current";
        panel.replaceChildren();
        if (result.latestVersion) {
          panel.append(versionRow(context, messages.updateLatestVersion, result.latestVersion));
        }
        const summary = document.createElement("p");
        summary.className = "settings-update-summary";
        summary.textContent =
          operationMessage ??
          (result.error
            ? messages.updateFailed
            : result.updateAvailable
              ? messages.updateAvailable
              : messages.updateUpToDate);
        panel.append(summary);
        if (result.releaseNotes) {
          panel.append(createReleaseNotesElement(document, result.releaseNotes));
        }
        if (result.status?.phase === "failed" && result.status.error) {
          const error = document.createElement("p");
          error.className = "settings-update-error";
          error.textContent = result.status.error;
          panel.append(error);
        }
        if (result.updateAvailable && result.installationAvailable) {
          const update = document.createElement("button");
          update.type = "button";
          update.className = "settings-command-button";
          update.append(createRendererSettingsIcon("updates", 16), messages.updateAndRestart);
          update.addEventListener("click", () => start(client));
          panel.append(update);
        }
        if (result.error) {
          const error = document.createElement("p");
          error.className = "settings-update-error";
          error.textContent = result.error;
          const retry = document.createElement("button");
          retry.type = "button";
          retry.className = "settings-command-button settings-command-button--secondary";
          retry.append(createRendererSettingsIcon("refresh", 16), messages.updateRetry);
          retry.addEventListener("click", () => void load());
          panel.append(error, retry);
        }
      };

      const load = (): Promise<void> => {
        const client = getClient();
        if (!client) {
          renderUnavailable(messages.runtimeCapabilityNotInstalled);
          return Promise.resolve();
        }
        pending = true;
        renderPendingStatus(null, messages.updateChecking);
        return context.runLatest(
          (signal) => runBoundedRendererUpdateRequest(() => client.checkUpdate(), signal),
          {
            success(result) {
              pending = false;
              renderCheck(result, client);
            },
            failure(error) {
              pending = false;
              renderRequestFailure(error);
            },
          },
        );
      };

      void load();
      return clearPoll;
    },
  });
}

export function createDefaultRendererSettingsPages(
  messages: RendererSettingsMessages = DEFAULT_RENDERER_SETTINGS_MESSAGES,
  getUpdateClient: () => RendererUpdateClient | null = () => null,
  getDiagnostics: () => RendererConnectionDiagnostics | null = () => null,
  reasoningDisplayPreference: RendererReasoningDisplayPreference = DEFAULT_REASONING_DISPLAY_PREFERENCE,
): readonly RendererSettingsPageDefinition[] {
  const unavailableIds = DEFAULT_RENDERER_SETTINGS_PAGE_IDS.filter(
    (id): id is UnavailableRendererSettingsPageId =>
      id !== "updates" && id !== "connections" && id !== "model-pool",
  );
  return Object.freeze([
    createConnectionsSettingsPage(messages, getDiagnostics),
    modelPoolPage(messages, reasoningDisplayPreference),
    ...unavailableIds.map((id) => unavailablePage(id, messages)),
    updatesPage(messages, getUpdateClient),
  ]);
}

export function createDefaultRendererSettingsRegistry(
  messages: RendererSettingsMessages = DEFAULT_RENDERER_SETTINGS_MESSAGES,
  getUpdateClient: () => RendererUpdateClient | null = () => null,
  getDiagnostics: () => RendererConnectionDiagnostics | null = () => null,
  reasoningDisplayPreference: RendererReasoningDisplayPreference = DEFAULT_REASONING_DISPLAY_PREFERENCE,
): RendererSettingsPageRegistry {
  return createRendererSettingsPageRegistry(
    createDefaultRendererSettingsPages(
      messages,
      getUpdateClient,
      getDiagnostics,
      reasoningDisplayPreference,
    ),
  );
}
