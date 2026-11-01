import { randomUUID } from "node:crypto";

import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
} from "@agentclientprotocol/sdk";
import type {
  HostApprovalAction,
  HostApprovalInteraction,
  HostChoiceQuestion,
  HostCommandExecutionItem,
  HostItem,
  HostQuestionInteraction,
  HostQuestionResponse,
  HostToolExecutionItem,
  HostUsage,
} from "@codexhost/harness-adapter";
import {
  hostInteractionIdSchema,
  hostItemIdSchema,
  type HostItemId,
  type HostTurnId,
  type JsonObject,
} from "@codexhost/shared-contracts";

export interface ProjectedApproval {
  interaction: HostApprovalInteraction;
  optionIdByActionId: ReadonlyMap<string, string>;
}

export function projectKimiApprovalRequest(
  turnId: HostTurnId,
  request: RequestPermissionRequest,
): ProjectedApproval {
  const interactionId = hostInteractionIdSchema.parse(randomUUID());
  const optionIdByActionId = new Map<string, string>();
  const actions: HostApprovalAction[] = [];
  const description = readAcpToolContentText(request.toolCall.content);

  const effectMap: Record<string, HostApprovalAction["effect"]> = {
    allow_once: "allowOnce",
    allow_always: "allowForSession", // Native approve_always is session-scoped
    reject_once: "deny",
    reject_always: "deny",
  };

  const labelMap: Record<string, string> = {
    allow_once: "允许一次",
    allow_always: "本会话允许",
    reject_once: "拒绝",
    reject_always: "拒绝",
  };

  for (const option of request.options) {
    const effect =
      effectMap[option.kind] ?? (option.kind.startsWith("allow") ? "allowOnce" : "deny");
    const actionId = option.optionId;
    optionIdByActionId.set(actionId, option.optionId);

    actions.push({
      id: actionId,
      label: option.name || labelMap[option.kind] || actionId,
      effect,
    });
  }

  // Fallback if no actions
  if (actions.length === 0) {
    actions.push(
      { id: "allow_once", label: "允许一次", effect: "allowOnce" },
      { id: "reject", label: "拒绝", effect: "deny" },
    );
    optionIdByActionId.set("allow_once", "allow_once");
    optionIdByActionId.set("reject", "reject");
  }

  const interaction: HostApprovalInteraction = {
    type: "approval",
    interactionId,
    turnId,
    title: request.toolCall.title?.trim() || "Kimi Code 工具执行审批",
    ...(description ? { description } : {}),
    subject: { type: "nativeAction" },
    actions,
  };

  return { interaction, optionIdByActionId };
}

export interface ProjectedElicitation {
  interaction: HostQuestionInteraction;
  schemaProperties: Record<string, { type: "string" | "array" }>;
}

export function projectKimiElicitationRequest(
  turnId: HostTurnId,
  request: CreateElicitationRequest,
): ProjectedElicitation {
  const interactionId = hostInteractionIdSchema.parse(randomUUID());
  const questions: HostChoiceQuestion[] = [];
  const schemaProperties: Record<string, { type: "string" | "array" }> = {};

  const req = request as Record<string, unknown>;
  const requestedSchema = req.requestedSchema as Record<string, unknown> | undefined;
  const properties =
    requestedSchema?.properties && typeof requestedSchema.properties === "object"
      ? (requestedSchema.properties as Record<string, Record<string, unknown>>)
      : {};
  const requiredList = Array.isArray(requestedSchema?.required)
    ? (requestedSchema.required as string[])
    : [];

  for (const [key, prop] of Object.entries(properties)) {
    const isArray = prop.type === "array";
    schemaProperties[key] = { type: isArray ? "array" : "string" };

    const promptCandidate =
      typeof prop.description === "string" && prop.description.trim()
        ? prop.description.trim()
        : typeof req.message === "string" && req.message.trim()
          ? req.message.trim()
          : typeof prop.title === "string" && prop.title.trim()
            ? prop.title.trim()
            : key;
    const prompt =
      promptCandidate.toLowerCase() === "question" &&
      typeof req.message === "string" &&
      req.message.trim()
        ? req.message.trim()
        : promptCandidate;

    const options: Array<{ value: string; label: string; description?: string }> = [];

    if (isArray && typeof prop.items === "object" && prop.items !== null) {
      const items = prop.items as Record<string, unknown>;
      const anyOf = Array.isArray(items.anyOf)
        ? (items.anyOf as Array<Record<string, unknown>>)
        : [];
      for (const item of anyOf) {
        if (typeof item?.const === "string") {
          options.push({
            value: item.const,
            label: typeof item.title === "string" ? item.title : item.const,
          });
        }
      }
    } else if (Array.isArray(prop.oneOf)) {
      for (const item of prop.oneOf as Array<Record<string, unknown>>) {
        if (typeof item?.const === "string") {
          options.push({
            value: item.const,
            label: typeof item.title === "string" ? item.title : item.const,
          });
        }
      }
    }

    questions.push({
      id: key,
      type: "choice",
      prompt,
      options,
      multiple: isArray,
      allowOther: false,
      optional: !requiredList.includes(key),
    });
  }

  const rawTitle = typeof requestedSchema?.title === "string" ? requestedSchema.title.trim() : "";
  const title =
    rawTitle &&
    rawTitle.toLowerCase() !== "ask user question" &&
    rawTitle.toLowerCase() !== "ask question"
      ? rawTitle
      : "提问";

  const interaction: HostQuestionInteraction = {
    type: "question",
    interactionId,
    turnId,
    title,
    questions,
  };

  return { interaction, schemaProperties };
}

