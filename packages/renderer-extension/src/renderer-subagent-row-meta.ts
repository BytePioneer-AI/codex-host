export const SUBAGENT_ROW_META_ATTRIBUTE = "data-codexhost-subagent-meta";
export const SUBAGENT_ITEM_BUTTON_SELECTOR = 'button[data-slot="thread-summary-panel-item-button"]';
export const SUBAGENT_ITEM_LABEL_SELECTOR = '[data-slot="thread-summary-panel-item-label"]';

export interface SubagentRowMeta {
  displayName: string;
  spawnModel?: string;
  model?: string;
  reasoningEffort?: string;
  agentRole?: string;
  status?: string;
  conversationId?: string;
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

export function prettySubagentEffort(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase() === "xhigh") return "xHigh";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function prettySubagentModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes(" · ")) return trimmed;
  const slash = trimmed.lastIndexOf("/");
  const id = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  if (id.toLowerCase().startsWith("grok")) {
    return id
      .replace(/^grok[-_]?/iu, "Grok ")
      .replace(/\s+/gu, " ")
      .trim();
  }
  if (!id.trimStart().toLowerCase().startsWith("gpt")) return trimmed;
  const joiner = /^gpt-\d/iu.test(id.trimStart()) ? " " : "-";
  return id
    .split(/(\s+)/u)
    .map((part) => {
      if (part.trim().length === 0) return part;
      return part
        .split("-")
        .map((token, index) => {
          if (token.toLowerCase() === "gpt") return "GPT";
          if (token.toLowerCase() === "oai") return "OAI";
          if (index > 0 && token.length > 0) {
            return `${token[0]?.toUpperCase() ?? ""}${token.slice(1)}`;
          }
          return token;
        })
        .join(joiner)
        .replace(/^GPT (?=\d)/u, "GPT-");
    })
    .join("");
}

