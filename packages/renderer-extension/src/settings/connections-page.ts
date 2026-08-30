import type { CodexhostError } from "@codexhost/shared-contracts";

import type { ExternalRendererAgent, RendererAgentAvailability } from "../agent-selection-state.js";
import { createRendererAgentIcon, RENDERER_AGENT_LABELS } from "../renderer-agent-icon.js";
import type { RendererAdapterStatus } from "../versioned-renderer-adapter.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

export const CODEXHOST_GITHUB_ISSUES_NEW_URL =
  "https://github.com/BytePioneer-AI/codex-host/issues/new";

const HARNESS_INSTALL_URLS: Readonly<Record<ExternalRendererAgent, string>> = Object.freeze({
  pi: "https://pi.dev/",
  "claude-code": "https://code.claude.com/docs/en/quickstart",
  "deepseek-harness": "https://deepseek-harness.github.io/deepseek-harness/",
  grok: "https://grok.com/",
  omp: "https://github.com/can1357/oh-my-pi",
});

export interface RendererConnectionAgentSnapshot {
  readonly agent: ExternalRendererAgent;
  readonly availability: RendererAgentAvailability;
  readonly error: CodexhostError | null;
}

export interface RendererConnectionHostSnapshot {
  readonly hostId: string;
  readonly active: boolean;
  readonly agents: readonly RendererConnectionAgentSnapshot[];
}

export interface RendererConnectionSnapshot {
  readonly adapter: RendererAdapterStatus;
  readonly hosts: readonly RendererConnectionHostSnapshot[];
}

export interface RendererConnectionDiagnostics {
  snapshot(): RendererConnectionSnapshot;
  refresh(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

type ConnectionAvailability = RendererAgentAvailability | RendererAdapterStatus["state"];
type ConnectionTone = "ready" | "checking" | "setup" | "failed";

interface ConnectionListItem {
  readonly key: string;
  readonly name: string;
  readonly availability: ConnectionAvailability;
  readonly error: CodexhostError | null;
  readonly agentSnapshot?: RendererConnectionAgentSnapshot;
}

function connectionStatusLabel(
  availability: ConnectionAvailability,
  messages: RendererSettingsMessages,
  hasError = false,
): string {
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

function connectionStatusTone(
  availability: ConnectionAvailability,
  hasError = false,
): ConnectionTone {
  if (hasError && availability !== "notInstalled") return "failed";
  if (availability === "ready") return "ready";
  if (availability === "checking" || availability === "installing") return "checking";
  if (availability === "notInstalled") return "setup";
  return "failed";
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

function detailLine(document: Document, label: string, value: string): HTMLElement {
  const line = document.createElement("div");
  line.className = "settings-connection-detail-line";
  const name = document.createElement("span");
  name.textContent = label;
  const content = document.createElement("code");
  content.textContent = value;
  line.append(name, content);
  return line;
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

function connectionHostName(hostId: string, messages: RendererSettingsMessages): string {
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
): () => void {
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
  ownerWindow?.setTimeout(updateButtons, 0);
  updateButtons();
  return () => {
    left.removeEventListener("click", onLeft);
    right.removeEventListener("click", onRight);
    tabs.removeEventListener("scroll", updateButtons);
    tabs.removeEventListener("wheel", onWheel);
    ownerWindow?.removeEventListener("resize", updateButtons);
  };
}

function createConnectionIdentityIcon(
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
    container.append(createRendererAgentIcon(item.agentSnapshot.agent, size, document));
  } else {
    container.textContent = "CH";
  }
  return container;
}

function createConnectionRow(
  document: Document,
  item: ConnectionListItem,
  messages: RendererSettingsMessages,
  selected: boolean,
  select: () => void,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "settings-connection-row";
  row.dataset.connectionItem = item.key;
  row.dataset.connectionSelected = String(selected);
  row.tabIndex = selected ? 0 : -1;
  row.setAttribute("role", "row");

  const identity = document.createElement("div");
  identity.className = "settings-connection-row__identity";
  identity.setAttribute("role", "cell");
  const label = document.createElement("strong");
  label.textContent = item.name;
  identity.append(createConnectionIdentityIcon(document, item, 19), label);

  const status = document.createElement("span");
  status.className = "settings-connection-row__status";
  status.dataset.connectionTone = connectionStatusTone(item.availability, item.error !== null);
  status.setAttribute("role", "cell");
  status.textContent = connectionStatusLabel(item.availability, messages, item.error !== null);

  const action = document.createElement("div");
  action.className = "settings-connection-row__action";
  action.setAttribute("role", "cell");
  if (item.agentSnapshot?.availability === "notInstalled") {
    const install = document.createElement("a");
    install.className = "settings-connection-install-link";
    install.href = HARNESS_INSTALL_URLS[item.agentSnapshot.agent];
    install.target = "_blank";
    install.rel = "noopener noreferrer";
    install.setAttribute("aria-label", `${messages.connectionOpenInstallation}: ${item.name}`);
    install.title = messages.connectionOpenInstallation;
    install.append(createRendererSettingsIcon("download", 17));
    action.append(install);
  } else if (item.error) {
    const viewError = document.createElement("button");
    viewError.type = "button";
    viewError.className = "settings-connection-view-error";
    viewError.textContent = messages.connectionViewError;
    viewError.addEventListener("click", (event) => {
      event.stopPropagation();
      select();
    });
    action.append(viewError);
  }

  row.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (target?.closest?.("a")) return;
    select();
  });
  row.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    select();
  });
  row.append(identity, status, action);
  return row;
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
  const status = document.createElement("span");
  status.className = "settings-connection-row__status";
  status.dataset.connectionTone = connectionStatusTone(item.availability, item.error !== null);
  status.textContent = connectionStatusLabel(item.availability, messages, item.error !== null);
  header.append(identity, status);
  return header;
}

