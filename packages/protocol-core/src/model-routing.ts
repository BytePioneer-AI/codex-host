import {
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  type HarnessModelRef,
  type HarnessPermissionModeId,
  type HarnessThinkingOptionId,
  type JsonRpcRequest,
} from "@codexhost/shared-contracts";

export const PI_NATIVE_TRANSPORT_MODEL_ID = "codexhost/pi-native";
export const PI_NATIVE_TRANSPORT_MODEL_PREFIX = `${PI_NATIVE_TRANSPORT_MODEL_ID}@`;
export const CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID = "codexhost/claude-code-native";
export const CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_PREFIX = `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID}@`;
export const DEEPSEEK_HARNESS_NATIVE_TRANSPORT_MODEL_ID = "codexhost/deepseek-harness-native";
export const DEEPSEEK_HARNESS_NATIVE_TRANSPORT_MODEL_PREFIX = `${DEEPSEEK_HARNESS_NATIVE_TRANSPORT_MODEL_ID}@`;
export const GROK_NATIVE_TRANSPORT_MODEL_ID = "codexhost/grok-native";
export const GROK_NATIVE_TRANSPORT_MODEL_PREFIX = `${GROK_NATIVE_TRANSPORT_MODEL_ID}@`;
export const GEMINI_NATIVE_TRANSPORT_MODEL_ID = "codexhost/gemini-native";
export const GEMINI_NATIVE_TRANSPORT_MODEL_PREFIX = `${GEMINI_NATIVE_TRANSPORT_MODEL_ID}@`;
export const OMP_NATIVE_TRANSPORT_MODEL_ID = "codexhost/omp-native";
export const OMP_NATIVE_TRANSPORT_MODEL_PREFIX = `${OMP_NATIVE_TRANSPORT_MODEL_ID}@`;
export const EXTERNAL_HARNESS_IDS = [
  "pi",
  "claude-code",
  "deepseek-harness",
  "grok",
  "gemini",
  "omp",
] as const;

export type ExternalHarnessId = (typeof EXTERNAL_HARNESS_IDS)[number];
export type RoutedHarnessId = "codex" | ExternalHarnessId;

