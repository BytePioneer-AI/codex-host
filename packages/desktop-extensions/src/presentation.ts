import type {
  DesktopExtensionApiV1,
  DesktopSidebarRow,
  ThreadTreeNode,
  ThreadTreeStatus,
} from "@codexhost/shared-contracts";

export const SIDEBAR_AGENT_ICON_SELECTOR = "[data-codexhost-sidebar-agent-icon]";
export const EXTENSION_NODE_ATTRIBUTE = "data-cx-extension-node";

export const statusPriority: Record<ThreadTreeStatus, number> = {
  waiting: 0,
  running: 1,
  unknown: 2,
  idle: 3,
};

const statusLabelsEn: Record<ThreadTreeStatus, string> = {
  waiting: "Needs input",
  running: "Running",
  unknown: "Unknown",
  idle: "Idle",
};

const statusLabelsZh: Record<ThreadTreeStatus, string> = {
  waiting: "待回答",
  running: "运行中",
  unknown: "状态未知",
  idle: "无活动",
};

export function isZhDocument(doc: Document): boolean {
  const lang = doc.documentElement.lang.trim() || doc.defaultView?.navigator.language || "";
  return /^zh\b/iu.test(lang);
}

export function localizedStatusLabel(status: ThreadTreeStatus, zh: boolean): string {
  return zh ? statusLabelsZh[status] : statusLabelsEn[status];
}

export function findSidebarAgentIcon(rowElement: HTMLElement): HTMLElement | null {
  const icon = rowElement.querySelector<HTMLElement>(SIDEBAR_AGENT_ICON_SELECTOR);
  return icon && rowElement.contains(icon) ? icon : null;
}

export function markExtensionNode<T extends Element>(node: T): T {
  node.setAttribute(EXTENSION_NODE_ATTRIBUTE, "");
  return node;
}

export function stopRowPointerPropagation(element: HTMLElement, signal: AbortSignal): void {
  const stop = (event: Event) => {
    event.stopPropagation();
  };
  element.addEventListener("pointerdown", stop, { signal });
  element.addEventListener("mousedown", stop, { signal });
}

export function collectSidebarIcons(rows: readonly DesktopSidebarRow[]): Map<string, Element> {
  const icons = new Map<string, Element>();
  for (const row of rows) {
    if (!row.isConnected()) continue;
    const iconHost = findSidebarAgentIcon(row.element);
    if (!iconHost) continue;
    const harnessId = iconHost.getAttribute("data-codexhost-sidebar-agent-icon");
    if (!harnessId || icons.has(harnessId)) continue;
    const graphic = iconHost.querySelector(":scope > img, :scope > svg");
    if (graphic) icons.set(harnessId, graphic);
  }
  return icons;
}

export function createThreadIcon(
  api: DesktopExtensionApiV1,
  doc: Document,
  harnessId: string,
  sidebarIcons?: ReadonlyMap<string, Element>,
): HTMLElement {
  const wrap = doc.createElement("span");
  wrap.className = "cx-thread-icon";
  wrap.setAttribute("aria-hidden", "true");

  const harness = api.harnesses.describe(harnessId);
  if (harness?.icon) {
    const img = doc.createElement("img");
    img.src = harness.icon;
    img.alt = "";
    img.draggable = false;
    wrap.append(img);
    return wrap;
  }

  const sampled = sidebarIcons?.get(harnessId);
  if (sampled) {
    if (sampled.tagName.toLowerCase() === "img") {
      const src = sampled.getAttribute("src");
      if (src) {
        const img = doc.createElement("img");
        img.src = src;
        img.alt = "";
        img.draggable = false;
        wrap.append(img);
        return wrap;
      }
    } else if (sampled.tagName.toLowerCase() === "svg") {
      const clone = sampled.cloneNode(true) as SVGElement;
      clone.removeAttribute("style");
      wrap.append(clone);
      return wrap;
    }
  }

  wrap.classList.add("cx-thread-icon-fallback");
  const label = harness?.name || harnessId;
  wrap.textContent = label.slice(0, 1).toUpperCase();
  return wrap;
}

export function threadAccessibleTitle(
  api: DesktopExtensionApiV1,
  threadId: string,
  thread: ThreadTreeNode,
  zh: boolean,
): string {
  const harness = api.harnesses.describe(thread.harnessId);
  const title = thread.title || threadId;
  return `${title} — ${harness?.name ?? thread.harnessId} · ${localizedStatusLabel(thread.status, zh)}`;
}

export function createRowIconObserverManager(
  api: DesktopExtensionApiV1,
  onRelevantMutation: () => void,
): { sync(targets: ReadonlySet<HTMLElement>): void } {
  const observers = new Map<HTMLElement, MutationObserver>();
  let scheduled = false;

  const isExtensionOnlyNode = (node: Node): boolean =>
    node instanceof Element &&
    (node.hasAttribute(EXTENSION_NODE_ATTRIBUTE) ||
      Boolean(node.closest(`[${EXTENSION_NODE_ATTRIBUTE}]`)));

  const isRelevant = (mutations: readonly MutationRecord[]): boolean => {
    for (const mutation of mutations) {
      if (isExtensionOnlyNode(mutation.target)) continue;
      for (const node of mutation.addedNodes) {
        if (!isExtensionOnlyNode(node)) return true;
      }
      for (const node of mutation.removedNodes) {
        if (!isExtensionOnlyNode(node)) return true;
      }
    }
    return false;
  };

  const schedule = () => {
    if (scheduled || api.signal.aborted) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (api.signal.aborted) return;
      onRelevantMutation();
    });
  };

  const disconnectAll = () => {
    for (const observer of observers.values()) observer.disconnect();
    observers.clear();
  };

  api.track(disconnectAll);
  api.signal.addEventListener("abort", disconnectAll, { once: true });

  return {
    sync(targets) {
      if (api.signal.aborted) return;
      for (const [element, observer] of observers) {
        if (targets.has(element) && element.isConnected) continue;
        observer.disconnect();
        observers.delete(element);
      }
      for (const element of targets) {
        if (observers.has(element) || !element.isConnected) continue;
        const view = element.ownerDocument.defaultView;
        const ObserverCtor = view?.MutationObserver ?? globalThis.MutationObserver;
        if (!ObserverCtor) continue;
        const observer = new ObserverCtor((mutations) => {
          if (api.signal.aborted) return;
          if (isRelevant(mutations)) schedule();
        });
        observer.observe(element, { childList: true, subtree: true });
        observers.set(element, observer);
      }
    },
  };
}

export async function openThread(api: DesktopExtensionApiV1, id: string): Promise<void> {
  try {
    await api.navigate.openThread(id);
  } catch (error) {
    if (!api.signal.aborted) console.warn("Cannot open the local Thread", error);
  }
}
