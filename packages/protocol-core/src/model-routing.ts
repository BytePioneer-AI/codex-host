import {
  harnessModelRefSchema,
  type HarnessModelRef,
  type JsonRpcRequest,
} from "@codexhost/shared-contracts";

export const PI_NATIVE_TRANSPORT_MODEL_ID = "codexhost/pi-native";
export const PI_NATIVE_TRANSPORT_MODEL_PREFIX = `${PI_NATIVE_TRANSPORT_MODEL_ID}@`;
export const CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID = "codexhost/claude-code-native";
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
    };

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function transportModelIdForHarness(harnessId: ExternalHarnessId): string {
  return transportModelByHarness[harnessId];
}

export function encodePiTransportModel(model?: HarnessModelRef): string {
  if (!model) return PI_NATIVE_TRANSPORT_MODEL_ID;
  const parsed = harnessModelRefSchema.parse(model);
  return `${PI_NATIVE_TRANSPORT_MODEL_PREFIX}${parsed.id}`;
}

export function decodePiTransportModel(value: unknown): HarnessModelRef | null | undefined {
  if (value === PI_NATIVE_TRANSPORT_MODEL_ID) return undefined;
  if (typeof value !== "string" || !value.startsWith(PI_NATIVE_TRANSPORT_MODEL_PREFIX)) return null;
  const parsed = harnessModelRefSchema.safeParse({
    id: value.slice(PI_NATIVE_TRANSPORT_MODEL_PREFIX.length),
  });
  if (!parsed.success) throw new Error("Pi transport Model contains an invalid Model Ref");
  return parsed.data;
}

export function decodeExternalTransportModel(
  harnessId: ExternalHarnessId,
  value: unknown,
): HarnessModelRef | null | undefined {
  switch (harnessId) {
    case "pi":
      return decodePiTransportModel(value);
    case "claude-code":
      return value === CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID ? undefined : null;
  }
}

export function decodeCreateRoute(request: JsonRpcRequest): CreateRoute | null {
  if (request.method !== "thread/start") return null;
  if (!isJsonObject(request.params) || typeof request.params.model !== "string") {
    throw new Error("thread/start params.model must be text");
  }

  const piModel = decodePiTransportModel(request.params.model);
  if (piModel !== null) {
    return {
      harnessId: "pi",
      routeMode: "native",
      transportModelId: request.params.model,
      ...(piModel ? { model: piModel } : {}),
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
