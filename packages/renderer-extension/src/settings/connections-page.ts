import type {
  CodexhostError,
  HarnessInstallationState,
  HarnessLaunchSettings,
  HarnessPluginDescriptor,
} from "@codexhost/shared-contracts";

import {
  getSharedAgentGroupPreferenceStore,
  type AgentGroupEntry,
  type AgentGroupPreferenceStore,
  type AgentGroupSection,
} from "../agent-group-preference.js";
import type { ExternalRendererAgent, RendererAgentAvailability } from "../agent-selection-state.js";
import { rendererAgentLabel } from "../renderer-agent-icon.js";
import type { RemoteConnectionsControl } from "../remote-connections-control.js";
import type { RendererAdapterStatus } from "../versioned-renderer-adapter.js";
import {
  connectionStatusLabel,
  connectionStatusTone,
  createConnectionIdentityIcon,
  createConnectionRowView,
  reconcileElementChildren,
  type ConnectionListItem,
  type ConnectionRowGroupController,
  type ConnectionRowView,
} from "./connection-row.js";
import { createConnectionUpdates } from "./connection-updates.js";
import { createConnectionVersions } from "./connection-versions.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import { harnessInstallStore } from "./harness-install-store.js";
import { harnessHasInstallCommands } from "./harness-installation-guides.js";
import { createHarnessInstallationPanel } from "./harness-installation-panel.js";
import { createHarnessLaunchControls } from "./harness-launch-controls.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

export const CODEXHOST_GITHUB_ISSUES_NEW_URL =
  "https://github.com/BytePioneer-AI/codex-host/issues/new";

export interface RendererConnectionAgentSnapshot {
  readonly agent: ExternalRendererAgent;
  readonly plugin?: HarnessPluginDescriptor;
  readonly availability: RendererAgentAvailability;
  readonly error: CodexhostError | null;
  readonly webUiAvailable?: true;
}

export interface RendererConnectionHostSnapshot {
  readonly hostId: string;
  readonly active: boolean;
  readonly agents: readonly RendererConnectionAgentSnapshot[];
  readonly directoryError?: string;
  readonly directoryUnsupported?: boolean;
}

export interface RendererConnectionSnapshot {
  readonly adapter: RendererAdapterStatus;
  readonly hosts: readonly RendererConnectionHostSnapshot[];
}

export interface RendererConnectionDiagnostics {
  snapshot(): RendererConnectionSnapshot;
  /** With a Host, wait for existing diagnostics and start a fresh post-mutation inspection. */
  refresh(hostId?: string, credentialAccess?: "retry"): Promise<void>;
  openWebUi?(hostId: string, agent: ExternalRendererAgent): Promise<void>;
  installation?(
    hostId: string,
    agent: ExternalRendererAgent,
    action: "check" | "update" | "install",
    confirmedVersion?: string,
  ): Promise<HarnessInstallationState>;
  getLaunchSettings?(hostId: string, agent: ExternalRendererAgent): Promise<HarnessLaunchSettings>;
  setLaunchSettings?(
    hostId: string,
    agent: ExternalRendererAgent,
    path: string | null,
  ): Promise<HarnessLaunchSettings>;
  subscribe(listener: () => void): () => void;
}

function diagnosticText(
  hostId: string,
  item: Pick<ConnectionListItem, "name" | "availability" | "error">,
): string {
  const error = item.error;
  return [
    "codexhost connection diagnostics",
    `host: ${hostId}`,
    `agent: ${item.name}`,
    `status: ${item.availability}`,
    ...(error
      ? [
          `error.code: ${error.code}`,
          `error.message: ${error.message}`,
          `retryable: ${error.retryable}`,
          ...(error.stage ? [`stage: ${error.stage}`] : []),
          ...(error.durationMs !== undefined ? [`durationMs: ${error.durationMs}`] : []),
          ...(error.diagnostic ? [`diagnostic: ${error.diagnostic}`] : []),
          ...(error.stderrTail ? [`stderr:\n${error.stderrTail}`] : []),
        ]
      : []),
  ].join("\n");
}

function setCopyButtonLabel(button: HTMLButtonElement, label: string): void {
  button.replaceChildren(createRendererSettingsIcon("copy", 16), label);
}

function showCopyButtonFeedback(
  button: HTMLButtonElement,
  label: string,
  restoreLabel: string,
): void {
  setCopyButtonLabel(button, label);
  button.ownerDocument.defaultView?.setTimeout(() => {
    setCopyButtonLabel(button, restoreLabel);
  }, 2_000);
}

function copyDiagnosticsToClipboard(
  document: Document,
  button: HTMLButtonElement,
  report: string,
  messages: RendererSettingsMessages,
  restoreLabel: string,
): void {
  const clipboard = document.defaultView?.navigator.clipboard;
  if (!clipboard) {
    showCopyButtonFeedback(button, messages.connectionCopyFailed, restoreLabel);
    return;
  }
  void clipboard.writeText(report).then(
    () => showCopyButtonFeedback(button, messages.connectionCopied, restoreLabel),
    () => showCopyButtonFeedback(button, messages.connectionCopyFailed, restoreLabel),
  );
}

export function connectionHostName(hostId: string, messages: RendererSettingsMessages): string {
  if (hostId === "local") return messages.connectionLocalHost;
  const separator = hostId.lastIndexOf(":");
  const encodedName = separator >= 0 ? hostId.slice(separator + 1) : hostId;
  try {
    return decodeURIComponent(encodedName);
  } catch {
    return encodedName;
  }
}

