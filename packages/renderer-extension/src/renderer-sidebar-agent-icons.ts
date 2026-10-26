import {
  THREAD_OWNERSHIP_LIST_MAX_LENGTH,
  hostThreadIdSchema,
  type ThreadOwnership,
} from "@codexhost/shared-contracts";

import type { RendererAgent } from "./agent-selection-state.js";
import type { HarnessPluginDescriptor } from "@codexhost/shared-contracts";
import { createRendererAgentIcon, rendererAgentLabel } from "./renderer-agent-icon.js";
import type { RendererModelClient } from "./renderer-model-client.js";
import { RendererMethodUnavailableError } from "./renderer-request-sender.js";

export const SIDEBAR_THREAD_ROW_ATTRIBUTE = "data-app-action-sidebar-thread-row";
export const SIDEBAR_THREAD_ROW_SELECTOR = `[${SIDEBAR_THREAD_ROW_ATTRIBUTE}]`;
export const SIDEBAR_THREAD_ID_ATTRIBUTE = "data-app-action-sidebar-thread-id";
export const SIDEBAR_THREAD_HOST_ID_ATTRIBUTE = "data-app-action-sidebar-thread-host-id";
export const SIDEBAR_AGENT_ICON_ATTRIBUTE = "data-codexhost-sidebar-agent-icon";

export interface RendererSidebarContractInspection {
  rowCount: number;
  titleOwnerCount: number;
  resolvedThreadCount: number;
  ambiguousThreadCount: number;
}

const OWNERSHIP_RETRY_DELAYS_MS = [100, 300, 800, 1_500, 3_000] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sidebarThreadAttributes(element: HTMLElement): {
  taskKey: string;
  hostId: string;
  rowMarker: string;
} | null {
  const taskKey = element.getAttribute(SIDEBAR_THREAD_ID_ATTRIBUTE);
  const hostId = element.getAttribute(SIDEBAR_THREAD_HOST_ID_ATTRIBUTE);
  const rowMarker = element.getAttribute(SIDEBAR_THREAD_ROW_ATTRIBUTE);
  if (taskKey === null || hostId === null || rowMarker === null) return null;
  return { taskKey, hostId, rowMarker };
}

export function draftIdFromSidebarRowElement(element: HTMLElement): string | null {
  const attributes = sidebarThreadAttributes(element);
  if (!attributes) return null;
  const hostPrefix = `${attributes.hostId}:`;
  const taskKey = attributes.taskKey.startsWith(hostPrefix)
    ? attributes.taskKey.slice(hostPrefix.length)
    : attributes.taskKey;
  return taskKey.startsWith("client-new-thread:") ? taskKey : null;
}

export function threadIdFromSidebarRowElement(element: HTMLElement): string | null {
  const attributes = sidebarThreadAttributes(element);
  if (!attributes) return null;
  const { taskKey, hostId, rowMarker } = attributes;

  const fiberNames = Object.getOwnPropertyNames(element).filter((name) =>
    name.startsWith("__reactFiber$"),
  );
  const fiberName = fiberNames[0];
  if (fiberNames.length !== 1 || !fiberName) return null;
  const firstFiber = Object.getOwnPropertyDescriptor(element, fiberName)?.value;
  if (!isRecord(firstFiber)) return null;

  const candidates = new Set<string>();
  let fiber: Record<string, unknown> | null = firstFiber;
  for (let depth = 0; fiber && depth < 12; depth += 1) {
    const props = fiber.memoizedProps;
    if (isRecord(props) && isRecord(props.dataAttributes)) {
      const dataAttributes = props.dataAttributes;
      const threadId = hostThreadIdSchema.safeParse(props.conversationId);
      if (
        threadId.success &&
        dataAttributes[SIDEBAR_THREAD_ROW_ATTRIBUTE] === rowMarker &&
        dataAttributes[SIDEBAR_THREAD_ID_ATTRIBUTE] === taskKey &&
        dataAttributes[SIDEBAR_THREAD_HOST_ID_ATTRIBUTE] === hostId
      ) {
        candidates.add(threadId.data);
      }
    }
    fiber = isRecord(fiber.return) ? fiber.return : null;
  }
  return candidates.size === 1 ? (candidates.values().next().value ?? null) : null;
}

