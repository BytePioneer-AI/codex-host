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

export function subagentRowMetaFromProps(value: unknown, depth = 0): SubagentRowMeta | null {
  if (depth > 5 || !isRecord(value)) return null;
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
  for (const [key, nested] of Object.entries(value)) {
    if (key === "children" || key === "ref" || key === "onClick") continue;
    if (!isRecord(nested) || Array.isArray(nested) || "$$typeof" in nested) continue;
    const found = subagentRowMetaFromProps(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

function fiberFromElement(element: HTMLElement): Record<string, unknown> | null {
  const names = Object.getOwnPropertyNames(element).filter((name) =>
    name.startsWith("__reactFiber$"),
  );
  if (names.length === 0) {
    const protoName = Object.getOwnPropertyNames(Object.getPrototypeOf(element) ?? {}).find(
      (name) => name.startsWith("__reactFiber$"),
    );
    if (protoName) names.push(protoName);
  }
  const name = names[0];
  if (!name) return null;
  const fiber =
    Object.getOwnPropertyDescriptor(element, name)?.value ??
    (element as unknown as Record<string, unknown>)[name];
  return isRecord(fiber) ? fiber : null;
}

function visitFiberTree(
  start: Record<string, unknown> | null,
  visit: (fiber: Record<string, unknown>) => SubagentRowMeta | null,
): SubagentRowMeta | null {
  if (!start) return null;
  const stack: Array<Record<string, unknown>> = [start];
  const seen = new Set<Record<string, unknown>>();
  let steps = 0;
  while (stack.length > 0 && steps < 120) {
    const fiber = stack.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    steps += 1;
    const found = visit(fiber);
    if (found) return found;
    if (isRecord(fiber.child)) stack.push(fiber.child);
    if (isRecord(fiber.sibling)) stack.push(fiber.sibling);
  }
  return null;
}

export function subagentRowMetaFromElement(element: HTMLElement): SubagentRowMeta | null {
  const read = (fiber: Record<string, unknown>): SubagentRowMeta | null =>
    subagentRowMetaFromProps(fiber.memoizedProps) ?? subagentRowMetaFromProps(fiber.pendingProps);

  let fiber = fiberFromElement(element);
  const downward = visitFiberTree(fiber, read);
  if (downward) return downward;
  for (let depth = 0; fiber && depth < 8; depth += 1) {
    fiber = isRecord(fiber.return) ? fiber.return : null;
    const found = visitFiberTree(fiber, read);
    if (found) return found;
  }
  return null;
}

function findNameNode(button: HTMLElement, displayName: string): HTMLElement | null {
  const label = button.querySelector<HTMLElement>(SUBAGENT_ITEM_LABEL_SELECTOR);
  if (label) return label;
  for (const node of button.querySelectorAll<HTMLElement>("span, div, p")) {
    if (node.hasAttribute(SUBAGENT_ROW_META_ATTRIBUTE)) continue;
    const text = node.textContent?.trim() ?? "";
    if (text === displayName || text.startsWith(`${displayName} ·`)) return node;
  }
  return null;
}

function ensureMetaNode(label: HTMLElement): HTMLElement {
  label.style.display = "flex";
  label.style.flexDirection = "column";
  label.style.alignItems = "flex-start";
  label.style.minWidth = "0";
  label.style.flex = "1";
  label.style.overflow = "visible";
  label.style.whiteSpace = "normal";
  let meta = label.querySelector<HTMLElement>(`[${SUBAGENT_ROW_META_ATTRIBUTE}]`);
  if (!meta) {
    meta = label.ownerDocument.createElement("span");
    meta.setAttribute(SUBAGENT_ROW_META_ATTRIBUTE, "");
    meta.style.display = "block";
    meta.style.maxWidth = "100%";
    meta.style.fontSize = "11px";
    meta.style.lineHeight = "1.35";
    meta.style.color = "var(--text-tertiary, #8a8a8a)";
    meta.style.whiteSpace = "normal";
    label.append(meta);
  }
  return meta;
}

export function decorateSubagentRow(element: HTMLElement): boolean {
  const label = element.matches?.(SUBAGENT_ITEM_LABEL_SELECTOR)
    ? element
    : element.querySelector<HTMLElement>(SUBAGENT_ITEM_LABEL_SELECTOR);
  const row =
    subagentRowMetaFromElement(element) ?? (label ? subagentRowMetaFromElement(label) : null);
  if (!row) return false;
  const text = formatSubagentRowMeta(row);
  const nameNode = findNameNode(element, row.displayName);
  if (!nameNode || !text) {
    element.querySelector(`[${SUBAGENT_ROW_META_ATTRIBUTE}]`)?.remove();
    return false;
  }
  ensureMetaNode(nameNode).textContent = text;
  return true;
}

export function decorateSubagentRows(root: ParentNode = document): number {
  let decorated = 0;
  for (const element of root.querySelectorAll<HTMLElement>(SUBAGENT_ITEM_BUTTON_SELECTOR)) {
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
  const scan = (): void => {
    scanScheduled = false;
    if (!disposed) decorateSubagentRows(root);
  };
  const schedule = (): void => {
    if (disposed || scanScheduled) return;
    scanScheduled = true;
    queueMicrotask(scan);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(root, { childList: true, subtree: true });
  scan();
  return {
    refresh: scan,
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      if (root instanceof Element || root instanceof Document) {
        for (const meta of root.querySelectorAll(`[${SUBAGENT_ROW_META_ATTRIBUTE}]`)) {
          meta.remove();
        }
      }
    },
  };
}
