export const SUBAGENT_ROW_META_ATTRIBUTE = "data-codexhost-subagent-meta";
export const SUBAGENT_ITEM_BUTTON_SELECTOR = 'button[data-slot="thread-summary-panel-item-button"]';
export const SUBAGENT_ITEM_LABEL_SELECTOR = '[data-slot="thread-summary-panel-item-label"]';

export interface SubagentRowMeta {
  displayName: string;
  spawnModel?: string;
  agentRole?: string;
  status?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function prettySubagentStatus(status: string | undefined): string | undefined {
  switch (status) {
    case "active":
    case "running":
    case "working":
      return "進行中";
    case "waiting":
    case "pending":
    case "pendingInit":
      return "等待中";
    case "done":
    case "completed":
      return "已完成";
    case "failed":
    case "errored":
      return "失敗";
    case "interrupted":
      return "已中斷";
    default:
      return undefined;
  }
}

export function formatSubagentRowMeta(row: SubagentRowMeta): string | undefined {
  const parts = [
    row.spawnModel?.trim(),
    row.spawnModel ? undefined : row.agentRole?.trim(),
    prettySubagentStatus(row.status),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function subagentRowMetaFromProps(value: unknown): SubagentRowMeta | null {
  if (!isRecord(value)) return null;
  const sources = [
    value,
    isRecord(value.row) ? value.row : null,
    isRecord(value.backgroundAgent) ? value.backgroundAgent : null,
    isRecord(value.item) ? value.item : null,
    isRecord(value.item) && isRecord(value.item.backgroundAgent)
      ? value.item.backgroundAgent
      : null,
  ];
  for (const source of sources) {
    if (!source || !nonBlank(source.displayName)) continue;
    if (
      !nonBlank(source.conversationId) &&
      !nonBlank(source.spawnModel) &&
      !nonBlank(source.status)
    ) {
      continue;
    }
    return {
      displayName: source.displayName.trim(),
      ...(nonBlank(source.spawnModel) ? { spawnModel: source.spawnModel.trim() } : {}),
      ...(nonBlank(source.agentRole) ? { agentRole: source.agentRole.trim() } : {}),
      ...(nonBlank(source.status) ? { status: source.status.trim() } : {}),
    };
  }
  return null;
}

function fiberFromElement(element: HTMLElement): Record<string, unknown> | null {
  const names = Object.getOwnPropertyNames(element).filter((name) =>
    name.startsWith("__reactFiber$"),
  );
  const name = names[0];
  if (!name) return null;
  const fiber =
    Object.getOwnPropertyDescriptor(element, name)?.value ??
    (element as unknown as Record<string, unknown>)[name];
  return isRecord(fiber) ? fiber : null;
}

function metaFromFiberProps(fiber: Record<string, unknown> | null): SubagentRowMeta | null {
  if (!fiber) return null;
  return (
    subagentRowMetaFromProps(fiber.memoizedProps) ?? subagentRowMetaFromProps(fiber.pendingProps)
  );
}

function metaFromDescendants(start: Record<string, unknown> | null): SubagentRowMeta | null {
  if (!start || !isRecord(start.child)) return null;
  const stack: Array<Record<string, unknown>> = [start.child];
  const seen = new Set<Record<string, unknown>>();
  let steps = 0;
  while (stack.length > 0 && steps < 40) {
    const fiber = stack.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    steps += 1;
    const found = metaFromFiberProps(fiber);
    if (found) return found;
    if (isRecord(fiber.child)) stack.push(fiber.child);
    if (isRecord(fiber.sibling)) stack.push(fiber.sibling);
  }
  return null;
}

export function subagentRowMetaFromElement(element: HTMLElement): SubagentRowMeta | null {
  let fiber = fiberFromElement(element);
  const descendants = metaFromDescendants(fiber);
  if (descendants) return descendants;
  for (let depth = 0; fiber && depth < 10; depth += 1) {
    const found = metaFromFiberProps(fiber);
    if (found) return found;
    fiber = isRecord(fiber.return) ? fiber.return : null;
  }
  return null;
}

function findNameNode(button: HTMLElement): HTMLElement | null {
  return button.querySelector<HTMLElement>(SUBAGENT_ITEM_LABEL_SELECTOR);
}

function ensureMetaNode(label: HTMLElement): HTMLElement {
  let meta = label.querySelector<HTMLElement>(`[${SUBAGENT_ROW_META_ATTRIBUTE}]`);
  if (meta) return meta;
  label.style.display = "flex";
  label.style.flexDirection = "column";
  label.style.alignItems = "flex-start";
  label.style.minWidth = "0";
  label.style.flex = "1";
  label.style.overflow = "visible";
  label.style.whiteSpace = "normal";
  meta = label.ownerDocument.createElement("span");
  meta.setAttribute(SUBAGENT_ROW_META_ATTRIBUTE, "true");
  meta.style.display = "block";
  meta.style.maxWidth = "100%";
  meta.style.fontSize = "11px";
  meta.style.lineHeight = "1.35";
  meta.style.color = "var(--text-tertiary, #8a8a8a)";
  meta.style.whiteSpace = "normal";
  label.append(meta);
  return meta;
}

function isOwnMetaMutation(mutations: MutationRecord[]): boolean {
  return mutations.every((mutation) => {
    const nodes = [...mutation.addedNodes, ...mutation.removedNodes, mutation.target];
    return nodes.every((node) => {
      if (!(node instanceof Element)) return mutation.type === "characterData";
      return (
        node.getAttribute?.(SUBAGENT_ROW_META_ATTRIBUTE) === "true" ||
        Boolean(node.closest?.(`[${SUBAGENT_ROW_META_ATTRIBUTE}]`))
      );
    });
  });
}

export function decorateSubagentRow(element: HTMLElement): boolean {
  const label = element.querySelector<HTMLElement>(SUBAGENT_ITEM_LABEL_SELECTOR);
  const row =
    subagentRowMetaFromElement(element) ?? (label ? subagentRowMetaFromElement(label) : null);
  if (!row) return false;
  const text = formatSubagentRowMeta(row);
  const nameNode = findNameNode(element);
  if (!nameNode || !text) {
    element.querySelector(`[${SUBAGENT_ROW_META_ATTRIBUTE}]`)?.remove();
    return false;
  }
  const meta = ensureMetaNode(nameNode);
  if (meta.textContent !== text) meta.textContent = text;
  return true;
}

export function decorateSubagentRows(root: ParentNode = document): number {
  const buttons = root.querySelectorAll<HTMLElement>(SUBAGENT_ITEM_BUTTON_SELECTOR);
  if (buttons.length === 0) return 0;
  let decorated = 0;
  for (const element of buttons) {
    if (decorateSubagentRow(element)) decorated += 1;
  }
  return decorated;
}

export function installRendererSubagentRowMeta(
  root: ParentNode | undefined = typeof document === "undefined" ? undefined : document,
): { refresh(): void; dispose(): void } {
  if (!root) return { refresh() {}, dispose() {} };
  let disposed = false;
  let scanScheduled = false;
  let mutating = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const scan = (): void => {
    scanScheduled = false;
    if (disposed) return;
    mutating = true;
    try {
      decorateSubagentRows(root);
    } finally {
      mutating = false;
    }
  };
  const schedule = (): void => {
    if (disposed || mutating || scanScheduled) return;
    scanScheduled = true;
    if (debounce !== undefined) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      scan();
    }, 250);
  };
  const observer = new MutationObserver((mutations) => {
    if (mutating || isOwnMetaMutation(mutations)) return;
    schedule();
  });
  // childList only. Watching characterData and walking Fiber on every token froze Codex.
  observer.observe(root, { childList: true, subtree: true });
  return {
    refresh: schedule,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (debounce !== undefined) clearTimeout(debounce);
      observer.disconnect();
      if (root instanceof Element || root instanceof Document) {
        for (const meta of root.querySelectorAll(`[${SUBAGENT_ROW_META_ATTRIBUTE}]`)) {
          meta.remove();
        }
      }
    },
  };
}