export function inspectRendererSidebarContract(
  root: ParentNode = document,
): RendererSidebarContractInspection {
  const rows = [...root.querySelectorAll<HTMLElement>(SIDEBAR_THREAD_ROW_SELECTOR)];
  let titleOwnerCount = 0;
  let resolvedThreadCount = 0;
  let ambiguousThreadCount = 0;
  for (const row of rows) {
    const titleTrigger = row.querySelector<HTMLElement>("[data-thread-title-trigger]");
    const title = titleTrigger?.querySelector<HTMLElement>("[data-thread-title]");
    if (titleTrigger && title) titleOwnerCount += 1;
    const attributes = sidebarThreadAttributes(row);
    if (!attributes || attributes.taskKey.startsWith("client-new-thread:")) continue;
    if (threadIdFromSidebarRowElement(row) === null) ambiguousThreadCount += 1;
    else resolvedThreadCount += 1;
  }
  return {
    rowCount: rows.length,
    titleOwnerCount,
    resolvedThreadCount,
    ambiguousThreadCount,
  };
}

export interface SidebarAgentIconRow {
  isConnected(): boolean;
  hostId(): string | null;
  threadId(): string | null;
  draftId(): string | null;
  render(agent: Exclude<RendererAgent, "codex">, plugin?: HarnessPluginDescriptor): void;
  clear(): void;
}

export interface SidebarAgentIconDom {
  rows(): readonly SidebarAgentIconRow[];
  /** Report stable row handles for changed subtrees/identities, including removals. */
  observe(onChange: (rows: readonly SidebarAgentIconRow[]) => void): () => void;
  clear(): void;
}

export interface RendererSidebarAgentIcons {
  refresh(): void;
  dispose(): void;
}

export function rendererAgentForThreadOwnership(
  ownership: ThreadOwnership,
): Exclude<RendererAgent, "codex"> | null {
  if (ownership.owner === "codex") return null;
  return ownership.harnessId;
}

// Desktop wraps some titles (hover label, secondary line), so the title is not always a direct
// child of the trigger. Anchor the icon to the title's outermost wrapper that still sits in a
// horizontal flex row, keeping it on the title line.
function sidebarAgentIconAnchor(titleTrigger: HTMLElement, title: HTMLElement): HTMLElement {
  const view = title.ownerDocument.defaultView;
  let anchor = title;
  while (anchor.parentElement && anchor.parentElement !== titleTrigger) {
    const style = view?.getComputedStyle(anchor.parentElement);
    if (style?.display.includes("flex") && !style.flexDirection.startsWith("column")) break;
    anchor = anchor.parentElement;
  }
  return anchor;
}

class BrowserSidebarAgentIconRow implements SidebarAgentIconRow {
  constructor(private readonly element: HTMLElement) {}

  isConnected(): boolean {
    return this.element.isConnected;
  }

  hostId(): string | null {
    return sidebarThreadAttributes(this.element)?.hostId ?? null;
  }

  threadId(): string | null {
    return threadIdFromSidebarRowElement(this.element);
  }

  draftId(): string | null {
    return draftIdFromSidebarRowElement(this.element);
  }

  render(agent: Exclude<RendererAgent, "codex">, plugin?: HarnessPluginDescriptor): void {
    const presentation = JSON.stringify([agent, plugin?.name, plugin?.icon, plugin?.iconStyle]);
    const titleTrigger = this.element.querySelector<HTMLElement>("[data-thread-title-trigger]");
    const title = titleTrigger?.querySelector<HTMLElement>("[data-thread-title]");
    if (!titleTrigger || !title) {
      this.clear();
      return;
    }
    const anchor = sidebarAgentIconAnchor(titleTrigger, title);
    const icons = [
      ...this.element.querySelectorAll<HTMLElement>(`[${SIDEBAR_AGENT_ICON_ATTRIBUTE}]`),
    ];
    if (
      icons.length === 1 &&
      icons[0]?.nextElementSibling === anchor &&
      icons[0].getAttribute(SIDEBAR_AGENT_ICON_ATTRIBUTE) === agent &&
      icons[0].dataset.presentation === presentation
    ) {
      return;
    }
    this.clear();

    const label = `${rendererAgentLabel(agent, plugin)} Agent`;
    const marker = this.element.ownerDocument.createElement("span");
    marker.setAttribute(SIDEBAR_AGENT_ICON_ATTRIBUTE, agent);
    marker.dataset.presentation = presentation;
    marker.setAttribute("role", "img");
    marker.setAttribute("aria-label", label);
    marker.title = label;
    marker.style.display = "inline-flex";
    marker.style.alignItems = "center";
    marker.style.justifyContent = "center";
    marker.style.width = "14px";
    marker.style.height = "14px";
    marker.style.flex = "none";
    marker.style.pointerEvents = "none";
    marker.append(createRendererAgentIcon(agent, 14, this.element.ownerDocument, plugin));
    anchor.before(marker);
  }