function includesEffort(label: string, effort: string): boolean {
  return new RegExp(`(?:^|·\\s*)${effort.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "iu").test(
    label,
  );
}

export function formatSubagentRowMeta(row: SubagentRowMeta): string | undefined {
  const spawn = row.spawnModel?.trim();
  const model = prettySubagentModel(spawn || row.model?.trim() || "");
  const effort = prettySubagentEffort(row.reasoningEffort);
  const modelLine =
    model && effort && !includesEffort(model, effort) ? `${model} · ${effort}` : model || effort;
  const parts = [
    modelLine,
    modelLine ? undefined : row.agentRole?.trim(),
    prettySubagentStatus(row.status),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function contribute(target: Partial<SubagentRowMeta>, source: Record<string, unknown>): void {
  const sourceId = nonBlank(source.conversationId) ? source.conversationId.trim() : undefined;
  if (target.conversationId && sourceId && sourceId !== target.conversationId) return;
  if (nonBlank(source.displayName) && !target.displayName) {
    target.displayName = source.displayName.trim();
  }
  if (sourceId && !target.conversationId) target.conversationId = sourceId;
  if (nonBlank(source.spawnModel) && !target.spawnModel) {
    target.spawnModel = source.spawnModel.trim();
  }
  if (nonBlank(source.model) && !target.model) target.model = source.model.trim();
  if (nonBlank(source.latestModel) && !target.model) {
    target.model = source.latestModel.trim();
  }
  if (nonBlank(source.reasoningEffort) && !target.reasoningEffort) {
    target.reasoningEffort = source.reasoningEffort.trim();
  }
  if (nonBlank(source.latestReasoningEffort) && !target.reasoningEffort) {
    target.reasoningEffort = source.latestReasoningEffort.trim();
  }
  if (nonBlank(source.agentRole) && !target.agentRole) {
    target.agentRole = source.agentRole.trim();
  }
  if (nonBlank(source.status) && !target.status) {
    target.status = source.status.trim();
  }
}

function collabMatches(item: Record<string, unknown>, conversationId: string | undefined): boolean {
  if (item.type !== "collabAgentToolCall" || item.tool !== "spawnAgent") return false;
  if (!conversationId) return true;
  if (Array.isArray(item.receiverThreadIds) && item.receiverThreadIds.includes(conversationId)) {
    return true;
  }
  return isRecord(item.agentsStates) && conversationId in item.agentsStates;
}

function harvestFromValue(value: unknown, target: Partial<SubagentRowMeta>): void {
  if (!isRecord(value)) return;
  contribute(target, value);
  const nested = [
    isRecord(value.row) ? value.row : null,
    isRecord(value.backgroundAgent) ? value.backgroundAgent : null,
    isRecord(value.item) ? value.item : null,
    isRecord(value.item) && isRecord(value.item.backgroundAgent)
      ? value.item.backgroundAgent
      : null,
    isRecord(value.thread) ? value.thread : null,
    isRecord(value.childConversation) ? value.childConversation : null,
    isRecord(value.latestReference) ? value.latestReference : null,
  ];
  for (const source of nested) {
    if (source) contribute(target, source);
  }
  if (!target.conversationId) return;
  const items = Array.isArray(value.items)
    ? value.items
    : Array.isArray(value.turns)
      ? value.turns.flatMap((turn) =>
          isRecord(turn) && Array.isArray(turn.items) ? turn.items : [],
        )
      : Array.isArray(value.backgroundAgents)
        ? value.backgroundAgents
        : [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (collabMatches(item, target.conversationId)) contribute(target, item);
    if (isRecord(item.backgroundAgent)) contribute(target, item.backgroundAgent);
    else contribute(target, item);
  }
}

export function subagentRowMetaFromProps(value: unknown): SubagentRowMeta | null {
  const target: Partial<SubagentRowMeta> = {};
  harvestFromValue(value, target);
  if (!nonBlank(target.displayName)) return null;
  if (
    !nonBlank(target.conversationId) &&
    !nonBlank(target.spawnModel) &&
    !nonBlank(target.model) &&
    !nonBlank(target.status)
  ) {
    return null;
  }
  return {
    displayName: target.displayName.trim(),
    ...(nonBlank(target.spawnModel) ? { spawnModel: target.spawnModel.trim() } : {}),
    ...(nonBlank(target.model) ? { model: target.model.trim() } : {}),
    ...(nonBlank(target.reasoningEffort) ? { reasoningEffort: target.reasoningEffort.trim() } : {}),
    ...(nonBlank(target.agentRole) ? { agentRole: target.agentRole.trim() } : {}),
    ...(nonBlank(target.status) ? { status: target.status.trim() } : {}),
    ...(nonBlank(target.conversationId) ? { conversationId: target.conversationId.trim() } : {}),
  };
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

function mergeRow(
  base: SubagentRowMeta | null,
  next: SubagentRowMeta | null,
): SubagentRowMeta | null {
  if (!base) return next;
  if (!next) return base;
  if (base.conversationId && next.conversationId && base.conversationId !== next.conversationId) {
    return base;
  }
  const spawnModel = base.spawnModel ?? next.spawnModel;
  const model = base.model ?? next.model;
  const reasoningEffort = base.reasoningEffort ?? next.reasoningEffort;
  const agentRole = base.agentRole ?? next.agentRole;
  const status = base.status ?? next.status;
  const conversationId = base.conversationId ?? next.conversationId;
  return {
    displayName: base.displayName || next.displayName,
    ...(spawnModel ? { spawnModel } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(agentRole ? { agentRole } : {}),
    ...(status ? { status } : {}),
    ...(conversationId ? { conversationId } : {}),
  };
}

function metaFromDescendants(start: Record<string, unknown> | null): SubagentRowMeta | null {
  if (!start || !isRecord(start.child)) return null;
  const stack: Array<Record<string, unknown>> = [start.child];
  const seen = new Set<Record<string, unknown>>();
  let found: SubagentRowMeta | null = null;
  let steps = 0;
  while (stack.length > 0 && steps < 40) {
    const fiber = stack.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    steps += 1;
    found = mergeRow(found, metaFromFiberProps(fiber));
    if (isRecord(fiber.child)) stack.push(fiber.child);
    if (isRecord(fiber.sibling)) stack.push(fiber.sibling);
  }
  return found;
}

export function subagentRowMetaFromElement(element: HTMLElement): SubagentRowMeta | null {
  let fiber = fiberFromElement(element);
  let found = metaFromDescendants(fiber);
  for (let depth = 0; fiber && depth < 12; depth += 1) {
    found = mergeRow(found, metaFromFiberProps(fiber));
    fiber = isRecord(fiber.return) ? fiber.return : null;
  }
  return found;
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