function createHostScrollButton(
  document: Document,
  direction: "left" | "right",
  messages: RendererSettingsMessages,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "settings-connection-host-scroll";
  button.dataset.connectionHostScroll = direction;
  const label =
    direction === "left" ? messages.connectionHostsScrollLeft : messages.connectionHostsScrollRight;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(
    createRendererSettingsIcon(direction === "left" ? "chevron-left" : "chevron-right", 16),
  );
  return button;
}

function configureHostScroller(
  document: Document,
  strip: HTMLElement,
  tabs: HTMLElement,
  left: HTMLButtonElement,
  right: HTMLButtonElement,
): { update(): void; dispose(): void } {
  const maxScrollLeft = (): number =>
    Math.max(0, (tabs.scrollWidth || 0) - (tabs.clientWidth || 0));
  const updateButtons = (): void => {
    const maximum = maxScrollLeft();
    strip.dataset.connectionHostOverflow = String(maximum > 1);
    left.disabled = tabs.scrollLeft <= 1;
    right.disabled = maximum <= 1 || tabs.scrollLeft >= maximum - 1;
  };
  const scroll = (direction: -1 | 1): void => {
    const distance = Math.max(180, Math.round((tabs.clientWidth || 250) * 0.72));
    if (typeof tabs.scrollBy === "function") {
      tabs.scrollBy({ left: direction * distance, behavior: "smooth" });
    } else {
      tabs.scrollLeft += direction * distance;
      updateButtons();
    }
  };
  const onLeft = (): void => scroll(-1);
  const onRight = (): void => scroll(1);
  const onWheel = (event: WheelEvent): void => {
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const maximum = maxScrollLeft();
    const canScroll = delta < 0 ? tabs.scrollLeft > 1 : tabs.scrollLeft < maximum - 1;
    if (!delta || maximum <= 1 || !canScroll) return;
    event.preventDefault();
    tabs.scrollLeft += delta;
  };
  left.addEventListener("click", onLeft);
  right.addEventListener("click", onRight);
  tabs.addEventListener("scroll", updateButtons, { passive: true });
  tabs.addEventListener("wheel", onWheel, { passive: false });
  const ownerWindow = document.defaultView;
  ownerWindow?.addEventListener("resize", updateButtons);
  const refreshLayout = (): void => {
    ownerWindow?.setTimeout(updateButtons, 0);
    updateButtons();
  };
  refreshLayout();
  return {
    update: refreshLayout,
    dispose() {
      left.removeEventListener("click", onLeft);
      right.removeEventListener("click", onRight);
      tabs.removeEventListener("scroll", updateButtons);
      tabs.removeEventListener("wheel", onWheel);
      ownerWindow?.removeEventListener("resize", updateButtons);
    },
  };
}

function createInspectorHeader(
  document: Document,
  item: ConnectionListItem,
  messages: RendererSettingsMessages,
): HTMLElement {
  const header = document.createElement("header");
  header.className = "settings-connection-inspector__header";
  const identity = document.createElement("div");
  identity.className = "settings-connection-inspector__identity";
  const title = document.createElement("strong");
  title.textContent = item.name;
  identity.append(createConnectionIdentityIcon(document, item, 20), title);
  const websiteUrl =
    item.agentSnapshot?.plugin?.links?.website ?? item.agentSnapshot?.plugin?.links?.documentation;
  if (websiteUrl) {
    const website = document.createElement("a");
    website.className = "settings-connection-website";
    website.href = websiteUrl;
    website.target = "_blank";
    website.rel = "noopener noreferrer";
    website.title = messages.connectionOfficialWebsite;
    website.setAttribute("aria-label", `${messages.connectionOfficialWebsite}: ${item.name}`);
    website.append(createRendererSettingsIcon("external-link", 13));
    website.addEventListener("click", (event) => event.stopPropagation());
    identity.append(website);
  }
  const status = document.createElement("span");
  status.className = "settings-connection-row__status";
  status.dataset.connectionTone = connectionStatusTone(item.availability, item.error !== null);
  status.textContent =
    item.error?.code === "authenticationRequired"
      ? messages.connectionLoginRequired
      : item.error?.code === "configurationRequired"
        ? messages.connectionConfigurationRequired
        : item.agentSnapshot && item.availability === "ready" && !item.error
          ? messages.connectionStatusConnected
          : connectionStatusLabel(item.availability, messages, item.error !== null);
  header.append(identity, status);
  return header;
}

function inspectorRenderSignature(
  hostId: string,
  item: ConnectionListItem,
  messages: RendererSettingsMessages,
  diagnostics: RendererConnectionDiagnostics | null,
): string {
  const plugin = item.agentSnapshot?.plugin as
    | (HarnessPluginDescriptor & { icon?: unknown; iconStyle?: unknown; installation?: unknown })
    | undefined;
  const notice = plugin?.notice ? (plugin.notice[messages.locale] ?? plugin.notice.en) : "";
  const websiteUrl = plugin?.links?.website ?? plugin?.links?.documentation ?? "";
  const hasLaunchControls =
    hostId === "local" &&
    Boolean(item.agentSnapshot?.agent) &&
    Boolean(plugin?.launchCommand) &&
    Boolean(diagnostics?.getLaunchSettings && diagnostics?.setLaunchSettings);
  return JSON.stringify([
    hostId,
    item.key,
    item.name,
    item.availability,
    item.agentSnapshot?.availability ?? null,
    String(plugin?.icon ?? ""),
    String(plugin?.iconStyle ?? ""),
    websiteUrl,
    notice,
    item.installError ?? "",
    Boolean(item.install),
    plugin?.installation ?? null,
    Boolean(item.openWebUi),
    hasLaunchControls,
    item.error ? diagnosticText(hostId, item) : "",
  ]);
}

