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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function threadIdFromSidebarRowElement(element: HTMLElement): string | null {
  const taskKey = element.getAttribute(SIDEBAR_THREAD_ID_ATTRIBUTE);
  const hostId = element.getAttribute(SIDEBAR_THREAD_HOST_ID_ATTRIBUTE);
  const rowMarker = element.getAttribute(SIDEBAR_THREAD_ROW_ATTRIBUTE);
  if (taskKey === null || hostId === null || rowMarker === null) return null;

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

export interface SidebarAgentIconRow {
  isConnected(): boolean;
  threadId(): string | null;
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
  return null;
}

class BrowserSidebarAgentIconRow implements SidebarAgentIconRow {
  constructor(private readonly element: HTMLElement) {}

  isConnected(): boolean {
    return this.element.isConnected;
  }

  threadId(): string | null {
    return threadIdFromSidebarRowElement(this.element);
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
      attributeFilter: [SIDEBAR_THREAD_ID_ATTRIBUTE],
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
  getClient(): RendererModelClient | null;
  dom?: SidebarAgentIconDom;
}): RendererSidebarAgentIcons {
  const dom = options.dom ?? new BrowserSidebarAgentIconDom(document.documentElement);
  const ownershipByThread = new Map<string, Exclude<RendererAgent, "codex"> | null>();
  const pending = new Set<string>();
  const failed = new Set<string>();
  let disposed = false;
  let scanScheduled = false;

  const scheduleScan = (): void => {
    if (disposed || scanScheduled) return;
    scanScheduled = true;
    queueMicrotask(scan);
  };

  const requestOwnership = (
    threadIds: ReturnType<typeof hostThreadIdSchema.parse>[],
    client: RendererModelClient,
  ): void => {
    for (const threadId of threadIds) pending.add(threadId);
    let succeeded = false;
    void client
      .listThreadOwnership({ threadIds })
      .then(({ threads }) => {
        if (disposed) return;
        for (const ownership of threads) {
          ownershipByThread.set(ownership.threadId, rendererAgentForThreadOwnership(ownership));
          failed.delete(ownership.threadId);
        }
        succeeded = true;
      })
      .catch(() => {
        if (disposed) return;
        for (const threadId of threadIds) failed.add(threadId);
      })
      .finally(() => {
        for (const threadId of threadIds) pending.delete(threadId);
        if (succeeded) scheduleScan();
      });
  };

  const scan = (): void => {
    scanScheduled = false;
    if (disposed) return;
    const unresolved = new Set<ReturnType<typeof hostThreadIdSchema.parse>>();
    for (const row of dom.rows()) {
      const threadId = hostThreadIdSchema.safeParse(row.threadId());
      if (!row.isConnected() || !threadId.success) {
        row.clear();
        continue;
      }
      if (ownershipByThread.has(threadId.data)) {
        const agent = ownershipByThread.get(threadId.data);
        if (agent) row.render(agent);
        else row.clear();
        continue;
      }
      row.clear();
      if (!pending.has(threadId.data) && !failed.has(threadId.data)) {
        unresolved.add(threadId.data);
      }
    }
    const client = options.getClient();
    if (!client) return;
    const threadIds = [...unresolved];
    for (let index = 0; index < threadIds.length; index += THREAD_OWNERSHIP_LIST_MAX_LENGTH) {
      requestOwnership(threadIds.slice(index, index + THREAD_OWNERSHIP_LIST_MAX_LENGTH), client);
    }
  };

  const stopObserving = dom.observe(scheduleScan);
  scan();

  return {
    refresh() {
      failed.clear();
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
    },
  };
}
