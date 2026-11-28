import type { MacOsLocalSigningStatus, UpdateInstallation } from "@codexhost/shared-contracts";

import type { RendererSettingsMessages } from "./localization.js";

export interface MacOsSigningClient {
  getMacOsSigningStatus?(): Promise<MacOsLocalSigningStatus | null>;
  setupMacOsSigning?(): Promise<MacOsLocalSigningStatus>;
  removeMacOsSigning?(): Promise<MacOsLocalSigningStatus>;
}

export interface MacOsSigningController {
  readonly card: HTMLElement;
  sync(options: {
    installation: UpdateInstallation | null;
    client: MacOsSigningClient | null;
  }): void;
}

export function createMacOsSigningSection(
  document: Document,
  messages: RendererSettingsMessages,
  signal: AbortSignal,
): MacOsSigningController {
  const card = document.createElement("section");
  card.className = "settings-macos-signing";
  card.hidden = true;

  let currentClient: MacOsSigningClient | null = null;
  let currentInstallation: UpdateInstallation | null = null;
  let status: MacOsLocalSigningStatus | null = null;
  let busy: "setup" | "remove" | null = null;
  let errorText: string | null = null;
  let loadedForClient: MacOsSigningClient | null = null;

  const runAction = (action: "setup" | "remove"): void => {
    if (busy || !currentClient) return;
    const invoke =
      action === "setup"
        ? currentClient.setupMacOsSigning?.bind(currentClient)
        : currentClient.removeMacOsSigning?.bind(currentClient);
    if (!invoke) return;
    busy = action;
    errorText = null;
    renderCard();
    void invoke()
      .then((next) => {
        if (signal.aborted) return;
        status = next;
        busy = null;
        renderCard();
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        busy = null;
        errorText = error instanceof Error ? error.message : String(error);
        renderCard();
      });
  };

  const renderCard = (): void => {
    const visible = currentInstallation === "macos-dmg" && status !== null && status.supported;
    card.hidden = !visible;
    if (!visible || !status) return;

    const fullyActive =
      status.enabled && status.certificatePresent && status.appSignedWithLocalCert;
    const needsResign = status.enabled && !fullyActive;

    const row = document.createElement("div");
    row.className = "settings-macos-signing__row";

    const copy = document.createElement("div");
    copy.className = "settings-macos-signing__copy";

    const titleRow = document.createElement("div");
    titleRow.className = "settings-macos-signing__title-row";
    const title = document.createElement("strong");
    title.className = "settings-macos-signing__title";
    title.textContent = messages.macosSigningTitle;
    titleRow.append(title);

    if (fullyActive || needsResign) {
      const badge = document.createElement("span");
      badge.className = "settings-macos-signing__badge";
      badge.dataset.state = fullyActive ? "enabled" : "warn";
      badge.textContent = fullyActive
        ? messages.macosSigningStatusEnabled
        : messages.macosSigningStatusNeedsResign;
      titleRow.append(badge);
    }

    const description = document.createElement("p");
    description.className = "settings-macos-signing__description";
    description.textContent = messages.macosSigningDescription;

    copy.append(titleRow, description);

    const actions = document.createElement("div");
    actions.className = "settings-macos-signing__actions";
    const actionButton = document.createElement("button");
    actionButton.type = "button";
    actionButton.className = "settings-command-button settings-command-button--secondary";
    if (fullyActive) {
      actionButton.disabled = busy !== null || !currentClient?.removeMacOsSigning;
      actionButton.textContent =
        busy === "remove" ? messages.macosSigningRemoving : messages.macosSigningRemoveButton;
      actionButton.addEventListener("click", () => runAction("remove"));
    } else {
      actionButton.disabled = busy !== null || !currentClient?.setupMacOsSigning;
      actionButton.textContent =
        busy === "setup"
          ? messages.macosSigningSettingUp
          : needsResign
            ? messages.macosSigningResignButton
            : messages.macosSigningEnableButton;
      actionButton.addEventListener("click", () => runAction("setup"));
    }
    actions.append(actionButton);

    row.append(copy, actions);

    const children: HTMLElement[] = [row];
    if (errorText) {
      const error = document.createElement("p");
      error.className = "settings-update-error";
      error.setAttribute("role", "alert");
      error.textContent = errorText;
      children.push(error);
    }

    card.replaceChildren(...children);
  };

  return {
    card,
    sync({ installation, client }) {
      currentInstallation = installation;
      currentClient = client;
      if (installation !== "macos-dmg" || !client?.getMacOsSigningStatus) {
        card.hidden = true;
        return;
      }
      renderCard();
      if (loadedForClient === client) return;
      loadedForClient = client;
      void client
        .getMacOsSigningStatus()
        .then((next) => {
          if (signal.aborted || !next) return;
          status = next;
          renderCard();
        })
        .catch(() => {
          // Older Hosts without macOS local signing keep the card hidden.
        });
    },
  };
}
