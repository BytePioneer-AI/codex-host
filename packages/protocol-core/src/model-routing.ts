import {
  decodeHarnessPluginRoute,
  encodeHarnessPluginRoute,
  harnessPluginIdSchema,
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
export const OPENCODE_NATIVE_TRANSPORT_MODEL_ID = "codexhost/opencode-native";
export const OPENCODE_NATIVE_TRANSPORT_MODEL_PREFIX = `${OPENCODE_NATIVE_TRANSPORT_MODEL_ID}@`;
export const GROK_NATIVE_TRANSPORT_MODEL_ID = "codexhost/grok-native";
export const GROK_NATIVE_TRANSPORT_MODEL_PREFIX = `${GROK_NATIVE_TRANSPORT_MODEL_ID}@`;
export const OMP_NATIVE_TRANSPORT_MODEL_ID = "codexhost/omp-native";
export const OMP_NATIVE_TRANSPORT_MODEL_PREFIX = `${OMP_NATIVE_TRANSPORT_MODEL_ID}@`;
export const ANTIGRAVITY_NATIVE_TRANSPORT_MODEL_ID = "codexhost/antigravity-native";
export const ANTIGRAVITY_NATIVE_TRANSPORT_MODEL_PREFIX = `${ANTIGRAVITY_NATIVE_TRANSPORT_MODEL_ID}@`;
export const EXTERNAL_HARNESS_IDS = [
  "pi",
  "claude-code",
  "deepseek-harness",
  "opencode",
  "grok",
  "omp",
  "antigravity",
] as const;

/** Open identity space; the Host Registry, not this legacy list, validates installation. */
export type ExternalHarnessId = string;
export type RoutedHarnessId = "codex" | ExternalHarnessId;

const transportModelByHarness: Readonly<Record<string, string>> = {
  pi: PI_NATIVE_TRANSPORT_MODEL_ID,
  "claude-code": CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
  "deepseek-harness": DEEPSEEK_HARNESS_NATIVE_TRANSPORT_MODEL_ID,
  opencode: OPENCODE_NATIVE_TRANSPORT_MODEL_ID,
  grok: GROK_NATIVE_TRANSPORT_MODEL_ID,
  omp: OMP_NATIVE_TRANSPORT_MODEL_ID,
  antigravity: ANTIGRAVITY_NATIVE_TRANSPORT_MODEL_ID,
} as const satisfies Record<ExternalHarnessId, string>;

const harnessByTransportModel = new Map<string, ExternalHarnessId>(
  Object.entries(transportModelByHarness).map(([harnessId, transportModelId]) => [
    transportModelId,
    harnessId as ExternalHarnessId,
  ]),
);

export interface CreateRoute {
  harnessId: RoutedHarnessId;
  routeMode?: "native";
  transportModelId: string;
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  permissionModeId?: HarnessPermissionModeId;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function transportModelIdForHarness(harnessId: ExternalHarnessId): string {
  const legacy = Object.hasOwn(transportModelByHarness, harnessId)
    ? transportModelByHarness[harnessId]
    : undefined;
  return legacy ?? encodeHarnessPluginRoute({ harnessId: harnessPluginIdSchema.parse(harnessId) });
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
  permissionModeId?: HarnessPermissionModeId,
): string {
  if (!model) {
    if (permissionModeId || thinkingOptionId) {
      throw new Error("OMP transport configuration requires a Model Ref");
    }
    return OMP_NATIVE_TRANSPORT_MODEL_ID;
  }
  const parsedModel = harnessModelRefSchema.parse(model);
  const parsedPermissionMode = permissionModeId
    ? harnessPermissionModeIdSchema.parse(permissionModeId)
    : undefined;
  const parsedThinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.parse(thinkingOptionId)
    : undefined;
  if (parsedPermissionMode) {
    return `${OMP_NATIVE_TRANSPORT_MODEL_PREFIX}${parsedModel.id}@${parsedPermissionMode}@${parsedThinking ?? ""}`;
  }
  return `${OMP_NATIVE_TRANSPORT_MODEL_PREFIX}${parsedModel.id}${parsedThinking ? `@${parsedThinking}` : ""}`;
}

export function encodeAntigravityTransportModel(
  model?: HarnessModelRef,
  permissionModeId?: HarnessPermissionModeId,
  thinkingOptionId?: HarnessThinkingOptionId,
): string {
  if (!model) {
    if (permissionModeId || thinkingOptionId) {
      throw new Error("Antigravity transport configuration requires a Model Ref");
    }
    return ANTIGRAVITY_NATIVE_TRANSPORT_MODEL_ID;
  }
  const parsedModel = harnessModelRefSchema.parse(model);
  const parsedPermission = permissionModeId
    ? harnessPermissionModeIdSchema.parse(permissionModeId)
    : undefined;
  const parsedThinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.parse(thinkingOptionId)
    : undefined;
  if (parsedThinking) {
    return `${ANTIGRAVITY_NATIVE_TRANSPORT_MODEL_PREFIX}${parsedModel.id}@${parsedPermission ?? ""}@${parsedThinking}`;
  }
  return `${ANTIGRAVITY_NATIVE_TRANSPORT_MODEL_PREFIX}${parsedModel.id}${parsedPermission ? `@${parsedPermission}` : ""}`;
}

export function decodeAntigravityTransportSelection(
  value: unknown,
): ExternalConfigurationSelection | null {
  if (value === ANTIGRAVITY_NATIVE_TRANSPORT_MODEL_ID) return {};
  if (typeof value !== "string" || !value.startsWith(ANTIGRAVITY_NATIVE_TRANSPORT_MODEL_PREFIX)) {
    return null;
  }
  const components = value.slice(ANTIGRAVITY_NATIVE_TRANSPORT_MODEL_PREFIX.length).split("@");
  if (components.length < 1 || components.length > 3) {
    throw new Error("Antigravity transport configuration has an invalid component count");
  }
  const [modelId, permissionModeId, thinkingOptionId] = components;
  if (components.length === 2 && !permissionModeId) {
    throw new Error("Antigravity transport configuration has an empty Permission Mode");
  }
  if (components.length === 3 && !thinkingOptionId) {
    throw new Error("Antigravity transport configuration has an empty Thinking option");
  }
  const model = harnessModelRefSchema.safeParse({ id: modelId });
  if (!model.success) throw new Error("Antigravity transport Model contains an invalid Model Ref");
  const permissionMode = permissionModeId
    ? harnessPermissionModeIdSchema.safeParse(permissionModeId)
    : null;
  if (permissionMode && !permissionMode.success) {
    throw new Error("Antigravity transport configuration contains an invalid Permission Mode");
  }
  const thinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.safeParse(thinkingOptionId)
    : null;
  if (thinking && !thinking.success) {
    throw new Error("Antigravity transport configuration contains an invalid Thinking option");
  }
  return {
    model: model.data,
    ...(permissionMode?.success ? { permissionModeId: permissionMode.data } : {}),
    ...(thinking?.success ? { thinkingOptionId: thinking.data } : {}),
  };
}

export function decodeOmpTransportSelection(value: unknown): ExternalConfigurationSelection | null {
  if (value === OMP_NATIVE_TRANSPORT_MODEL_ID) return {};
  if (typeof value !== "string" || !value.startsWith(OMP_NATIVE_TRANSPORT_MODEL_PREFIX))
    return null;
  const components = value.slice(OMP_NATIVE_TRANSPORT_MODEL_PREFIX.length).split("@");
  if (components.length < 1 || components.length > 3)
    throw new Error("OMP transport configuration has an invalid component count");
  const [modelId, permissionOrThinkingId, thinkingOptionId] = components;
  if (components.length === 2 && !permissionOrThinkingId)
    throw new Error("OMP transport configuration has an empty Thinking option");
  if (components.length === 3 && !permissionOrThinkingId)
    throw new Error("OMP transport configuration has an empty Permission Mode");
  const model = harnessModelRefSchema.safeParse({ id: modelId });
  if (!model.success) throw new Error("OMP transport Model contains an invalid Model Ref");
  const permissionMode =
    components.length === 3
      ? harnessPermissionModeIdSchema.safeParse(permissionOrThinkingId)
      : null;
  if (permissionMode && !permissionMode.success)
    throw new Error("OMP transport configuration contains an invalid Permission Mode");
  const thinking =
    components.length === 2
      ? harnessThinkingOptionIdSchema.safeParse(permissionOrThinkingId)
      : thinkingOptionId
        ? harnessThinkingOptionIdSchema.safeParse(thinkingOptionId)
        : null;
  if (thinking && !thinking.success)
    throw new Error("OMP transport configuration contains an invalid Thinking option");
  return {
    model: model.data,
    ...(permissionMode?.success ? { permissionModeId: permissionMode.data } : {}),
    ...(thinking?.success ? { thinkingOptionId: thinking.data } : {}),
  };
}

export function decodeOmpTransportModel(value: unknown): HarnessModelRef | null | undefined {
  const selection = decodeOmpTransportSelection(value);
  return selection === null ? null : selection.model;
}

export function encodeOpenCodeTransportModel(
  model?: HarnessModelRef,
  permissionModeId?: HarnessPermissionModeId,
  thinkingOptionId?: HarnessThinkingOptionId,
): string {
  if (!model) {
    if (permissionModeId || thinkingOptionId) {
      throw new Error("OpenCode transport configuration requires a Model Ref");
    }
    return OPENCODE_NATIVE_TRANSPORT_MODEL_ID;
  }
  const parsedModel = harnessModelRefSchema.parse(model);
  const parsedPermissionMode = permissionModeId
    ? harnessPermissionModeIdSchema.parse(permissionModeId)
    : undefined;
  const parsedThinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.parse(thinkingOptionId)
    : undefined;
  if (parsedThinking) {
    return `${OPENCODE_NATIVE_TRANSPORT_MODEL_PREFIX}${parsedModel.id}@${parsedPermissionMode ?? ""}@${parsedThinking}`;
  }
  return `${OPENCODE_NATIVE_TRANSPORT_MODEL_PREFIX}${parsedModel.id}${parsedPermissionMode ? `@${parsedPermissionMode}` : ""}`;
}

export function decodeOpenCodeTransportSelection(
  value: unknown,
): ExternalConfigurationSelection | null {
  if (value === OPENCODE_NATIVE_TRANSPORT_MODEL_ID) return {};
  if (typeof value !== "string" || !value.startsWith(OPENCODE_NATIVE_TRANSPORT_MODEL_PREFIX)) {
    return null;
  }
  const components = value.slice(OPENCODE_NATIVE_TRANSPORT_MODEL_PREFIX.length).split("@");
  if (components.length < 1 || components.length > 3) {
    throw new Error("OpenCode transport configuration has an invalid component count");
  }
  const [modelId, permissionModeId, thinkingOptionId] = components;
  if (components.length === 2 && !permissionModeId) {
    throw new Error("OpenCode transport configuration has an empty Permission Mode");
  }
  if (components.length === 3 && !thinkingOptionId) {
    throw new Error("OpenCode transport configuration has an empty Thinking option");
  }
  const model = harnessModelRefSchema.safeParse({ id: modelId });
  if (!model.success) throw new Error("OpenCode transport Model contains an invalid Model Ref");
  const permissionMode = permissionModeId
    ? harnessPermissionModeIdSchema.safeParse(permissionModeId)
    : null;
  if (permissionMode && !permissionMode.success) {
    throw new Error("OpenCode transport configuration contains an invalid Permission Mode");
  }
  const thinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.safeParse(thinkingOptionId)
    : null;
  if (thinking && !thinking.success) {
    throw new Error("OpenCode transport configuration contains an invalid Thinking option");
  }
  return {
    model: model.data,
    ...(permissionMode?.success ? { permissionModeId: permissionMode.data } : {}),
    ...(thinking?.success ? { thinkingOptionId: thinking.data } : {}),
  };
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
    case "opencode":
      return encodeOpenCodeTransportModel(
        selection.model,
        selection.permissionModeId,
        selection.thinkingOptionId,
      );
    case "grok":
      return encodeGrokTransportModel(
        selection.model,
        selection.permissionModeId,
        selection.thinkingOptionId,
      );
    case "omp":
      return encodeOmpTransportModel(
        selection.model,
        selection.thinkingOptionId,
        selection.permissionModeId,
      );
    case "antigravity":
      return encodeAntigravityTransportModel(
        selection.model,
        selection.permissionModeId,
        selection.thinkingOptionId,
      );
    default:
      return encodeHarnessPluginRoute({
        harnessId: harnessPluginIdSchema.parse(harnessId),
        ...selection,
      });
  }
}

export function decodeExternalTransportSelection(
  harnessId: ExternalHarnessId,
  value: unknown,
): ExternalConfigurationSelection | null {
  const route = decodeHarnessPluginRoute(value);
  if (route) {
    if (route.harnessId !== harnessId) return null;
    return {
      ...(route.model ? { model: route.model } : {}),
      ...(route.thinkingOptionId ? { thinkingOptionId: route.thinkingOptionId } : {}),
      ...(route.permissionModeId ? { permissionModeId: route.permissionModeId } : {}),
    };
  }
  switch (harnessId) {
    case "pi":
      return decodePiTransportSelection(value);
    case "claude-code":
      return decodeClaudeTransportSelection(value);
    case "deepseek-harness":
      return decodeDeepSeekHarnessTransportSelection(value);
    case "opencode":
      return decodeOpenCodeTransportSelection(value);
    case "grok":
      return decodeGrokTransportSelection(value);
    case "omp":
      return decodeOmpTransportSelection(value);
    case "antigravity":
      return decodeAntigravityTransportSelection(value);
    default:
      return null;
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

  const pluginRoute = decodeHarnessPluginRoute(request.params.model);
  if (pluginRoute) {
    return {
      harnessId: pluginRoute.harnessId,
      routeMode: "native",
      transportModelId: request.params.model,
      ...(pluginRoute.model ? { model: pluginRoute.model } : {}),
      ...(pluginRoute.thinkingOptionId ? { thinkingOptionId: pluginRoute.thinkingOptionId } : {}),
      ...(pluginRoute.permissionModeId ? { permissionModeId: pluginRoute.permissionModeId } : {}),
    };
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
  const openCodeSelection = decodeOpenCodeTransportSelection(request.params.model);
  if (openCodeSelection !== null) {
    return {
      harnessId: "opencode",
      routeMode: "native",
      transportModelId: request.params.model,
      ...openCodeSelection,
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
  const ompSelection = decodeOmpTransportSelection(request.params.model);
  if (ompSelection !== null) {
    return {
      harnessId: "omp",
      routeMode: "native",
      transportModelId: request.params.model,
      ...ompSelection,
    };
  }
  const antigravitySelection = decodeAntigravityTransportSelection(request.params.model);
  if (antigravitySelection !== null) {
    return {
      harnessId: "antigravity",
      routeMode: "native",
      transportModelId: request.params.model,
      ...antigravitySelection,
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