function renderConnectionInspector(
  document: Document,
  inspector: HTMLElement,
  item: ConnectionListItem,
  hostId: string,
  messages: RendererSettingsMessages,
  diagnostics: RendererConnectionDiagnostics | null,
  existingLaunchControls: HTMLElement | null,
  refresh: () => void,
): HTMLElement | null {
  inspector.replaceChildren(createInspectorHeader(document, item, messages));
  const body = document.createElement("div");
  body.className = "settings-connection-inspector__body";
  if (item.installError) {
    const error = document.createElement("div");
    error.className = "settings-connection-error-summary";
    error.setAttribute("role", "alert");
    error.textContent = item.installError;
    body.append(error);
  }
  const notice = item.agentSnapshot?.plugin?.notice;
  if (notice) {
    const compatibility = document.createElement("p");
    compatibility.className = "settings-connection-compatibility";
    compatibility.textContent = notice[messages.locale] ?? notice.en;
    body.append(compatibility);
  }

  if (item.agentSnapshot?.availability === "notInstalled") {
    const zh = messages.locale === "zh-CN";
    const busy = item.availability === "installing" || item.availability === "checking";
    const note = (text: string): void => {
      const paragraph = document.createElement("p");
      paragraph.textContent = text;
      body.append(paragraph);
    };
    if (busy) note(messages.connectionInstallRunning);
    body.append(
      createHarnessInstallationPanel(
        document,
        item.agentSnapshot.plugin,
        hostId,
        messages,
        (button, command, label) =>
          copyDiagnosticsToClipboard(document, button, command, messages, label),
        item.install
          ? {
              run: item.install,
              status: busy ? (item.availability as "installing" | "checking") : "idle",
            }
          : undefined,
      ),
    );
    const check = document.createElement("button");
    check.type = "button";
    check.className = "settings-command-button";
    check.dataset.connectionAction = "check-install";
    check.textContent = zh ? "重新检测" : "Check again";
    check.disabled = busy;
    check.addEventListener("click", () => {
      check.disabled = true;
      check.textContent = messages.connectionRefreshing;
      refresh();
    });
    body.append(check);
  } else if (item.error) {
    const summary = document.createElement("div");
    summary.className = "settings-connection-error-summary";
    const title = document.createElement("strong");
    const needsLogin = item.error.code === "authenticationRequired";
    const needsConfiguration = item.error.code === "configurationRequired";
    title.textContent = needsLogin
      ? messages.connectionLoginRequired
      : needsConfiguration
        ? messages.connectionConfigurationRequired
        : messages.connectionErrorTitle;
    const description = document.createElement("p");
    description.textContent = needsLogin
      ? messages.connectionLoginDescription
      : needsConfiguration
        ? messages.connectionConfigurationDescription
        : item.error.message;
    summary.append(title, description);

    const logHeader = document.createElement("div");
    logHeader.className = "settings-connection-error-log-header";
    const logTitle = document.createElement("strong");
    logTitle.textContent = messages.connectionErrorLog;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "settings-command-button settings-command-button--secondary";
    setCopyButtonLabel(copy, messages.connectionCopyDetails);
    const report = diagnosticText(hostId, item);
    copy.addEventListener("click", () => {
      copyDiagnosticsToClipboard(document, copy, report, messages, messages.connectionCopyDetails);
    });
    logHeader.append(logTitle, copy);
    const log = document.createElement("pre");
    log.className = "settings-connection-stderr";
    log.textContent = report;

    const actions = document.createElement("div");
    actions.className = "settings-connection-error-actions";
    const issue = document.createElement("a");
    issue.className = "settings-command-button settings-command-button--secondary";
    issue.href = CODEXHOST_GITHUB_ISSUES_NEW_URL;
    issue.target = "_blank";
    issue.rel = "noopener noreferrer";
    issue.append(messages.connectionOpenIssue, createRendererSettingsIcon("external-link", 14));
    actions.append(issue);
    const issueNote = document.createElement("p");
    issueNote.className = "settings-connection-issue-note";
    issueNote.textContent = messages.connectionIssueDescription;
    body.append(summary, logHeader, log, actions, issueNote);
  } else {
    const status = document.createElement("div");
    status.className = "settings-connection-state-summary";
    const title = document.createElement("strong");
    title.textContent = connectionStatusLabel(item.availability, messages);
    const description = document.createElement("p");
    description.textContent =
      item.availability === "updating"
        ? messages.harnessVersionUpdating
        : item.availability === "ready"
          ? messages.connectionReadyDescription
          : messages.connectionUnavailableDescription;
    status.append(title, description);
    if (!item.agentSnapshot || item.availability !== "ready") body.append(status);
    if (item.openWebUi) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "settings-command-button settings-command-button--secondary";
      open.dataset.connectionAction = "open-web-ui";
      open.append(
        messages.connectionOpenHarnessWeb,
        createRendererSettingsIcon("external-link", 14),
      );
      open.addEventListener("click", () => {
        if (open.disabled) return;
        open.disabled = true;
        void item
          .openWebUi?.()
          .catch(() => undefined)
          .finally(() => {
            open.disabled = false;
          });
      });
      body.append(open);
    }
  }

  let launchControls: HTMLElement | null = null;
  const agent = item.agentSnapshot?.agent;
  const getLaunchSettings = diagnostics?.getLaunchSettings?.bind(diagnostics);
  const setLaunchSettings = diagnostics?.setLaunchSettings?.bind(diagnostics);
  if (
    hostId === "local" &&
    agent &&
    item.agentSnapshot?.plugin?.launchCommand &&
    getLaunchSettings &&
    setLaunchSettings
  ) {
    launchControls =
      existingLaunchControls ??
      createHarnessLaunchControls(document, messages, agent, {
        get: () => getLaunchSettings(hostId, agent),
        set: (path) => setLaunchSettings(hostId, agent, path),
      });
    body.append(launchControls);
  }
  inspector.append(body);
  return launchControls;
}

