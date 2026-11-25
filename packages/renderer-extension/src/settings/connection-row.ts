import type { CodexhostError } from "@codexhost/shared-contracts";

import type { AgentGroupSection } from "../agent-group-preference.js";
import type { RendererAgentAvailability } from "../agent-selection-state.js";
import { createRendererAgentIcon } from "../renderer-agent-icon.js";
import type { RendererAdapterStatus } from "../versioned-renderer-adapter.js";
import type { RendererConnectionAgentSnapshot } from "./connections-page.js";
import { harnessVersionLabel } from "./harness-version-messages.js";
import type { HarnessVersionPanel } from "./harness-version-panel.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

export type ConnectionAvailability =
  RendererAgentAvailability | RendererAdapterStatus["state"] | "updating";
export type ConnectionTone = "ready" | "checking" | "setup" | "failed";

export interface ConnectionListItem {
  readonly key: string;
  readonly name: string;
  readonly availability: ConnectionAvailability;
  readonly error: CodexhostError | null;
  readonly agentSnapshot?: RendererConnectionAgentSnapshot;
  readonly openWebUi?: () => Promise<void>;
  readonly install?: () => void;
  readonly installError?: string;
  readonly version?: HarnessVersionPanel;
}

export interface ConnectionRowGroupController {
  readonly disabled: boolean;
  readonly section: AgentGroupSection;
  readonly moveLabel: string;
  readonly dragHandleTitle: string;
  toggleSection(): void;
  onDragStart(event: DragEvent): void;
  onDragOver(event: DragEvent): void;
  onDragLeave(event: DragEvent): void;
  onDrop(event: DragEvent): void;
  onDragEnd(event: DragEvent): void;
}

export interface ConnectionRowView {
  readonly element: HTMLElement;
  update(
    item: ConnectionListItem,
    selected: boolean,
    select: () => void,
    group: ConnectionRowGroupController | null,
  ): void;
  setSelected(selected: boolean): void;
}

export function connectionStatusLabel(
  availability: ConnectionAvailability,
  messages: RendererSettingsMessages,
  hasError = false,
): string {
  if (availability === "updating") return messages.connectionStatusUpdating;
  if (hasError && availability !== "notInstalled") return messages.connectionStatusError;
  if (availability === "ready") return messages.connectionStatusReady;
  if (availability === "checking") return messages.connectionStatusChecking;
  if (availability === "notInstalled") return messages.connectionStatusNotInstalled;
  if (availability === "unavailable" || availability === "error") {
    return availability === "error"
      ? messages.connectionStatusError
      : messages.connectionStatusUnavailable;
  }
  return availability === "installing"
    ? messages.connectionStatusInstalling
    : messages.connectionStatusUnsupported;
}

export function connectionStatusTone(
  availability: ConnectionAvailability,
  hasError = false,
): ConnectionTone {
  if (availability === "updating") return "checking";
  if (hasError && availability !== "notInstalled") return "failed";
  if (availability === "ready") return "ready";
  if (availability === "checking" || availability === "installing") return "checking";
  if (availability === "notInstalled") return "setup";
  return "failed";
}

export function createConnectionIdentityIcon(
  document: Document,
  item: ConnectionListItem,
  size: number,
): HTMLElement {
  const container = document.createElement("span");
  container.className = item.agentSnapshot
    ? "settings-connection-row__mark settings-connection-row__mark--logo"
    : "settings-connection-row__mark";
  container.setAttribute("aria-hidden", "true");
  if (item.agentSnapshot) {
    container.append(
      createRendererAgentIcon(item.agentSnapshot.agent, size, document, item.agentSnapshot.plugin),
    );
  } else {
    container.textContent = "CH";
  }
  return container;
}

function sameElementChildren(container: HTMLElement, next: readonly HTMLElement[]): boolean {
  if (container.children.length !== next.length) return false;
  for (let index = 0; index < next.length; index++) {
    if (container.children[index] !== next[index]) return false;
  }
  return true;
}

/**
 * Reconciles direct element children without detaching nodes whose relative order
 * is unchanged, preserving hover/click targets and browser scroll anchoring.
 */
