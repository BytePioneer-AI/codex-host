import type { JsonValue } from "@codexhost/shared-contracts";

const ITEM_TYPES = new Set([
  "agentMessage",
  "collabAgentToolCall",
  "commandExecution",
  "contextCompaction",
  "dynamicToolCall",
  "fileChange",
  "imageGeneration",
  "mcpToolCall",
  "reasoning",
  "subAgentActivity",
  "userMessage",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function prettyCollabReasoningEffort(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase() === "xhigh") return "xHigh";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function prettyCollabModelLabel(model: string): string {
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

export function formatCollabSpawnModel(
  model: string | undefined,
  reasoningEffort: string | undefined,
): string | null {
  const modelLabel = nonBlank(model) ? prettyCollabModelLabel(model) : undefined;
  const effortLabel = prettyCollabReasoningEffort(reasoningEffort);
  if (modelLabel && effortLabel) {
    const already = new RegExp(
      `(?:^|·\\s*)${effortLabel.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`,
      "iu",
    ).test(modelLabel);
    return already ? modelLabel : `${modelLabel} · ${effortLabel}`;
  }
  return modelLabel || effortLabel || null;
}

export interface OfficialThreadModel {
  model?: string;
  reasoningEffort?: string;
}

function rememberThreadModel(
  remember: (threadId: string, snapshot: OfficialThreadModel) => void,
  threadId: unknown,
  snapshot: OfficialThreadModel,
): void {
  if (!nonBlank(threadId)) return;
  if (!snapshot.model && !snapshot.reasoningEffort) return;
  remember(threadId.trim(), snapshot);
}

function observeRecord(
  value: Record<string, unknown>,
  remember: (threadId: string, snapshot: OfficialThreadModel) => void,
): void {
  if (nonBlank(value.type) && ITEM_TYPES.has(value.type)) return;
  const threadId = value.id ?? value.conversationId ?? value.threadId;
  const collab = isRecord(value.collaborationMode)
    ? value.collaborationMode
    : isRecord(value.latestCollaborationMode)
      ? value.latestCollaborationMode
      : null;
  const collabSettings = collab && isRecord(collab.settings) ? collab.settings : null;
  rememberThreadModel(remember, threadId, {
    ...(nonBlank(value.latestModel)
      ? { model: value.latestModel }
      : nonBlank(value.model) && value.type !== "collabAgentToolCall"
        ? { model: value.model }
        : nonBlank(collabSettings?.model)
          ? { model: collabSettings.model }
          : nonBlank(collab?.model)
            ? { model: collab.model }
            : {}),
    ...(nonBlank(value.latestReasoningEffort)
      ? { reasoningEffort: value.latestReasoningEffort }
      : nonBlank(value.reasoningEffort) && value.type !== "collabAgentToolCall"
        ? { reasoningEffort: value.reasoningEffort }
        : nonBlank(collabSettings?.reasoning_effort)
          ? { reasoningEffort: collabSettings.reasoning_effort }
          : nonBlank(collabSettings?.reasoningEffort)
            ? { reasoningEffort: collabSettings.reasoningEffort }
            : {}),
  });
}

export function observeOfficialThreadModels(
  value: JsonValue,
  remember: (threadId: string, snapshot: OfficialThreadModel) => void,
): void {
  const stack: unknown[] = [value];
  const seen = new Set<unknown>();
  let steps = 0;
  while (stack.length > 0 && steps < 2_000) {
    const current = stack.pop();
    steps += 1;
    if (current === null || current === undefined) continue;
    if (typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const entry of current) stack.push(entry);
      continue;
    }
    if (!isRecord(current)) continue;
    observeRecord(current, remember);
    if (isRecord(current.params)) {
      const params = current.params;
      rememberThreadModel(remember, params.threadId, {
        ...(nonBlank(params.model) ? { model: params.model } : {}),
        ...(nonBlank(params.reasoningEffort) ? { reasoningEffort: params.reasoningEffort } : {}),
      });
      if (isRecord(params.thread)) {
        rememberThreadModel(remember, params.thread.id ?? params.threadId, {
          ...(nonBlank(params.thread.latestModel)
            ? { model: params.thread.latestModel }
            : nonBlank(params.thread.model)
              ? { model: params.thread.model }
              : {}),
          ...(nonBlank(params.thread.latestReasoningEffort)
            ? { reasoningEffort: params.thread.latestReasoningEffort }
            : nonBlank(params.thread.reasoningEffort)
              ? { reasoningEffort: params.thread.reasoningEffort }
              : {}),
        });
      }
    }
    if (isRecord(current.result)) {
      const result = current.result;
      const thread = isRecord(result.thread) ? result.thread : null;
      rememberThreadModel(remember, thread?.id ?? result.threadId, {
        ...(nonBlank(result.model) ? { model: result.model } : {}),
        ...(nonBlank(result.reasoningEffort) ? { reasoningEffort: result.reasoningEffort } : {}),
      });
    }
    for (const nested of Object.values(current)) stack.push(nested);
  }
}

function decorateCollabItem(
  item: Record<string, unknown>,
  fallbackForSender?: (senderThreadId: string) => OfficialThreadModel | undefined,
): boolean {
  if (item.type !== "collabAgentToolCall" || item.tool !== "spawnAgent") return false;
  const fallback =
    nonBlank(item.senderThreadId) && fallbackForSender
      ? fallbackForSender(item.senderThreadId)
      : undefined;
  const formatted = formatCollabSpawnModel(
    nonBlank(item.model) ? item.model : fallback?.model,
    nonBlank(item.reasoningEffort) ? item.reasoningEffort : fallback?.reasoningEffort,
  );
  if (!formatted || item.model === formatted) return false;
  item.model = formatted;
  return true;
}

export function decorateOfficialCollabSpawnModels(
  value: JsonValue,
  fallbackForSender?: (senderThreadId: string) => OfficialThreadModel | undefined,
): boolean {
  const stack: unknown[] = [value];
  const seen = new Set<unknown>();
  let steps = 0;
  let mutated = false;
  while (stack.length > 0 && steps < 2_000) {
    const current = stack.pop();
    steps += 1;
    if (current === null || current === undefined) continue;
    if (typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const entry of current) stack.push(entry);
      continue;
    }
    if (!isRecord(current)) continue;
    if (decorateCollabItem(current, fallbackForSender)) mutated = true;
    for (const nested of Object.values(current)) stack.push(nested);
  }
  return mutated;
}