function connectionItems(
  snapshot: RendererConnectionSnapshot,
  host: RendererConnectionHostSnapshot,
  messages: RendererSettingsMessages,
  diagnostics: RendererConnectionDiagnostics | null,
): ConnectionListItem[] {
  return [
    {
      key: "renderer-adapter",
      name: messages.connectionAdapter,
      availability: snapshot.adapter.state,
      error: null,
    },
    ...(host.directoryError
      ? [
          {
            key: "plugin-directory",
            name: "Harness plugins",
            availability: "error" as const,
            error: {
              code: "unavailable" as const,
              message: host.directoryError,
              retryable: !host.directoryUnsupported,
            },
          },
        ]
      : []),
    ...host.agents.map((agent): ConnectionListItem => ({
      key: agent.agent,
      name: rendererAgentLabel(agent.agent, agent.plugin),
      availability: agent.availability,
      error: agent.availability === "notInstalled" ? null : agent.error,
      agentSnapshot: agent,
      ...(host.hostId === "local" && agent.webUiAvailable && diagnostics?.openWebUi
        ? {
            openWebUi: () => diagnostics.openWebUi?.(host.hostId, agent.agent) ?? Promise.resolve(),
          }
        : {}),
    })),
  ];
}

// Lets another surface (currently: the Agent picker's error indicator, see
// renderer-agent-picker.ts) ask the Connections page to focus a specific
// Agent's row the next time it mounts, instead of falling back to "the
// first Agent that needs attention". Consumed once, then cleared — if the
// requested Agent isn't present under whichever Host tab is selected by
// default, this silently falls through to the existing fallback below.
let pendingFocusAgent: string | null = null;

export function requestConnectionsPageFocus(agentKey: string): void {
  pendingFocusAgent = agentKey;
}

function createGroupDivider(document: Document): HTMLElement {
  const divider = document.createElement("div");
  divider.className = "settings-connection-group-divider";
  divider.setAttribute("role", "presentation");
  return divider;
}

function createGroupMoreHint(document: Document, messages: RendererSettingsMessages): HTMLElement {
  const hint = document.createElement("div");
  hint.className = "settings-connection-group-hint";
  hint.setAttribute("role", "presentation");
  const title = document.createElement("strong");
  title.textContent = messages.connectionGroupMoreHintTitle;
  const body = document.createElement("span");
  body.textContent = messages.connectionGroupMoreHintBody;
  hint.append(title, body);
  return hint;
}

function createGroupResetButton(
  document: Document,
  messages: RendererSettingsMessages,
  onReset: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "settings-connection-group-reset";
  button.append(createRendererSettingsIcon("undo", 14), messages.connectionGroupReset);
  button.addEventListener("click", onReset);
  return button;
}