export function reconcileElementChildren(
  container: HTMLElement,
  next: readonly HTMLElement[],
): void {
  if (sameElementChildren(container, next)) return;
  if (typeof container.insertBefore !== "function") {
    container.replaceChildren(...next);
    return;
  }
  const nextSet = new Set<Element>(next);
  for (const child of [...container.children]) {
    if (!nextSet.has(child)) child.remove();
  }
  for (let index = 0; index < next.length; index++) {
    const desired = next[index];
    if (!desired) continue;
    const current = container.children[index] ?? null;
    if (current !== desired) {
      container.insertBefore(desired, current);
    }
  }
}

function identityIconSignature(item: ConnectionListItem): string {
  if (!item.agentSnapshot) return "adapter";
  const plugin = item.agentSnapshot.plugin as { icon?: unknown; iconStyle?: unknown } | undefined;
  return `${item.agentSnapshot.agent}:${String(plugin?.icon ?? "")}:${String(plugin?.iconStyle ?? "")}`;
}

export function createConnectionRowView(
  document: Document,
  messages: RendererSettingsMessages,
  groupable: boolean,
): ConnectionRowView {
  const row = document.createElement("div");
  row.className = "settings-connection-row";
  row.setAttribute("role", "row");

  const identity = document.createElement("div");
  identity.className = "settings-connection-row__identity";
  identity.setAttribute("role", "cell");

  let handle: HTMLElement | null = null;
  if (groupable) {
    handle = document.createElement("span");
    handle.className = "settings-connection-row__handle";
    handle.setAttribute("aria-hidden", "true");
    handle.append(createRendererSettingsIcon("grip-vertical", 15));
    identity.append(handle);
  }

  let iconElement: HTMLElement | null = null;
  let renderedIconKey: string | null = null;
  const label = document.createElement("strong");

  const status = document.createElement("span");
  status.className = "settings-connection-row__status";
  status.setAttribute("role", "cell");

  const action = document.createElement("div");
  action.className = "settings-connection-row__action";
  action.setAttribute("role", "cell");

  row.append(identity, status, action);

  let currentItem: ConnectionListItem | null = null;
  let currentSelect: () => void = () => undefined;
  let currentGroup: ConnectionRowGroupController | null = null;

  let installButton: HTMLButtonElement | null = null;
  let viewErrorButton: HTMLButtonElement | null = null;
  let versionAvailableBadge: HTMLElement | null = null;
  let updateButton: HTMLButtonElement | null = null;
  let groupToggleButton: HTMLButtonElement | null = null;
  let groupToggleSection: AgentGroupSection | null = null;

  row.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (target?.closest?.("a")) return;
    currentSelect();
  });
  row.addEventListener("keydown", (event) => {
    if ((event.target as Element | null)?.closest?.("button, a")) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    currentSelect();
  });
  if (groupable) {
    row.addEventListener("dragstart", (event) => currentGroup?.onDragStart(event));
    row.addEventListener("dragover", (event) => currentGroup?.onDragOver(event));
    row.addEventListener("dragleave", (event) => currentGroup?.onDragLeave(event));
    row.addEventListener("drop", (event) => currentGroup?.onDrop(event));
    row.addEventListener("dragend", (event) => currentGroup?.onDragEnd(event));
  }

  const setSelected = (selected: boolean): void => {
    const nextSelected = String(selected);
    if (row.dataset.connectionSelected !== nextSelected) {
      row.dataset.connectionSelected = nextSelected;
    }
    const nextTabIndex = selected ? 0 : -1;
    if (row.tabIndex !== nextTabIndex) {
      row.tabIndex = nextTabIndex;
    }
  };

  return {
    element: row,
    setSelected,
    update(item, selected, select, group) {
      currentItem = item;
      currentSelect = select;
      currentGroup = group;

      if (row.dataset.connectionItem !== item.key) {
        row.dataset.connectionItem = item.key;
      }
      setSelected(selected);

      const nextIconKey = identityIconSignature(item);
      if (renderedIconKey !== nextIconKey || !iconElement) {
        renderedIconKey = nextIconKey;
        iconElement = createConnectionIdentityIcon(document, item, 19);
        reconcileElementChildren(
          identity,
          handle ? [handle, iconElement, label] : [iconElement, label],
        );
      }
      if (handle && group && handle.title !== group.dragHandleTitle) {
        handle.title = group.dragHandleTitle;
      }
      if (label.textContent !== item.name) {
        label.textContent = item.name;
      }

      const tone = connectionStatusTone(item.availability, item.error !== null);
      if (status.dataset.connectionTone !== tone) {
        status.dataset.connectionTone = tone;
      }
      const statusText =
        item.error?.code === "authenticationRequired"
          ? messages.connectionLoginRequired
          : item.error?.code === "configurationRequired"
            ? messages.connectionConfigurationRequired
            : connectionStatusLabel(item.availability, messages, item.error !== null);
      if (status.textContent !== statusText) {
        status.textContent = statusText;
      }

      const nextActions: HTMLElement[] = [];
      if (item.agentSnapshot?.availability === "notInstalled" && item.install) {
        if (!installButton) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "settings-connection-install-link";
          button.append(createRendererSettingsIcon("download", 17));
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            currentSelect();
            currentItem?.install?.();
          });
          installButton = button;
        }
        installButton.disabled =
          item.availability === "installing" || item.availability === "checking";
        const installLabel = messages.connectionInstall;
        const ariaLabel = `${installLabel}: ${item.name}`;
        if (installButton.getAttribute("aria-label") !== ariaLabel) {
          installButton.setAttribute("aria-label", ariaLabel);
        }
        if (installButton.title !== installLabel) {
          installButton.title = installLabel;
        }
        nextActions.push(installButton);
      } else if (item.error) {
        if (!viewErrorButton) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "settings-connection-view-error";
          button.textContent = messages.connectionViewError;
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            currentSelect();
          });
          viewErrorButton = button;
        }
        nextActions.push(viewErrorButton);
      }

      const version = item.version;
      if (version?.state?.updateAvailable && !version.updating) {
        if (!versionAvailableBadge) {
          const badge = document.createElement("span");
          badge.className = "settings-connection-version-available";
          badge.textContent = messages.harnessVersionAvailable;
          versionAvailableBadge = badge;
        }
        const badgeTitle = `${messages.harnessVersionCurrent}: ${version.state.currentVersion ?? "—"}\n${messages.harnessVersionLatest}: ${harnessVersionLabel(version.state, messages.harnessVersion)}`;
        if (versionAvailableBadge.title !== badgeTitle) {
          versionAvailableBadge.title = badgeTitle;
        }
        nextActions.push(versionAvailableBadge);
      }
      if (version?.state?.updateAvailable && version.state.canUpdate) {
        if (!updateButton) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "settings-connection-install-link";
          button.dataset.connectionAction = "update";
          button.append(createRendererSettingsIcon("download", 17));
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            if (button.disabled) return;
            void currentItem?.version?.update();
            currentSelect();
          });
          updateButton = button;
        }
        updateButton.disabled = version.updating;
        if (updateButton.title !== messages.harnessVersionUpdate) {
          updateButton.title = messages.harnessVersionUpdate;
        }
        const updateAriaLabel = `${messages.harnessVersionUpdate}: ${item.name}`;
        if (updateButton.getAttribute("aria-label") !== updateAriaLabel) {
          updateButton.setAttribute("aria-label", updateAriaLabel);
        }
        nextActions.push(updateButton);
      }
      if (group) {
        if (!groupToggleButton) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "settings-connection-row__group-toggle";
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            currentGroup?.toggleSection();
          });
          groupToggleButton = button;
        }
        groupToggleButton.disabled = group.disabled;
        if (groupToggleButton.title !== group.moveLabel) {
          groupToggleButton.title = group.moveLabel;
        }
        if (groupToggleButton.getAttribute("aria-label") !== group.moveLabel) {
          groupToggleButton.setAttribute("aria-label", group.moveLabel);
        }
        if (groupToggleSection !== group.section) {
          groupToggleSection = group.section;
          groupToggleButton.replaceChildren(
            createRendererSettingsIcon(
              group.section === "main" ? "chevron-down" : "chevron-up",
              15,
            ),
          );
        }
        nextActions.push(groupToggleButton);
      }
      reconcileElementChildren(action, nextActions);

      if (group) {
        row.draggable = !group.disabled;
        if (row.dataset.connectionGroupSection !== group.section) {
          row.dataset.connectionGroupSection = group.section;
        }
      }
    },
  };
}