function renderConnectionInspector(
  document: Document,
  inspector: HTMLElement,
  item: ConnectionListItem,
  hostId: string,
  messages: RendererSettingsMessages,
): void {
  inspector.replaceChildren(createInspectorHeader(document, item, messages));
  const body = document.createElement("div");
  body.className = "settings-connection-inspector__body";

  if (item.agentSnapshot?.availability === "notInstalled") {
    const callout = document.createElement("div");
    callout.className = "settings-connection-install-callout";
    const icon = document.createElement("span");
    icon.className = "settings-connection-install-callout__icon";
    icon.append(createRendererSettingsIcon("download", 18));
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `${messages.connectionInstall} ${item.name}`;
    const description = document.createElement("p");
    description.textContent = messages.connectionInstallDescription;
    copy.append(title, description);
    callout.append(icon, copy);
    const install = document.createElement("a");
    install.className = "settings-command-button settings-connection-install-button";
    install.href = HARNESS_INSTALL_URLS[item.agentSnapshot.agent];
    install.target = "_blank";
    install.rel = "noopener noreferrer";
    install.append(
      messages.connectionOpenInstallation,
      createRendererSettingsIcon("external-link", 14),
    );
    body.append(callout, install);
  } else if (item.error) {
    const summary = document.createElement("div");
    summary.className = "settings-connection-error-summary";
    const title = document.createElement("strong");
    title.textContent = messages.connectionErrorTitle;
    const description = document.createElement("p");
    description.textContent = item.error.message;
    summary.append(title, description);

    const metadata = document.createElement("div");
    metadata.className = "settings-connection-error-metadata";
    metadata.append(
      detailLine(document, messages.connectionErrorCode, item.error.code),
      detailLine(document, messages.connectionRetryable, String(item.error.retryable)),
    );
    if (item.error.stage) {
      metadata.append(detailLine(document, messages.connectionFailureStage, item.error.stage));
    }
    if (item.error.durationMs !== undefined) {
      metadata.append(
        detailLine(document, messages.connectionDuration, `${item.error.durationMs} ms`),
      );
    }
    if (item.error.diagnostic) {
      metadata.append(detailLine(document, messages.connectionDiagnostic, item.error.diagnostic));
    }

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
    log.textContent = item.error.stderrTail ?? item.error.diagnostic ?? report;

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
    body.append(summary, metadata, logHeader, log, actions, issueNote);
  } else {
    const status = document.createElement("div");
    status.className = "settings-connection-state-summary";
    const title = document.createElement("strong");
    title.textContent = connectionStatusLabel(item.availability, messages);
    const description = document.createElement("p");
    description.textContent =
      item.availability === "ready"
        ? messages.connectionReadyDescription
        : messages.connectionUnavailableDescription;
    status.append(title, description);
    body.append(status);
  }

  inspector.append(body);
}

function connectionItems(
  snapshot: RendererConnectionSnapshot,
  host: RendererConnectionHostSnapshot,
  messages: RendererSettingsMessages,
): ConnectionListItem[] {
  return [
    {
      key: "renderer-adapter",
      name: messages.connectionAdapter,
      availability: snapshot.adapter.state,
      error: null,
    },
    ...host.agents.map((agent): ConnectionListItem => ({
      key: agent.agent,
      name: RENDERER_AGENT_LABELS[agent.agent],
      availability: agent.availability,
      error: agent.availability === "notInstalled" ? null : agent.error,
      agentSnapshot: agent,
    })),
  ];
}