export function createConnectionsSettingsPage(
  messages: RendererSettingsMessages,
  getDiagnostics: () => RendererConnectionDiagnostics | null,
  groupPreference: AgentGroupPreferenceStore = getSharedAgentGroupPreferenceStore(),
  getRemoteConnections: () => RemoteConnectionsControl | null = () => null,
): RendererSettingsPageDefinition {
  return Object.freeze({
    id: "connections",
    label: messages.pageLabels.connections,
    icon: "connections",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const header = document.createElement("div");
      header.className = "settings-connection-page-header";
      const headingCopy = document.createElement("div");
      const heading = document.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = messages.pageLabels.connections;
      const description = document.createElement("p");
      description.className = "settings-page-description";
      description.textContent = messages.connectionsDescription;
      headingCopy.append(heading, description);
      const refresh = document.createElement("button");
      refresh.type = "button";
      refresh.className = "settings-command-button settings-command-button--secondary";
      refresh.dataset.connectionAction = "refresh";
      refresh.append(createRendererSettingsIcon("diagnose", 16), messages.connectionRefresh);
      header.append(headingCopy, refresh);
      const content = document.createElement("div");
      content.className = "settings-connections-content";
      const syncMessage = document.createElement("p");
      syncMessage.className = "settings-page-description";
      syncMessage.setAttribute("role", "status");
      context.content.append(header, syncMessage, content);

      let pending = false;
      let selectedHostId: string | null = null;
      let renderedHostId: string | null = null;
      let selectedItemKey: string | null = null;
      // Background availability updates must not discard a path draft or an in-flight save.
      let launchControls: { hostId: string; itemKey: string; element: HTMLElement | null } | null =
        null;
      let renderedInspector: { signature: string; versionElement: HTMLElement | null } | null =
        null;
      const hostNames = new Map<string, string>();
      const knownNotInstalled = new Map<string, boolean>();
      let latestSnapshot: RendererConnectionSnapshot | null = null;
      let disposed = false;
      let renderQueued = false;
      let renderFrame: number | null = null;

      // Inspections arrive per Harness. Render their latest state once per
      // frame rather than updating rows on every notification.
      const scheduleRender = (): void => {
        if (disposed || context.signal.aborted || renderQueued) return;
        renderQueued = true;
        const flush = (): void => {
          renderFrame = null;
          renderQueued = false;
          if (!disposed && !context.signal.aborted) {
            render(diagnostics?.snapshot() ?? latestSnapshot);
          }
        };
        if (document.defaultView?.requestAnimationFrame) {
          renderFrame = document.defaultView.requestAnimationFrame(flush);
        } else {
          queueMicrotask(flush);
        }
      };
      const cancelRender = (): void => {
        disposed = true;
        if (renderFrame !== null) document.defaultView?.cancelAnimationFrame(renderFrame);
        renderFrame = null;
      };

      const diagnostics = getDiagnostics();
      const versions = createConnectionVersions(
        context.content,
        messages,
        context.signal,
        diagnostics,
        scheduleRender,
      );
      const installs = diagnostics ? harnessInstallStore(diagnostics) : null;
      const updates = createConnectionUpdates(
        document,
        messages,
        context.signal,
        scheduleRender,
        diagnostics,
      );

      const panelId = "codexhost-settings-connection-host-panel";
      const empty = document.createElement("div");
      empty.className = "settings-empty";
      empty.textContent = messages.connectionNoRuntime;

      const layout = document.createElement("div");
      layout.className = "settings-connections-layout";
      const list = document.createElement("section");
      list.className = "settings-connection-list";
      const hostStrip = document.createElement("div");
      hostStrip.className = "settings-connection-host-strip";
      const scrollLeft = createHostScrollButton(document, "left", messages);
      const tabs = document.createElement("div");
      tabs.className = "settings-connection-host-tabs";
      tabs.setAttribute("role", "tablist");
      tabs.setAttribute("aria-label", messages.connectionHosts);
      const scrollRight = createHostScrollButton(document, "right", messages);
      hostStrip.append(scrollLeft, tabs, scrollRight);

      const updateControls = updates.createControls("local", []);
      const hostHeader = document.createElement("div");
      hostHeader.className = "settings-connection-host-header";
      hostHeader.append(hostStrip, updateControls.button);

      const tableHeader = document.createElement("div");
      tableHeader.className = "settings-connection-table-header";
      tableHeader.setAttribute("role", "row");
      const componentHeading = document.createElement("span");
      componentHeading.textContent = messages.connectionComponent;
      componentHeading.setAttribute("role", "columnheader");
      const statusHeading = document.createElement("span");
      statusHeading.textContent = messages.connectionStatus;
      statusHeading.setAttribute("role", "columnheader");
      const actionHeading = document.createElement("span");
      actionHeading.setAttribute("aria-hidden", "true");
      tableHeader.append(componentHeading, statusHeading, actionHeading);

      const rows = document.createElement("div");
      rows.className = "settings-connection-rows";
      rows.id = panelId;
      rows.setAttribute("role", "rowgroup");
      list.append(hostHeader, updateControls.result, tableHeader, rows);

      const inspector = document.createElement("aside");
      inspector.className = "settings-connection-inspector";
      inspector.setAttribute("aria-live", "polite");
      layout.append(list, inspector);

      const hostScroller = configureHostScroller(
        document,
        hostStrip,
        tabs,
        scrollLeft,
        scrollRight,
      );
      const hostTabElements = new Map<string, HTMLButtonElement>();
      const hostRowViews = new Map<string, Map<string, ConnectionRowView>>();

      const groupDivider = createGroupDivider(document);
      const moreHint = createGroupMoreHint(document, messages);
      const moreZone = document.createElement("div");
      moreZone.className = "settings-connection-group-more";
      moreZone.setAttribute("role", "presentation");
      // The shared order is written to the local connection even when viewing a remote Host.
      let groupDisabled = false;
      const resetButton = createGroupResetButton(
        document,
        messages,
        groupPreference.resetToDefault,
      );

      let draggingAgent: ExternalRendererAgent | null = null;
      let currentCatalog: { id: string; name: string }[] = [];
      let currentMainEntries: readonly AgentGroupEntry[] = [];
      let currentMoreEntries: readonly AgentGroupEntry[] = [];
      let currentHostRows = new Map<string, ConnectionRowView>();

      const clearDropIndicators = (): void => {
        for (const view of currentHostRows.values()) {
          view.element.dataset.connectionDropIndicator = "";
        }
        moreZone.dataset.connectionDragOver = "false";
      };

      moreZone.addEventListener("dragover", (event) => {
        if (!draggingAgent) return;
        event.preventDefault();
        moreZone.dataset.connectionDragOver = "true";
      });
      moreZone.addEventListener("dragleave", () => {
        moreZone.dataset.connectionDragOver = "false";
      });
      moreZone.addEventListener("drop", (event) => {
        event.preventDefault();
        moreZone.dataset.connectionDragOver = "false";
        if (groupDisabled || !draggingAgent) return;
        groupPreference.moveAgent(draggingAgent, "more", null, currentCatalog);
        draggingAgent = null;
        clearDropIndicators();
      });

      const runRefresh = (): void => {
        if (pending || !diagnostics) return;
        pending = true;
        refresh.disabled = true;
        refresh.replaceChildren(
          createRendererSettingsIcon("diagnose", 16),
          messages.connectionRefreshing,
        );
        void context.runLatest(() => diagnostics.refresh(undefined, "retry"), {
          success() {
            installs?.clearErrors();
            pending = false;
            renderedInspector = null;
            refresh.disabled = false;
            refresh.replaceChildren(
              createRendererSettingsIcon("diagnose", 16),
              messages.connectionRefresh,
            );
            render(diagnostics.snapshot());
          },
          failure(error) {
            pending = false;
            renderedInspector = null;
            refresh.disabled = false;
            refresh.replaceChildren(
              createRendererSettingsIcon("diagnose", 16),
              messages.connectionRefresh,
            );
            const snapshot = diagnostics.snapshot();
            render({
              ...snapshot,
              hosts: snapshot.hosts.map((host) => ({
                ...host,
                agents: host.agents.map((agent) => ({
                  ...agent,
                  availability: "error",
                  error: {
                    code: "internalError",
                    message: error instanceof Error ? error.message : String(error),
                    retryable: true,
                    stage: "request",
                  },
                })),
              })),
            });
          },
        });
      };

      const syncSelectedInspector = (hostId: string, item: ConnectionListItem): void => {
        const currentDiagnostics = getDiagnostics();
        const signature = inspectorRenderSignature(hostId, item, messages, currentDiagnostics);
        const versionElement = item.version?.element ?? null;
        if (
          renderedInspector?.signature === signature &&
          renderedInspector.versionElement === versionElement
        ) {
          return;
        }
        const existing =
          launchControls?.hostId === hostId && launchControls.itemKey === item.key
            ? launchControls.element
            : null;
        const element = renderConnectionInspector(
          document,
          inspector,
          item,
          hostId,
          messages,
          currentDiagnostics,
          existing,
          runRefresh,
        );
        launchControls = { hostId, itemKey: item.key, element };
        if (versionElement) inspector.append(versionElement);
        renderedInspector = { signature, versionElement };
      };

      const render = (snapshot: RendererConnectionSnapshot | null): void => {
        latestSnapshot = snapshot;
        if (!snapshot) {
          renderedHostId = null;
          renderedInspector = null;
          reconcileElementChildren(content, [empty]);
          return;
        }
        const selectedHost =
          (selectedHostId
            ? snapshot.hosts.find((host) => host.hostId === selectedHostId)
            : undefined) ??
          snapshot.hosts.find((host) => host.active) ??
          snapshot.hosts.find((host) => host.hostId === "local") ??
          snapshot.hosts[0];
        if (!selectedHost) return;
        selectedHostId = selectedHost.hostId;
        const syncStatus = groupPreference.syncStatus();
        const localUnsupported = snapshot.hosts.some(
          ({ hostId, directoryUnsupported }) => hostId === "local" && directoryUnsupported,
        );
        groupDisabled = localUnsupported || syncStatus === "loading" || syncStatus === "saving";
        if (groupDisabled && draggingAgent) {
          draggingAgent = null;
          clearDropIndicators();
        }
        syncMessage.hidden = !localUnsupported && syncStatus === "ready";
        syncMessage.textContent = localUnsupported
          ? selectedHost.hostId === "local"
            ? messages.connectionLocalHarnessUnsupported
            : messages.connectionGroupUnavailable
          : syncStatus === "error"
            ? messages.connectionGroupSyncFailed
            : syncStatus === "saving"
              ? messages.connectionGroupSaving
              : messages.connectionGroupLoading;

        const layoutFirstMount = content.children[0] !== layout;
        reconcileElementChildren(content, [layout]);

        let tabsChanged = tabs.children.length !== snapshot.hosts.length;
        const nextTabs = snapshot.hosts.map((host) => {
          let tab = hostTabElements.get(host.hostId);
          if (!tab) {
            tab = document.createElement("button");
            tab.type = "button";
            tab.className = "settings-connection-host-tab";
            tab.dataset.connectionHostTab = host.hostId;
            tab.setAttribute("role", "tab");
            tab.setAttribute("aria-controls", panelId);
            tab.addEventListener("click", () => {
              selectedHostId = host.hostId;
              render(latestSnapshot);
            });
            tab.addEventListener("keydown", (event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const hosts = latestSnapshot?.hosts ?? [];
              const index = hosts.findIndex((candidate) => candidate.hostId === host.hostId);
              if (index < 0) return;
              const direction = event.key === "ArrowRight" ? 1 : -1;
              const next = hosts[(index + direction + hosts.length) % hosts.length];
              if (!next) return;
              selectedHostId = next.hostId;
              render(latestSnapshot);
              hostTabElements.get(next.hostId)?.focus();
            });
            hostTabElements.set(host.hostId, tab);
            tabsChanged = true;
          }
          const isSelected = host.hostId === selectedHost.hostId;
          const activeValue = String(host.active);
          if (tab.dataset.connectionHostActive !== activeValue) {
            tab.dataset.connectionHostActive = activeValue;
          }
          const selectedValue = String(isSelected);
          if (tab.getAttribute("aria-selected") !== selectedValue) {
            tab.setAttribute("aria-selected", selectedValue);
          }
          const nextTabIndex = isSelected ? 0 : -1;
          if (tab.tabIndex !== nextTabIndex) {
            tab.tabIndex = nextTabIndex;
          }
          const hostName = hostNames.get(host.hostId) || connectionHostName(host.hostId, messages);
          if (tab.textContent !== hostName) {
            tab.textContent = hostName;
            tabsChanged = true;
          }
          const tabTitle = host.active
            ? `${hostName} · ${messages.connectionActiveHost}`
            : hostName;
          if (tab.title !== tabTitle) {
            tab.title = tabTitle;
          }
          return tab;
        });
        reconcileElementChildren(tabs, nextTabs);

        if (rows.dataset.connectionHost !== selectedHost.hostId) {
          rows.dataset.connectionHost = selectedHost.hostId;
        }

        const items = connectionItems(snapshot, selectedHost, messages, diagnostics).map(
          (item): ConnectionListItem => {
            const agent = item.agentSnapshot?.agent;
            if (!agent) return item;
            const state = installs?.get(selectedHost.hostId, agent);
            const availability = state?.status ?? item.availability;
            const updating = versions.isUpdating(selectedHost.hostId, agent);
            const version =
              updating ||
              (item.agentSnapshot?.availability !== "notInstalled" &&
                availability !== "installing" &&
                availability !== "checking")
                ? versions.get(selectedHost.hostId, agent, item.name)
                : undefined;
            return {
              ...item,
              ...(state ? { availability: state.status } : {}),
              ...(version ? { version } : {}),
              ...(version?.updating ? { availability: "updating" as const } : {}),
              ...(state?.error ? { installError: state.error } : {}),
              ...(diagnostics?.installation && harnessHasInstallCommands(item.agentSnapshot?.plugin)
                ? {
                    install: () => {
                      void installs?.install(selectedHost.hostId, agent);
                    },
                  }
                : {}),
            };
          },
        );
        if (!items.some((item) => item.key === selectedItemKey)) {
          const requestedFocus = pendingFocusAgent;
          pendingFocusAgent = null;
          selectedItemKey =
            (requestedFocus && items.some((item) => item.key === requestedFocus)
              ? requestedFocus
              : undefined) ??
            items.find(
              (item) => item.agentSnapshot?.availability === "notInstalled" || item.error !== null,
            )?.key ??
            items[0]?.key ??
            null;
        }

        let hostRows = hostRowViews.get(selectedHost.hostId);
        if (!hostRows) {
          hostRows = new Map();
          hostRowViews.set(selectedHost.hostId, hostRows);
        }
        currentHostRows = hostRows;

        const selectItem = (item: ConnectionListItem): void => {
          selectedItemKey = item.key;
          for (const [key, view] of currentHostRows) {
            view.setSelected(key === item.key);
          }
          syncSelectedInspector(selectedHost.hostId, item);
        };

        const ensureRowView = (key: string, groupable: boolean): ConnectionRowView => {
          let view = hostRows.get(key);
          if (!view) {
            view = createConnectionRowView(document, messages, groupable);
            hostRows.set(key, view);
          }
          return view;
        };

        const activeKeys = new Set<string>();
        const nextRowChildren: HTMLElement[] = [];

        const pinnedItems = items.filter((item) => item.agentSnapshot === undefined);
        for (const pinnedItem of pinnedItems) {
          activeKeys.add(pinnedItem.key);
          const view = ensureRowView(pinnedItem.key, false);
          view.update(
            pinnedItem,
            pinnedItem.key === selectedItemKey,
            () => selectItem(pinnedItem),
            null,
          );
          nextRowChildren.push(view.element);
        }

        // Only real, switchable external Agents participate in the
        // Main / More grouping — pinned entries above stay at the top.
        const groupableItems = items.filter(
          (item): item is ConnectionListItem & { agentSnapshot: RendererConnectionAgentSnapshot } =>
            item.agentSnapshot !== undefined,
        );
        const agentByKey = new Map(groupableItems.map((item) => [item.key, item]));
        currentCatalog = groupableItems.map((item) => ({ id: item.key, name: item.name }));

        // Preserve each Harness's last settled installation state while a refresh
        // temporarily reports "checking", avoiding Main <-> More layout jumps.
        const notInstalledAgents = new Set<ExternalRendererAgent>();
        for (const item of groupableItems) {
          const agent = item.agentSnapshot.agent;
          const stateKey = `${selectedHost.hostId}:${agent}`;
          if (item.agentSnapshot.availability !== "checking") {
            knownNotInstalled.set(stateKey, item.agentSnapshot.availability === "notInstalled");
          }
          const isNotInstalled =
            item.agentSnapshot.availability === "checking"
              ? (knownNotInstalled.get(stateKey) ?? false)
              : item.agentSnapshot.availability === "notInstalled";
          if (isNotInstalled) notInstalledAgents.add(agent);
        }

        const preferenceOrder = groupPreference
          .list(notInstalledAgents, currentCatalog)
          .filter((entry) => agentByKey.has(entry.agent));
        currentMainEntries = preferenceOrder.filter((entry) => entry.section === "main");
        currentMoreEntries = preferenceOrder.filter((entry) => entry.section === "more");

        const nextInSection = (
          section: AgentGroupSection,
          agent: ExternalRendererAgent,
        ): ExternalRendererAgent | null => {
          const sectionEntries = section === "main" ? currentMainEntries : currentMoreEntries;
          const index = sectionEntries.findIndex((entry) => entry.agent === agent);
          return index >= 0 ? (sectionEntries[index + 1]?.agent ?? null) : null;
        };

        const dropTargetSection = (
          agent: ExternalRendererAgent,
          event: DragEvent,
        ): { before: boolean; beforeAgent: ExternalRendererAgent | null } => {
          const row = currentHostRows.get(agent)?.element;
          const rect =
            row && typeof row.getBoundingClientRect === "function"
              ? row.getBoundingClientRect()
              : null;
          const before = rect ? event.clientY - rect.top < rect.height / 2 : true;
          const section = (row?.dataset.connectionGroupSection ?? "main") as AgentGroupSection;
          return { before, beforeAgent: before ? agent : nextInSection(section, agent) };
        };

        const createGroupController = (
          agent: ExternalRendererAgent,
          section: AgentGroupSection,
        ): ConnectionRowGroupController => ({
          disabled: groupDisabled,
          section,
          moveLabel:
            section === "main"
              ? messages.connectionGroupMoveToMore
              : messages.connectionGroupMoveToMain,
          dragHandleTitle: messages.connectionGroupDragHandle,
          toggleSection() {
            groupPreference.moveAgent(
              agent,
              section === "main" ? "more" : "main",
              null,
              currentCatalog,
            );
          },
          onDragStart(event) {
            if (groupDisabled) {
              event.preventDefault();
              return;
            }
            draggingAgent = agent;
            event.dataTransfer?.setData("text/plain", agent);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
            const row = currentHostRows.get(agent)?.element;
            if (row) row.dataset.connectionDragging = "true";
          },
          onDragOver(event) {
            if (!draggingAgent || draggingAgent === agent) return;
            event.preventDefault();
            const row = currentHostRows.get(agent)?.element;
            if (!row) return;
            const { before } = dropTargetSection(agent, event);
            clearDropIndicators();
            row.dataset.connectionDropIndicator = before ? "before" : "after";
          },
          onDragLeave() {
            const row = currentHostRows.get(agent)?.element;
            if (row) row.dataset.connectionDropIndicator = "";
          },
          onDrop(event) {
            event.preventDefault();
            if (groupDisabled || !draggingAgent) return;
            const { beforeAgent } = dropTargetSection(agent, event);
            groupPreference.moveAgent(draggingAgent, section, beforeAgent, currentCatalog);
            draggingAgent = null;
            clearDropIndicators();
          },
          onDragEnd() {
            draggingAgent = null;
            const row = currentHostRows.get(agent)?.element;
            if (row) row.dataset.connectionDragging = "false";
            clearDropIndicators();
            scheduleRender();
          },
        });

        for (const entry of currentMainEntries) {
          const item = agentByKey.get(entry.agent);
          if (!item) continue;
          activeKeys.add(item.key);
          const view = ensureRowView(item.key, true);
          view.update(
            item,
            item.key === selectedItemKey,
            () => selectItem(item),
            createGroupController(entry.agent, "main"),
          );
          nextRowChildren.push(view.element);
        }

        if (groupableItems.length > 0) {
          const dividerText = `${messages.connectionGroupMoreLabel} (${currentMoreEntries.length})`;
          if (groupDivider.textContent !== dividerText) {
            groupDivider.textContent = dividerText;
          }
          nextRowChildren.push(groupDivider);

          const nextMoreChildren: HTMLElement[] = [];
          if (currentMoreEntries.length === 0) {
            nextMoreChildren.push(moreHint);
          } else {
            for (const entry of currentMoreEntries) {
              const item = agentByKey.get(entry.agent);
              if (!item) continue;
              activeKeys.add(item.key);
              const view = ensureRowView(item.key, true);
              view.update(
                item,
                item.key === selectedItemKey,
                () => selectItem(item),
                createGroupController(entry.agent, "more"),
              );
              nextMoreChildren.push(view.element);
            }
          }
          if (!draggingAgent || renderedHostId !== selectedHost.hostId) {
            reconcileElementChildren(moreZone, nextMoreChildren);
          }
          nextRowChildren.push(moreZone);

          resetButton.disabled = groupDisabled;
          nextRowChildren.push(resetButton);
        }

        for (const key of hostRows.keys()) {
          if (!activeKeys.has(key)) hostRows.delete(key);
        }
        if (!draggingAgent || renderedHostId !== selectedHost.hostId) {
          reconcileElementChildren(rows, nextRowChildren);
        }

        const selectedItem = items.find((item) => item.key === selectedItemKey) ?? items[0];
        if (selectedItem) selectItem(selectedItem);

        updateControls.update(
          selectedHost.hostId,
          items.flatMap((item) => (item.version ? [item.version] : [])),
        );

        if (layoutFirstMount || tabsChanged) {
          hostScroller.update();
        }
        if (renderedHostId !== selectedHost.hostId) {
          renderedHostId = selectedHost.hostId;
          // Only move the horizontal Host strip when the selected Host changes;
          // scrollIntoView also scrolls ancestor containers and pulls the page to the top.
          const selectedTab = hostTabElements.get(selectedHost.hostId);
          if (selectedTab) {
            const left = selectedTab.offsetLeft;
            const right = left + selectedTab.offsetWidth;
            if (left < tabs.scrollLeft) tabs.scrollLeft = left;
            else if (right > tabs.scrollLeft + tabs.clientWidth) {
              tabs.scrollLeft = right - tabs.clientWidth;
            }
          }
        }
      };

      render(diagnostics?.snapshot() ?? null);
      void getRemoteConnections()
        ?.ssh.list(context.signal)
        .then(
          (connections) => {
            if (context.signal.aborted) return;
            for (const connection of connections) {
              hostNames.set(connection.hostId, connection.displayName.trim());
            }
            render(diagnostics?.snapshot() ?? null);
          },
          () => {
            /* Keep the Host ID fallback when native connection names are unavailable. */
          },
        );
      // Keep the Main / More grouping in sync with any other open picker or
      // settings instance (e.g. the Agent picker's "Manage" shortcut).
      const unsubscribeGroup = groupPreference.subscribe(scheduleRender);
      if (!diagnostics) {
        refresh.disabled = true;
        return () => {
          cancelRender();
          hostScroller.dispose();
          unsubscribeGroup();
        };
      }
      refresh.addEventListener("click", runRefresh);
      const unsubscribe = diagnostics.subscribe(scheduleRender);
      const unsubscribeInstalls = installs?.subscribe(scheduleRender);
      return () => {
        cancelRender();
        hostScroller.dispose();
        unsubscribeInstalls?.();
        unsubscribe();
        unsubscribeGroup();
      };
    },
  });
}