  clear(): void {
    for (const icon of this.element.querySelectorAll(`[${SIDEBAR_AGENT_ICON_ATTRIBUTE}]`)) {
      icon.remove();
    }
  }
}

class BrowserSidebarAgentIconDom implements SidebarAgentIconDom {
  readonly #rowsByElement = new WeakMap<HTMLElement, BrowserSidebarAgentIconRow>();
  readonly #trackedRows = new Set<BrowserSidebarAgentIconRow>();

  constructor(private readonly root: ParentNode & Node) {}

  #row(element: HTMLElement): BrowserSidebarAgentIconRow {
    let row = this.#rowsByElement.get(element);
    if (!row) {
      row = new BrowserSidebarAgentIconRow(element);
      this.#rowsByElement.set(element, row);
    }
    if (element.isConnected && element.matches(SIDEBAR_THREAD_ROW_SELECTOR))
      this.#trackedRows.add(row);
    else this.#trackedRows.delete(row);
    return row;
  }

  rows(): readonly SidebarAgentIconRow[] {
    for (const row of this.#trackedRows) {
      if (!row.isConnected()) this.#trackedRows.delete(row);
    }
    return [...this.root.querySelectorAll<HTMLElement>(SIDEBAR_THREAD_ROW_SELECTOR)].map(
      (element) => this.#row(element),
    );
  }

  observe(onChange: (rows: readonly SidebarAgentIconRow[]) => void): () => void {
    const observer = new MutationObserver((mutations) => {
      const changed = new Set<SidebarAgentIconRow>();
      const collect = (node: Node): void => {
        if (!(node instanceof Element)) return;
        if (node.matches(SIDEBAR_THREAD_ROW_SELECTOR)) changed.add(this.#row(node as HTMLElement));
        for (const element of node.querySelectorAll<HTMLElement>(SIDEBAR_THREAD_ROW_SELECTOR))
          changed.add(this.#row(element));
      };
      for (const mutation of mutations) {
        const target =
          mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        const row = target?.closest<HTMLElement>(SIDEBAR_THREAD_ROW_SELECTOR);
        if (row) changed.add(this.#row(row));
        // Removing the row marker must also clear its old decoration and identity.
        else if (target && this.#rowsByElement.has(target as HTMLElement))
          changed.add(this.#row(target as HTMLElement));
        for (const node of mutation.addedNodes) collect(node);
        for (const node of mutation.removedNodes) collect(node);
      }
      if (changed.size) onChange([...changed]);
    });
    observer.observe(this.root, {
      attributes: true,
      attributeFilter: [
        SIDEBAR_THREAD_ROW_ATTRIBUTE,
        SIDEBAR_THREAD_ID_ATTRIBUTE,
        SIDEBAR_THREAD_HOST_ID_ATTRIBUTE,
      ],
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }

  clear(): void {
    for (const row of this.#trackedRows) row.clear();
    this.#trackedRows.clear();
  }
}

export function installRendererSidebarAgentIcons(options: {
  getClient(hostId: string): RendererModelClient | null;
  getPlugins?(hostId: string): readonly HarnessPluginDescriptor[] | undefined;
  getLocalAgent?(input: {
    hostId: string;
    threadId: string | null;
    draftId: string | null;
  }): RendererAgent | null;
  dom?: SidebarAgentIconDom;
}): RendererSidebarAgentIcons {
  const dom = options.dom ?? new BrowserSidebarAgentIconDom(document);
  const ownershipByThread = new Map<string, Exclude<RendererAgent, "codex"> | null>();
  const pending = new Set<string>();
  const failed = new Set<string>();
  const provisionalCodex = new Set<string>();
  const ownershipRetryAttempts = new Map<string, number>();
  const ownershipRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const dirtyRows = new Set<SidebarAgentIconRow>();
  // Index mounted row identities so replies/retries update only the affected
  // Thread, including duplicate rows, without retaining stale recycled identities.
  const rowsByThread = new Map<string, Set<SidebarAgentIconRow>>();
  const threadByRow = new WeakMap<SidebarAgentIconRow, string>();
  let disposed = false;
  let scanScheduled = false;

  const ownershipKey = (hostId: string, threadId: string): string =>
    JSON.stringify([hostId, threadId]);

  const scheduleScan = (rows: Iterable<SidebarAgentIconRow>): void => {
    if (disposed) return;
    for (const row of rows) dirtyRows.add(row);
    if (scanScheduled || dirtyRows.size === 0) return;
    scanScheduled = true;
    requestAnimationFrame(scan);
  };

  const trackRowThread = (row: SidebarAgentIconRow, key?: string): void => {
    const previous = threadByRow.get(row);
    if (previous === key) return;
    if (previous !== undefined) {
      const rows = rowsByThread.get(previous);
      rows?.delete(row);
      if (rows?.size === 0) rowsByThread.delete(previous);
      threadByRow.delete(row);
    }
    if (key !== undefined) {
      let rows = rowsByThread.get(key);
      if (!rows) rowsByThread.set(key, (rows = new Set()));
      rows.add(row);
      threadByRow.set(row, key);
    }
  };

  const clearOwnershipRetry = (key: string): void => {
    const timer = ownershipRetryTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    ownershipRetryTimers.delete(key);
    ownershipRetryAttempts.delete(key);
    failed.delete(key);
    provisionalCodex.delete(key);
  };

  const scheduleOwnershipRetry = (hostId: string, threadId: string): void => {
    const key = ownershipKey(hostId, threadId);
    if (
      disposed ||
      (!failed.has(key) && !provisionalCodex.has(key)) ||
      pending.has(key) ||
      ownershipRetryTimers.has(key)
    ) {
      return;
    }
    const attempt = ownershipRetryAttempts.get(key) ?? 0;
    const delay = OWNERSHIP_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) return;
    ownershipRetryAttempts.set(key, attempt + 1);
    const timer = setTimeout(() => {
      ownershipRetryTimers.delete(key);
      if (disposed) return;
      failed.delete(key);
      ownershipByThread.delete(key);
      scheduleScan(rowsByThread.get(key) ?? []);
    }, delay);
    ownershipRetryTimers.set(key, timer);
  };

  const requestOwnership = (
    hostId: string,
    threadIds: ReturnType<typeof hostThreadIdSchema.parse>[],
    client: RendererModelClient,
  ): void => {
    for (const threadId of threadIds) pending.add(ownershipKey(hostId, threadId));
    let succeeded = false;
    let retryable = true;
    void Promise.resolve()
      .then(() => client.listThreadOwnership({ threadIds }))
      .then(({ threads }) => {
        if (disposed) return;
        for (const ownership of threads) {
          const key = ownershipKey(hostId, ownership.threadId);
          ownershipByThread.set(key, rendererAgentForThreadOwnership(ownership));
          failed.delete(key);
          if (ownership.owner === "codex") {
            provisionalCodex.add(key);
            scheduleOwnershipRetry(hostId, ownership.threadId);
          } else {
            clearOwnershipRetry(key);
          }
        }
        succeeded = true;
      })
      .catch((error) => {
        if (disposed) return;
        retryable = !(error instanceof RendererMethodUnavailableError);
        for (const threadId of threadIds) failed.add(ownershipKey(hostId, threadId));
      })
      .finally(() => {
        for (const threadId of threadIds) pending.delete(ownershipKey(hostId, threadId));
        if (retryable) {
          for (const threadId of threadIds) scheduleOwnershipRetry(hostId, threadId);
        }
        if (succeeded) {
          for (const threadId of threadIds)
            scheduleScan(rowsByThread.get(ownershipKey(hostId, threadId)) ?? []);
        }
      });
  };

  const scan = (): void => {
    scanScheduled = false;
    if (disposed) return;
    const rows = [...dirtyRows];
    dirtyRows.clear();
    const unresolvedByHost = new Map<string, Set<ReturnType<typeof hostThreadIdSchema.parse>>>();
    // Host discovery walks the native React tree. Read artwork once per Host in
    // this synchronous scan, never retain it across frames or connection changes.
    const pluginsByHost = new Map<string, readonly HarnessPluginDescriptor[] | undefined>();
    const getPlugin = (hostId: string, agent: string): HarnessPluginDescriptor | undefined => {
      if (!pluginsByHost.has(hostId)) pluginsByHost.set(hostId, options.getPlugins?.(hostId));
      return pluginsByHost.get(hostId)?.find(({ id }) => id === agent);
    };
    for (const row of rows) {
      if (!row.isConnected()) {
        trackRowThread(row);
        row.clear();
        continue;
      }
      const hostId = row.hostId();
      if (!hostId) {
        trackRowThread(row);
        row.clear();
        continue;
      }
      const threadId = hostThreadIdSchema.safeParse(row.threadId());
      trackRowThread(row, threadId.success ? ownershipKey(hostId, threadId.data) : undefined);
      const localAgent = options.getLocalAgent?.({
        hostId,
        threadId: threadId.success ? threadId.data : null,
        draftId: row.draftId(),
      });
      if (localAgent !== null && localAgent !== undefined) {
        if (threadId.success) {
          const key = ownershipKey(hostId, threadId.data);
          ownershipByThread.set(key, localAgent === "codex" ? null : localAgent);
          clearOwnershipRetry(key);
        }
        if (localAgent === "codex") row.clear();
        else row.render(localAgent, getPlugin(hostId, localAgent));
        continue;
      }
      if (!threadId.success) {
        row.clear();
        continue;
      }
      const key = ownershipKey(hostId, threadId.data);
      if (ownershipByThread.has(key)) {
        const agent = ownershipByThread.get(key);
        if (agent) row.render(agent, getPlugin(hostId, agent));
        else row.clear();
        continue;
      }
      row.clear();
      if (!pending.has(key) && !failed.has(key)) {
        let unresolved = unresolvedByHost.get(hostId);
        if (!unresolved) {
          unresolved = new Set();
          unresolvedByHost.set(hostId, unresolved);
        }
        unresolved.add(threadId.data);
      }
    }
    for (const [hostId, unresolved] of unresolvedByHost) {
      const client = options.getClient(hostId);
      if (!client) {
        for (const threadId of unresolved) {
          const key = ownershipKey(hostId, threadId);
          failed.add(key);
          scheduleOwnershipRetry(hostId, threadId);
        }
        continue;
      }
      const threadIds = [...unresolved];
      for (let index = 0; index < threadIds.length; index += THREAD_OWNERSHIP_LIST_MAX_LENGTH) {
        requestOwnership(
          hostId,
          threadIds.slice(index, index + THREAD_OWNERSHIP_LIST_MAX_LENGTH),
          client,
        );
      }
    }
  };

  const stopObserving = dom.observe(scheduleScan);
  for (const row of dom.rows()) dirtyRows.add(row);
  scan();

  return {
    refresh() {
      if (disposed) return;
      failed.clear();
      for (const timer of ownershipRetryTimers.values()) clearTimeout(timer);
      ownershipRetryTimers.clear();
      ownershipRetryAttempts.clear();
      for (const key of provisionalCodex) ownershipByThread.delete(key);
      provisionalCodex.clear();
      scheduleScan(dom.rows());
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopObserving();
      for (const row of dirtyRows) row.clear();
      dirtyRows.clear();
      rowsByThread.clear();
      dom.clear();
      ownershipByThread.clear();
      pending.clear();
      failed.clear();
      provisionalCodex.clear();
      for (const timer of ownershipRetryTimers.values()) clearTimeout(timer);
      ownershipRetryTimers.clear();
      ownershipRetryAttempts.clear();
    },
  };
}