export function formatElicitationResponse(
  response: HostQuestionResponse,
  schemaProperties: Record<string, { type: "string" | "array" }>,
): CreateElicitationResponse {
  if (response.cancelled) {
    return { action: "cancel" };
  }

  const content: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(schemaProperties)) {
    const answers = response.answers[key] || [];
    if (spec.type === "array") {
      content[key] = answers;
    } else {
      content[key] = answers[0] ?? "";
    }
  }

  return { action: "accept", content };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canonicalizeKimiToolName(
  name?: string | null,
  kind?: string | null,
  rawInput?: unknown,
): string {
  const trimmed = name?.trim();
  const lower = trimmed?.toLowerCase() ?? "";

  if (lower.startsWith("write") || lower.startsWith("writ")) {
    const isEdit =
      isRecord(rawInput) &&
      ("old_string" in rawInput || "oldText" in rawInput || "old" in rawInput);
    return isEdit ? "Edit" : "Write";
  }
  if (kind === "edit" || lower.startsWith("edit")) {
    const isWrite =
      isRecord(rawInput) &&
      ("content" in rawInput || "text" in rawInput) &&
      !("old_string" in rawInput || "oldText" in rawInput || "old" in rawInput);
    return isWrite ? "Write" : "Edit";
  }
  if (
    kind === "execute" ||
    lower.startsWith("bash") ||
    lower.startsWith("shell") ||
    lower.startsWith("run")
  ) {
    return "Bash";
  }
  if (kind === "read" || lower.startsWith("read")) {
    return "Read";
  }
  if (lower.startsWith("grep") || lower.startsWith("search")) {
    return "Grep";
  }
  if (lower.startsWith("glob") || lower.startsWith("find")) {
    return "Glob";
  }
  return trimmed || "Tool";
}

export interface ToolCallAccumulatorState {
  toolCallId: string;
  name: string;
  kind?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  contentAccumulator: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  itemStartedEmitted: boolean;
  itemId: HostItemId;
}

export class KimiToolCallAccumulator {
  private readonly calls = new Map<string, ToolCallAccumulatorState>();

  getOrCreate(
    toolCallId: string,
    turnId: HostTurnId,
    name = "Tool",
    kind?: string,
  ): ToolCallAccumulatorState {
    let state = this.calls.get(toolCallId);
    if (!state) {
      const sanitizedId = toolCallId.replace(/[^A-Za-z0-9._~-]/g, "_");
      state = {
        toolCallId,
        name: canonicalizeKimiToolName(name, kind),
        ...(kind ? { kind } : {}),
        contentAccumulator: "",
        status: "pending",
        itemStartedEmitted: false,
        itemId: hostItemIdSchema.parse(`item:${turnId}:tool:${sanitizedId}`),
      };
      this.calls.set(toolCallId, state);
    }
    return state;
  }

  get(toolCallId: string): ToolCallAccumulatorState | undefined {
    return this.calls.get(toolCallId);
  }

  values(): IterableIterator<ToolCallAccumulatorState> {
    return this.calls.values();
  }

  delete(toolCallId: string): boolean {
    return this.calls.delete(toolCallId);
  }
}

