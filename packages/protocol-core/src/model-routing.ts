import {
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  type HarnessModelRef,
  type HarnessThinkingOptionId,
  type JsonRpcRequest,
} from "@codexhost/shared-contracts";

export const PI_NATIVE_TRANSPORT_MODEL_ID = "codexhost/pi-native";
export const PI_NATIVE_TRANSPORT_MODEL_PREFIX = `${PI_NATIVE_TRANSPORT_MODEL_ID}@`;
export const CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID = "codexhost/claude-code-native";
export const CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_PREFIX = `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@`;
export const EXTERNAL_HARNESS_IDS = ["pi", "claude-code"] as const;

export type ExternalHarnessId = (typeof EXTERNAL_HARNESS_IDS)[number];
export type RoutedHarnessId = "codex" | ExternalHarnessId;

const transportModelByHarness = {
  pi: PI_NATIVE_TRANSPORT_MODEL_ID,
  "claude-code": CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
} as const satisfies Record<ExternalHarnessId, string>;

const harnessByTransportModel = new Map<string, ExternalHarnessId>(
  Object.entries(transportModelByHarness).map(([harnessId, transportModelId]) => [
    transportModelId,
    harnessId as ExternalHarnessId,
  ]),
);

export type CreateRoute =
  | { harnessId: "codex"; transportModelId: string }
  | {
      harnessId: ExternalHarnessId;
      routeMode: "native";
      transportModelId: string;
      model?: HarnessModelRef;
      thinkingOptionId?: HarnessThinkingOptionId;
    };

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function transportModelIdForHarness(harnessId: ExternalHarnessId): string {
  return transportModelByHarness[harnessId];
}

export interface ExternalConfigurationSelection {
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
}

export function encodePiTransportModel(
  model?: HarnessModelRef,
  thinkingOptionId?: HarnessThinkingOptionId,
): string {
  if (!model) {
    if (thinkingOptionId) throw new Error("Pi transport Thinking requires a Model Ref");
    return PI_NATIVE_TRANSPORT_MODEL_ID;
  }
  const parsedModel = harnessModelRefSchema.parse(model);
  const parsedThinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.parse(thinkingOptionId)
    : undefined;
  return `${PI_NATIVE_TRANSPORT_MODEL_PREFIX}${parsedModel.id}${parsedThinking ? `@${parsedThinking}` : ""}`;
}

export function decodePiTransportSelection(value: unknown): ExternalConfigurationSelection | null {
  if (value === PI_NATIVE_TRANSPORT_MODEL_ID) return {};
  if (typeof value !== "string" || !value.startsWith(PI_NATIVE_TRANSPORT_MODEL_PREFIX)) return null;
  const components = value.slice(PI_NATIVE_TRANSPORT_MODEL_PREFIX.length).split("@");
  if (components.length < 1 || components.length > 2) {
    throw new Error("Pi transport configuration has an invalid component count");
  }
  const [modelId, thinkingOptionId] = components;
  if (components.length === 2 && !thinkingOptionId) {
    throw new Error("Pi transport configuration has an empty Thinking option");
  }
  const model = harnessModelRefSchema.safeParse({ id: modelId });
  if (!model.success) throw new Error("Pi transport Model contains an invalid Model Ref");
  const thinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.safeParse(thinkingOptionId)
    : null;
  if (thinking && !thinking.success) {
    throw new Error("Pi transport configuration contains an invalid Thinking option");
  }
  return {
    model: model.data,
    ...(thinking?.success ? { thinkingOptionId: thinking.data } : {}),
  };
}

export function decodePiTransportModel(value: unknown): HarnessModelRef | null | undefined {
  const selection = decodePiTransportSelection(value);
  return selection === null ? null : selection.model;
}

export function encodeClaudeTransportModel(model?: HarnessModelRef): string {
  if (!model) return CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID;
  const parsed = harnessModelRefSchema.parse(model);
  return `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_PREFIX}${parsed.id}`;
}

export function decodeClaudeTransportSelection(
  value: unknown,
): ExternalConfigurationSelection | null {
  if (value === CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID) return {};
  if (typeof value !== "string" || !value.startsWith(CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_PREFIX)) {
    return null;
  }
  const component = value.slice(CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_PREFIX.length);
  if (component.includes("@")) {
    throw new Error("Claude Code transport configuration has an invalid component count");
  }
  const model = harnessModelRefSchema.safeParse({ id: component });
  if (!model.success) {
    throw new Error("Claude Code transport Model contains an invalid Model Ref");
  }
  return { model: model.data };
}

export function decodeExternalTransportSelection(
  harnessId: ExternalHarnessId,
  value: unknown,
): ExternalConfigurationSelection | null {
  switch (harnessId) {
    case "pi":
      return decodePiTransportSelection(value);
    case "claude-code":
      return decodeClaudeTransportSelection(value);
  }
}

export function decodeExternalTransportModel(
  harnessId: ExternalHarnessId,
  value: unknown,
): HarnessModelRef | null | undefined {
  const selection = decodeExternalTransportSelection(harnessId, value);
  return selection === null ? null : selection.model;
}

export function decodeCreateRoute(request: JsonRpcRequest): CreateRoute | null {
  if (request.method !== "thread/start") return null;
  if (!isJsonObject(request.params) || typeof request.params.model !== "string") {
    throw new Error("thread/start params.model must be text");
  }

  const piSelection = decodePiTransportSelection(request.params.model);
  if (piSelection !== null) {
    return {
      harnessId: "pi",
      routeMode: "native",
      transportModelId: request.params.model,
      ...piSelection,
    };
  }
  const claudeSelection = decodeClaudeTransportSelection(request.params.model);
  if (claudeSelection !== null) {
    return {
      harnessId: "claude-code",
      routeMode: "native",
      transportModelId: request.params.model,
      ...claudeSelection,
    };
  }

  const harnessId = harnessByTransportModel.get(request.params.model);
  return harnessId
    ? {
        harnessId,
        routeMode: "native",
        transportModelId: request.params.model,
      }
    : { harnessId: "codex", transportModelId: request.params.model };
}
