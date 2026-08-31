import {
  THREAD_OWNERSHIP_LIST_MAX_LENGTH,
  hostThreadIdSchema,
  type ThreadOwnership,
} from "@codexhost/shared-contracts";

import type { RendererAgent } from "./agent-selection-state.js";
import { createRendererAgentIcon, RENDERER_AGENT_LABELS } from "./renderer-agent-icon.js";
import type { RendererModelClient } from "./renderer-model-client.js";

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
  render(agent: Exclude<RendererAgent, "codex">): void;
  clear(): void;
}

export interface SidebarAgentIconDom {
  rows(): readonly SidebarAgentIconRow[];
  observe(onChange: () => void): () => void;
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
  if (ownership.harnessId === "pi") return "pi";
  if (ownership.harnessId === "claude-code") return "claude-code";
  if (ownership.harnessId === "deepseek-harness") return "deepseek-harness";
  if (ownership.harnessId === "grok") return "grok";
  if (ownership.harnessId === "omp") return "omp";
  if (ownership.harnessId === "antigravity") return "antigravity";
  return null;
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

  render(agent: Exclude<RendererAgent, "codex">): void {
    const titleTrigger = this.element.querySelector<HTMLElement>("[data-thread-title-trigger]");
    const title = titleTrigger?.querySelector<HTMLElement>("[data-thread-title]");
    if (!titleTrigger || !title) {
      this.clear();
      return;
    }
    const icons = [
      ...this.element.querySelectorAll<HTMLElement>(`[${SIDEBAR_AGENT_ICON_ATTRIBUTE}]`),
    ];
    if (
      icons.length === 1 &&
      icons[0]?.parentElement === titleTrigger &&
      icons[0].getAttribute(SIDEBAR_AGENT_ICON_ATTRIBUTE) === agent
    ) {
      return;
    }
    this.clear();

    const label = `${RENDERER_AGENT_LABELS[agent]} Agent`;
    const marker = this.element.ownerDocument.createElement("span");
    marker.setAttribute(SIDEBAR_AGENT_ICON_ATTRIBUTE, agent);
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
    marker.append(createRendererAgentIcon(agent, 14, this.element.ownerDocument));
    titleTrigger.insertBefore(marker, title);
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

  constructor(private readonly root: HTMLElement) {}

  rows(): readonly SidebarAgentIconRow[] {
    for (const row of this.#trackedRows) {
      if (!row.isConnected()) this.#trackedRows.delete(row);
    }
    return [...this.root.querySelectorAll<HTMLElement>(SIDEBAR_THREAD_ROW_SELECTOR)].map(
      (element) => {
        let row = this.#rowsByElement.get(element);
        if (!row) {
          row = new BrowserSidebarAgentIconRow(element);
          this.#rowsByElement.set(element, row);
          this.#trackedRows.add(row);
        }
        return row;
      },
    );
  }

  observe(onChange: () => void): () => void {
    const observer = new MutationObserver(onChange);
    observer.observe(this.root, {
      attributes: true,
      attributeFilter: [SIDEBAR_THREAD_ID_ATTRIBUTE, SIDEBAR_THREAD_HOST_ID_ATTRIBUTE],
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
  getLocalAgent?(input: {
    hostId: string;
    threadId: string | null;
    draftId: string | null;
  }): RendererAgent | null;
  dom?: SidebarAgentIconDom;
}): RendererSidebarAgentIcons {
  const dom = options.dom ?? new BrowserSidebarAgentIconDom(document.documentElement);
  const ownershipByThread = new Map<string, Exclude<RendererAgent, "codex"> | null>();
  const pending = new Set<string>();
  const failed = new Set<string>();
  const provisionalCodex = new Set<string>();
  const ownershipRetryAttempts = new Map<string, number>();
  const ownershipRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;
  let scanScheduled = false;

  const ownershipKey = (hostId: string, threadId: string): string =>
    JSON.stringify([hostId, threadId]);

  const scheduleScan = (): void => {
    if (disposed || scanScheduled) return;
    scanScheduled = true;
    queueMicrotask(scan);
  };

  const clearOwnershipRetry = (key: string): void => {
    const timer = ownershipRetryTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    ownershipRetryTimers.delete(key);
    ownershipRetryAttempts.delete(key);
    provisionalCodex.delete(key);
  };

  const scheduleOwnershipRetry = (hostId: string, threadId: string): void => {
    const key = ownershipKey(hostId, threadId);
    if (
      disposed ||
      !provisionalCodex.has(key) ||
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
      scheduleScan();
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
      .catch(() => {
        if (disposed) return;
        for (const threadId of threadIds) failed.add(ownershipKey(hostId, threadId));
      })
      .finally(() => {
        for (const threadId of threadIds) pending.delete(ownershipKey(hostId, threadId));
        for (const threadId of threadIds) scheduleOwnershipRetry(hostId, threadId);
        if (succeeded) scheduleScan();
      });
  };

  const scan = (): void => {
    scanScheduled = false;
    if (disposed) return;
    const unresolvedByHost = new Map<string, Set<ReturnType<typeof hostThreadIdSchema.parse>>>();
    for (const row of dom.rows()) {
      if (!row.isConnected()) {
        row.clear();
        continue;
      }
      const hostId = row.hostId();
      if (!hostId) {
        row.clear();
        continue;
      }
      const threadId = hostThreadIdSchema.safeParse(row.threadId());
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
        else row.render(localAgent);
        continue;
      }
      if (!threadId.success) {
        row.clear();
        continue;
      }
      const key = ownershipKey(hostId, threadId.data);
      if (ownershipByThread.has(key)) {
        const agent = ownershipByThread.get(key);
        if (agent) row.render(agent);
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
      if (!client) continue;
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
  scan();

  return {
    refresh() {
      failed.clear();
      for (const key of provisionalCodex) {
        const timer = ownershipRetryTimers.get(key);
        if (timer !== undefined) clearTimeout(timer);
        ownershipRetryTimers.delete(key);
        ownershipRetryAttempts.delete(key);
        ownershipByThread.delete(key);
      }
      scheduleScan();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopObserving();
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