export function createHostItemFromToolState(
  state: ToolCallAccumulatorState,
  cwd?: string,
): HostItem {
  const canonicalName = canonicalizeKimiToolName(state.name, state.kind, state.rawInput);
  const isBash =
    state.kind === "execute" ||
    canonicalName.toLowerCase() === "bash" ||
    canonicalName.toLowerCase() === "shell" ||
    canonicalName.toLowerCase() === "terminal";
  const rawInput = state.rawInput as Record<string, unknown> | undefined;

  if (isBash) {
    const commandText =
      typeof rawInput?.command === "string"
        ? rawInput.command
        : typeof rawInput?.cmd === "string"
          ? rawInput.cmd
          : state.contentAccumulator || "sh";

    const item: HostCommandExecutionItem = {
      type: "commandExecution",
      itemId: state.itemId,
      command: commandText,
      ...(cwd ? { cwd } : {}),
      ...(state.rawOutput !== undefined || state.contentAccumulator
        ? {
            output:
              typeof state.rawOutput === "string"
                ? state.rawOutput
                : state.rawOutput
                  ? JSON.stringify(state.rawOutput)
                  : state.contentAccumulator,
          }
        : {}),
    };
    return item;
  }

  const args: Record<string, unknown> = (
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? { ...rawInput } : {}
  ) as Record<string, unknown>;

  if (
    (canonicalName === "Write" || state.kind === "edit") &&
    !args.content &&
    !args.text &&
    !args.newText &&
    !args.new_string &&
    state.contentAccumulator
  ) {
    args.content = state.contentAccumulator;
  }

  const toolItem: HostToolExecutionItem = {
    type: "toolExecution",
    itemId: state.itemId,
    toolName: canonicalName,
    arguments: args as JsonObject,
    ...(state.rawOutput !== undefined || state.contentAccumulator
      ? {
          output: {
            content: [
              {
                type: "text" as const,
                text:
                  typeof state.rawOutput === "string"
                    ? state.rawOutput
                    : state.rawOutput
                      ? JSON.stringify(state.rawOutput)
                      : state.contentAccumulator,
              },
            ],
          },
        }
      : {}),
  };
  return toolItem;
}

export function readAcpToolContentText(content: unknown): string {
  const parts = Array.isArray(content) ? content : [content];
  return parts
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const block = part as Record<string, unknown>;
      const nested =
        block.type === "content" && block.content && typeof block.content === "object"
          ? (block.content as Record<string, unknown>)
          : block;
      return nested.type === "text" && typeof nested.text === "string" ? [nested.text] : [];
    })
    .join("\n");
}

export function parseKimiUsage(
  update: Record<string, unknown>,
  contextWindowTokens?: number,
): HostUsage | null {
  const used = typeof update.used === "number" ? update.used : undefined;
  const size = typeof update.size === "number" ? update.size : undefined;

  const inputTokens =
    typeof update.inputTokens === "number"
      ? update.inputTokens
      : typeof update.inputOther === "number"
        ? update.inputOther
        : undefined;
  const outputTokens =
    typeof update.outputTokens === "number"
      ? update.outputTokens
      : typeof update.output === "number"
        ? update.output
        : undefined;
  const cachedInputTokens =
    typeof update.cachedInputTokens === "number"
      ? update.cachedInputTokens
      : typeof update.cachedReadTokens === "number"
        ? update.cachedReadTokens
        : typeof update.inputCacheRead === "number"
          ? update.inputCacheRead
          : undefined;
  const cacheWriteInputTokens =
    typeof update.cacheWriteInputTokens === "number"
      ? update.cacheWriteInputTokens
      : typeof update.cachedWriteTokens === "number"
        ? update.cachedWriteTokens
        : typeof update.inputCacheCreation === "number"
          ? update.inputCacheCreation
          : undefined;
  const totalTokens =
    typeof update.totalTokens === "number"
      ? update.totalTokens
      : inputTokens !== undefined ||
          outputTokens !== undefined ||
          cachedInputTokens !== undefined ||
          cacheWriteInputTokens !== undefined
        ? (inputTokens ?? 0) +
          (outputTokens ?? 0) +
          (cachedInputTokens ?? 0) +
          (cacheWriteInputTokens ?? 0)
        : undefined;

  const windowTokens =
    size ?? (contextWindowTokens && contextWindowTokens > 0 ? contextWindowTokens : undefined);
  const contextUsed = used ?? (typeof update.tokens === "number" ? update.tokens : undefined);

  if (
    contextUsed === undefined &&
    windowTokens === undefined &&
    totalTokens === undefined &&
    inputTokens === undefined
  ) {
    return null;
  }

  const promptTokens = (inputTokens ?? 0) + (cachedInputTokens ?? 0) + (cacheWriteInputTokens ?? 0);
  const effectiveContextUsed = contextUsed ?? (promptTokens > 0 ? promptTokens : undefined);
  const contextUsagePercent =
    windowTokens && effectiveContextUsed !== undefined && windowTokens > 0
      ? (effectiveContextUsed / windowTokens) * 100
      : undefined;
  const cacheHitRatePercent =
    promptTokens > 0 && cachedInputTokens !== undefined
      ? (cachedInputTokens / promptTokens) * 100
      : undefined;

  return {
    ...(windowTokens !== undefined ? { contextWindowTokens: windowTokens } : {}),
    ...(effectiveContextUsed !== undefined ? { contextUsedTokens: effectiveContextUsed } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(contextUsagePercent !== undefined ? { contextUsagePercent } : {}),
    ...(cacheHitRatePercent !== undefined ? { cacheHitRatePercent } : {}),
  };
}