export function createConnectionsSettingsPage(
  messages: RendererSettingsMessages,
  getDiagnostics: () => RendererConnectionDiagnostics | null,
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
      context.content.append(header, content);

      let pending = false;
      let selectedHostId: string | null = null;
      let selectedItemKey: string | null = null;
      let latestSnapshot: RendererConnectionSnapshot | null = null;
      let disposeHostScroller = (): void => undefined;

      const diagnostics = getDiagnostics();
      const runRefresh = (): void => {
        if (pending || !diagnostics) return;
        pending = true;
        refresh.disabled = true;
        refresh.replaceChildren(
          createRendererSettingsIcon("diagnose", 16),
          messages.connectionRefreshing,
        );
        void context.runLatest(() => diagnostics.refresh(), {
          success() {
            pending = false;
            refresh.disabled = false;
            refresh.replaceChildren(
              createRendererSettingsIcon("diagnose", 16),
              messages.connectionRefresh,
            );
            render(diagnostics.snapshot());
          },
          failure(error) {
            pending = false;
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

      const render = (snapshot: RendererConnectionSnapshot | null): void => {
        latestSnapshot = snapshot;
        disposeHostScroller();
        disposeHostScroller = () => undefined;
        content.replaceChildren();
        if (!snapshot) {
          const empty = document.createElement("div");
          empty.className = "settings-empty";
          empty.textContent = messages.connectionNoRuntime;
          content.append(empty);
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
        const panelId = "codexhost-settings-connection-host-panel";

        snapshot.hosts.forEach((host, index) => {
          const tab = document.createElement("button");
          tab.type = "button";
          tab.className = "settings-connection-host-tab";
          tab.dataset.connectionHostTab = host.hostId;
          tab.dataset.connectionHostActive = String(host.active);
          tab.setAttribute("role", "tab");
          tab.setAttribute("aria-controls", panelId);
          tab.setAttribute("aria-selected", String(host.hostId === selectedHost.hostId));
          tab.tabIndex = host.hostId === selectedHost.hostId ? 0 : -1;
          const hostName = connectionHostName(host.hostId, messages);
          tab.textContent = hostName;
          tab.title = host.active ? `${hostName} · ${messages.connectionActiveHost}` : hostName;
          tab.addEventListener("click", () => {
            selectedHostId = host.hostId;
            render(latestSnapshot);
          });
          tab.addEventListener("keydown", (event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const direction = event.key === "ArrowRight" ? 1 : -1;
            const next =
              snapshot.hosts[(index + direction + snapshot.hosts.length) % snapshot.hosts.length];
            if (!next) return;
            selectedHostId = next.hostId;
            render(latestSnapshot);
            const nextTab = [
              ...content.querySelectorAll<HTMLButtonElement>("[data-connection-host-tab]"),
            ].find((candidate) => candidate.dataset.connectionHostTab === next.hostId);
            nextTab?.focus();
          });
          tabs.append(tab);
        });
        hostStrip.append(scrollLeft, tabs, scrollRight);

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
        rows.dataset.connectionHost = selectedHost.hostId;
        rows.setAttribute("role", "rowgroup");
        const inspector = document.createElement("aside");
        inspector.className = "settings-connection-inspector";
        inspector.setAttribute("aria-live", "polite");
        const items = connectionItems(snapshot, selectedHost, messages);
        if (!items.some((item) => item.key === selectedItemKey)) {
          selectedItemKey =
            items.find(
              (item) => item.agentSnapshot?.availability === "notInstalled" || item.error !== null,
            )?.key ??
            items[0]?.key ??
            null;
        }
        const rowElements = new Map<string, HTMLElement>();
        const selectItem = (item: ConnectionListItem): void => {
          selectedItemKey = item.key;
          for (const [key, row] of rowElements) {
            const selected = key === item.key;
            row.dataset.connectionSelected = String(selected);
            row.tabIndex = selected ? 0 : -1;
          }
          renderConnectionInspector(document, inspector, item, selectedHost.hostId, messages);
        };
        for (const item of items) {
          const row = createConnectionRow(
            document,
            item,
            messages,
            item.key === selectedItemKey,
            () => selectItem(item),
          );
          rowElements.set(item.key, row);
          rows.append(row);
        }
        const selectedItem = items.find((item) => item.key === selectedItemKey) ?? items[0];
        if (selectedItem) selectItem(selectedItem);
        list.append(hostStrip, tableHeader, rows);
        layout.append(list, inspector);
        content.append(layout);
        disposeHostScroller = configureHostScroller(
          document,
          hostStrip,
          tabs,
          scrollLeft,
          scrollRight,
        );
        const selectedTab = [...tabs.children].find(
          (child) => child.getAttribute("aria-selected") === "true",
        ) as HTMLElement | undefined;
        selectedTab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      };

      render(diagnostics?.snapshot() ?? null);
      if (!diagnostics) {
        refresh.disabled = true;
        return undefined;
      }
      refresh.addEventListener("click", runRefresh);
      const unsubscribe = diagnostics.subscribe(() => render(diagnostics.snapshot()));
      return () => {
        disposeHostScroller();
        unsubscribe();
      };
    },
  });
}
