export const SUBAGENT_ROW_META_ATTRIBUTE = "data-codexhost-subagent-meta";

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
  const parts = [row.spawnModel?.trim(), prettySubagentStatus(row.status)].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function fiberFromElement(element: HTMLElement): Record<string, unknown> | null {
  const names = Object.getOwnPropertyNames(element).filter((name) =>
    name.startsWith("__reactFiber$"),
  );
  const name = names[0];
  if (names.length !== 1 || !name) return null;
  const fiber = Object.getOwnPropertyDescriptor(element, name)?.value;
  return isRecord(fiber) ? fiber : null;
}

function rowFromProps(props: unknown): SubagentRowMeta | null {
  if (!isRecord(props)) return null;
  const source = isRecord(props.row)
    ? props.row
    : isRecord(props.backgroundAgent)
      ? props.backgroundAgent
      : props;
  if (!nonBlank(source.conversationId) || !nonBlank(source.displayName)) return null;
  return {
    displayName: source.displayName.trim(),
    ...(nonBlank(source.spawnModel) ? { spawnModel: source.spawnModel.trim() } : {}),
    ...(nonBlank(source.agentRole) ? { agentRole: source.agentRole.trim() } : {}),
    ...(nonBlank(source.status) ? { status: source.status.trim() } : {}),
  };
}

export function subagentRowMetaFromElement(element: HTMLElement): SubagentRowMeta | null {
  let fiber: Record<string, unknown> | null = fiberFromElement(element);
  for (let depth = 0; fiber && depth < 16; depth += 1) {
    const row = rowFromProps(fiber.memoizedProps);
    if (row) return row;
    fiber = isRecord(fiber.return) ? fiber.return : null;
  }
  return null;
}

function findNameNode(button: HTMLElement, displayName: string): HTMLElement | null {
  for (const node of button.querySelectorAll<HTMLElement>("span, div, p")) {
    if (node.hasAttribute(SUBAGENT_ROW_META_ATTRIBUTE)) continue;
    const text = node.textContent?.trim() ?? "";
    if (text === displayName || text.startsWith(`${displayName} ·`)) return node;
  }
  return null;
}

function ensureMetaNode(nameNode: HTMLElement): HTMLElement {
  const parent = nameNode.parentElement ?? nameNode;
  parent.style.display = "flex";
  parent.style.flexDirection = "column";
  parent.style.alignItems = "flex-start";
  parent.style.minWidth = "0";
  parent.style.flex = "1";
  nameNode.style.maxWidth = "100%";
  nameNode.style.overflow = "hidden";
  nameNode.style.textOverflow = "ellipsis";
  nameNode.style.whiteSpace = "nowrap";
  let meta = parent.querySelector<HTMLElement>(`[${SUBAGENT_ROW_META_ATTRIBUTE}]`);
  if (!meta) {
    meta = nameNode.ownerDocument.createElement("span");
    meta.setAttribute(SUBAGENT_ROW_META_ATTRIBUTE, "");
    meta.style.display = "block";
    meta.style.maxWidth = "100%";
    meta.style.fontSize = "11px";
    meta.style.lineHeight = "1.3";
    meta.style.color = "var(--text-tertiary, #8a8a8a)";
    meta.style.whiteSpace = "normal";
    nameNode.insertAdjacentElement("afterend", meta);
  }
  return meta;
}

export function decorateSubagentRow(element: HTMLElement): boolean {
  const row = subagentRowMetaFromElement(element);
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
  for (const element of root.querySelectorAll<HTMLElement>("button")) {
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
  if (root instanceof Node) {
    observer.observe(root, { childList: true, subtree: true });
  }
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