const transportModelByHarness = {
  pi: PI_NATIVE_TRANSPORT_MODEL_ID,
  "claude-code": CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
  "deepseek-harness": DEEPSEEK_HARNESS_NATIVE_TRANSPORT_MODEL_ID,
  grok: GROK_NATIVE_TRANSPORT_MODEL_ID,
  gemini: GEMINI_NATIVE_TRANSPORT_MODEL_ID,
  omp: OMP_NATIVE_TRANSPORT_MODEL_ID,
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
      permissionModeId?: HarnessPermissionModeId;
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
  permissionModeId?: HarnessPermissionModeId;
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

export function encodeOmpTransportModel(
  model?: HarnessModelRef,
  thinkingOptionId?: HarnessThinkingOptionId,
): string {
  if (!model) {
    if (thinkingOptionId) throw new Error("OMP transport Thinking requires a Model Ref");
    return OMP_NATIVE_TRANSPORT_MODEL_ID;
  }
  const parsedModel = harnessModelRefSchema.parse(model);
  const parsedThinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.parse(thinkingOptionId)
    : undefined;
  return `${OMP_NATIVE_TRANSPORT_MODEL_PREFIX}${parsedModel.id}${parsedThinking ? `@${parsedThinking}` : ""}`;
}

export function decodeOmpTransportSelection(value: unknown): ExternalConfigurationSelection | null {
  if (value === OMP_NATIVE_TRANSPORT_MODEL_ID) return {};
  if (typeof value !== "string" || !value.startsWith(OMP_NATIVE_TRANSPORT_MODEL_PREFIX))
    return null;
  const components = value.slice(OMP_NATIVE_TRANSPORT_MODEL_PREFIX.length).split("@");
  if (components.length < 1 || components.length > 2)
    throw new Error("OMP transport configuration has an invalid component count");
  const [modelId, thinkingOptionId] = components;
  const model = harnessModelRefSchema.safeParse({ id: modelId });
  if (!model.success) throw new Error("OMP transport Model contains an invalid Model Ref");
  const thinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.safeParse(thinkingOptionId)
    : null;
  if (thinking && !thinking.success)
    throw new Error("OMP transport configuration contains an invalid Thinking option");
  return { model: model.data, ...(thinking?.success ? { thinkingOptionId: thinking.data } : {}) };
}

export function decodeOmpTransportModel(value: unknown): HarnessModelRef | null | undefined {
  const selection = decodeOmpTransportSelection(value);
  return selection === null ? null : selection.model;
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

export function encodeClaudeTransportModel(
  model?: HarnessModelRef,
  permissionModeId?: HarnessPermissionModeId,
  thinkingOptionId?: HarnessThinkingOptionId,
): string {
  if (!model) {
    if (permissionModeId || thinkingOptionId) {
      throw new Error("Claude Code transport configuration requires a Model Ref");
    }
    return CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID;
  }
  const parsedModel = harnessModelRefSchema.parse(model);
  const parsedPermissionModeId = permissionModeId
    ? harnessPermissionModeIdSchema.parse(permissionModeId)
    : undefined;
  const parsedThinkingOptionId = thinkingOptionId
    ? harnessThinkingOptionIdSchema.parse(thinkingOptionId)
    : undefined;
  if (parsedThinkingOptionId) {
    return `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_PREFIX}${parsedModel.id}@${parsedPermissionModeId ?? ""}@${parsedThinkingOptionId}`;
  }
  return `${CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_PREFIX}${parsedModel.id}${parsedPermissionModeId ? `@${parsedPermissionModeId}` : ""}`;
}

export function encodeGrokTransportModel(
  model?: HarnessModelRef,
  permissionModeId?: HarnessPermissionModeId,
  thinkingOptionId?: HarnessThinkingOptionId,
): string {
  if (!model) {
    if (permissionModeId || thinkingOptionId) {
      throw new Error("Grok transport configuration requires a Model Ref");
    }
    return GROK_NATIVE_TRANSPORT_MODEL_ID;
  }
  const parsedModel = harnessModelRefSchema.parse(model);
  const parsedPermissionMode = permissionModeId
    ? harnessPermissionModeIdSchema.parse(permissionModeId)
    : undefined;
  const parsedThinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.parse(thinkingOptionId)
    : undefined;
  if (parsedThinking) {
    return `${GROK_NATIVE_TRANSPORT_MODEL_PREFIX}${parsedModel.id}@${parsedPermissionMode ?? ""}@${parsedThinking}`;
  }
  return `${GROK_NATIVE_TRANSPORT_MODEL_PREFIX}${parsedModel.id}${parsedPermissionMode ? `@${parsedPermissionMode}` : ""}`;
}

export function decodeGrokTransportSelection(
  value: unknown,
): ExternalConfigurationSelection | null {
  if (value === GROK_NATIVE_TRANSPORT_MODEL_ID) return {};
  if (typeof value !== "string" || !value.startsWith(GROK_NATIVE_TRANSPORT_MODEL_PREFIX)) {
    return null;
  }
  const components = value.slice(GROK_NATIVE_TRANSPORT_MODEL_PREFIX.length).split("@");
  if (components.length < 1 || components.length > 3) {
    throw new Error("Grok transport configuration has an invalid component count");
  }
  const [modelId, permissionModeId, thinkingOptionId] = components;
  if (components.length === 2 && !permissionModeId) {
    throw new Error("Grok transport configuration has an empty Permission Mode");
  }
  if (components.length === 3 && !thinkingOptionId) {
    throw new Error("Grok transport configuration has an empty Thinking option");
  }
  const model = harnessModelRefSchema.safeParse({ id: modelId });
  if (!model.success) throw new Error("Grok transport Model contains an invalid Model Ref");
  const permissionMode = permissionModeId
    ? harnessPermissionModeIdSchema.safeParse(permissionModeId)
    : null;
  if (permissionMode && !permissionMode.success) {
    throw new Error("Grok transport configuration contains an invalid Permission Mode");
  }
  const thinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.safeParse(thinkingOptionId)
    : null;
  if (thinking && !thinking.success) {
    throw new Error("Grok transport configuration contains an invalid Thinking option");
  }
  return {
    model: model.data,
    ...(permissionMode?.success ? { permissionModeId: permissionMode.data } : {}),
    ...(thinking?.success ? { thinkingOptionId: thinking.data } : {}),
  };
}

export function decodeClaudeTransportSelection(
  value: unknown,
): ExternalConfigurationSelection | null {
  if (value === CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID) return {};
  if (typeof value !== "string" || !value.startsWith(CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_PREFIX)) {
    return null;
  }
  const components = value.slice(CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_PREFIX.length).split("@");
  if (components.length < 1 || components.length > 3) {
    throw new Error("Claude Code transport configuration has an invalid component count");
  }
  const [modelId, permissionModeId, thinkingOptionId] = components;
  if (components.length === 2 && !permissionModeId) {
    throw new Error("Claude Code transport configuration has an empty Permission Mode");
  }
  if (components.length === 3 && !thinkingOptionId) {
    throw new Error("Claude Code transport configuration has an empty Thinking option");
  }
  const model = harnessModelRefSchema.safeParse({ id: modelId });
  if (!model.success) {
    throw new Error("Claude Code transport Model contains an invalid Model Ref");
  }
  const permissionMode = permissionModeId
    ? harnessPermissionModeIdSchema.safeParse(permissionModeId)
    : null;
  if (permissionMode && !permissionMode.success) {
    throw new Error("Claude Code transport configuration contains an invalid Permission Mode");
  }
  const thinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.safeParse(thinkingOptionId)
    : null;
  if (thinking && !thinking.success) {
    throw new Error("Claude Code transport configuration contains an invalid Thinking option");
  }
  return {
    model: model.data,
    ...(permissionMode?.success ? { permissionModeId: permissionMode.data } : {}),
    ...(thinking?.success ? { thinkingOptionId: thinking.data } : {}),
  };
}

export function encodeDeepSeekHarnessTransportModel(
  model?: HarnessModelRef,
  permissionModeId?: HarnessPermissionModeId,
): string {
  if (!model) {
    if (permissionModeId) {
      throw new Error("DeepSeek Harness transport Permission Mode requires a Model Ref");
    }
    return DEEPSEEK_HARNESS_NATIVE_TRANSPORT_MODEL_ID;
  }
  const parsedModel = harnessModelRefSchema.parse(model);
  const parsedPermissionModeId = permissionModeId
    ? harnessPermissionModeIdSchema.parse(permissionModeId)
    : undefined;
  return `${DEEPSEEK_HARNESS_NATIVE_TRANSPORT_MODEL_PREFIX}${parsedModel.id}${parsedPermissionModeId ? `@${parsedPermissionModeId}` : ""}`;
}

export function decodeDeepSeekHarnessTransportSelection(
  value: unknown,
): ExternalConfigurationSelection | null {
  if (value === DEEPSEEK_HARNESS_NATIVE_TRANSPORT_MODEL_ID) return {};
  if (
    typeof value !== "string" ||
    !value.startsWith(DEEPSEEK_HARNESS_NATIVE_TRANSPORT_MODEL_PREFIX)
  ) {
    return null;
  }
  const components = value.slice(DEEPSEEK_HARNESS_NATIVE_TRANSPORT_MODEL_PREFIX.length).split("@");
  if (components.length < 1 || components.length > 2) {
    throw new Error("DeepSeek Harness transport configuration has an invalid component count");
  }
  const [modelId, permissionModeId] = components;
  if (components.length === 2 && !permissionModeId) {
    throw new Error("DeepSeek Harness transport configuration has an empty Permission Mode");
  }
  const model = harnessModelRefSchema.safeParse({ id: modelId });
  if (!model.success) {
    throw new Error("DeepSeek Harness transport Model contains an invalid Model Ref");
  }
  const permissionMode = permissionModeId
    ? harnessPermissionModeIdSchema.safeParse(permissionModeId)
    : null;
  if (permissionMode && !permissionMode.success) {
    throw new Error("DeepSeek Harness transport contains an invalid Permission Mode");
  }
  return {
    model: model.data,
    ...(permissionMode?.success ? { permissionModeId: permissionMode.data } : {}),
  };
}

export function encodeGeminiTransportModel(
  model?: HarnessModelRef,
  permissionModeId?: HarnessPermissionModeId,
  thinkingOptionId?: HarnessThinkingOptionId,
): string {
  if (!model) {
    if (permissionModeId || thinkingOptionId) {
      throw new Error("Gemini transport configuration requires a Model Ref");
    }
    return GEMINI_NATIVE_TRANSPORT_MODEL_ID;
  }
  const parsedModel = harnessModelRefSchema.parse(model);
  const permission = permissionModeId
    ? harnessPermissionModeIdSchema.parse(permissionModeId)
    : undefined;
  const thinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.parse(thinkingOptionId)
    : undefined;
  if (thinking) {
    return `${GEMINI_NATIVE_TRANSPORT_MODEL_PREFIX}${parsedModel.id}@${permission ?? ""}@${thinking}`;
  }
  return `${GEMINI_NATIVE_TRANSPORT_MODEL_PREFIX}${parsedModel.id}${permission ? `@${permission}` : ""}`;
}

export function decodeGeminiTransportSelection(
  value: unknown,
): ExternalConfigurationSelection | null {
  if (value === GEMINI_NATIVE_TRANSPORT_MODEL_ID) return {};
  if (typeof value !== "string" || !value.startsWith(GEMINI_NATIVE_TRANSPORT_MODEL_PREFIX)) {
    return null;
  }
  const components = value.slice(GEMINI_NATIVE_TRANSPORT_MODEL_PREFIX.length).split("@");
  if (components.length < 1 || components.length > 3) {
    throw new Error("Gemini transport configuration has an invalid component count");
  }
  const [modelId, permissionModeId, thinkingOptionId] = components;
  if (components.length === 2 && !permissionModeId) {
    throw new Error("Gemini transport configuration has an empty Permission Mode");
  }
  if (components.length === 3 && !thinkingOptionId) {
    throw new Error("Gemini transport configuration has an empty Thinking option");
  }
  const model = harnessModelRefSchema.safeParse({ id: modelId });
  if (!model.success) throw new Error("Gemini transport Model contains an invalid Model Ref");
  const permission = permissionModeId
    ? harnessPermissionModeIdSchema.safeParse(permissionModeId)
    : null;
  if (permission && !permission.success) {
    throw new Error("Gemini transport configuration contains an invalid Permission Mode");
  }
  const thinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.safeParse(thinkingOptionId)
    : null;
  if (thinking && !thinking.success) {
    throw new Error("Gemini transport configuration contains an invalid Thinking option");
  }
  return {
    model: model.data,
    ...(permission?.success ? { permissionModeId: permission.data } : {}),
    ...(thinking?.success ? { thinkingOptionId: thinking.data } : {}),
  };
}

export function encodeExternalTransportSelection(
  harnessId: ExternalHarnessId,
  selection: ExternalConfigurationSelection,
): string {
  switch (harnessId) {
    case "pi":
      return encodePiTransportModel(selection.model, selection.thinkingOptionId);
    case "claude-code":
      return encodeClaudeTransportModel(
        selection.model,
        selection.permissionModeId,
        selection.thinkingOptionId,
      );
    case "deepseek-harness":
      return encodeDeepSeekHarnessTransportModel(selection.model, selection.permissionModeId);
    case "grok":
      return encodeGrokTransportModel(
        selection.model,
        selection.permissionModeId,
        selection.thinkingOptionId,
      );
    case "gemini":
      return encodeGeminiTransportModel(
        selection.model,
        selection.permissionModeId,
        selection.thinkingOptionId,
      );
    case "omp":
      return encodeOmpTransportModel(selection.model, selection.thinkingOptionId);
    case "gemini":
      return encodeGeminiTransportModel(selection.model, selection.permissionModeId, selection.thinkingOptionId);
  }
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
    case "deepseek-harness":
      return decodeDeepSeekHarnessTransportSelection(value);
    case "grok":
      return decodeGrokTransportSelection(value);
    case "gemini":
      return decodeGeminiTransportSelection(value);
    case "omp":
      return decodeOmpTransportSelection(value);
    case "gemini":
      return decodeGeminiTransportSelection(value);
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
  const deepSeekSelection = decodeDeepSeekHarnessTransportSelection(request.params.model);
  if (deepSeekSelection !== null) {
    return {
      harnessId: "deepseek-harness",
      routeMode: "native",
      transportModelId: request.params.model,
      ...deepSeekSelection,
    };
  }
  const grokSelection = decodeGrokTransportSelection(request.params.model);
  if (grokSelection !== null) {
    return {
      harnessId: "grok",
      routeMode: "native",
      transportModelId: request.params.model,
      ...grokSelection,
    };
  }
  const geminiSelection = decodeGeminiTransportSelection(request.params.model);
  if (geminiSelection !== null) {
    return {
      harnessId: "gemini",
      routeMode: "native",
      transportModelId: request.params.model,
      ...geminiSelection,
    };
  }
  const ompSelection = decodeOmpTransportSelection(request.params.model);
  if (ompSelection !== null) {
    return {
      harnessId: "omp",
      routeMode: "native",
      transportModelId: request.params.model,
      ...ompSelection,
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
