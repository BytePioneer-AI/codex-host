import {
  harnessModelRefSchema,
  type HarnessModelRef,
  type JsonRpcRequest,
} from "@codexhost/shared-contracts";

export const PI_NATIVE_TRANSPORT_MODEL_ID = "codexhost/pi-native";
export const PI_NATIVE_TRANSPORT_MODEL_PREFIX = `${PI_NATIVE_TRANSPORT_MODEL_ID}@`;

export type CreateRoute =
  | { harnessId: "codex"; transportModelId: string }
  | {
      harnessId: "pi";
      routeMode: "native";
      transportModelId: string;
      model?: HarnessModelRef;
    };

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function decodeCreateRoute(request: JsonRpcRequest): CreateRoute | null {
  if (request.method !== "thread/start") return null;
  if (!isJsonObject(request.params) || typeof request.params.model !== "string") {
    throw new Error("thread/start params.model must be text");
  }
  const model = decodePiTransportModel(request.params.model);
  return model !== null
    ? {
        harnessId: "pi",
        routeMode: "native",
        transportModelId: request.params.model,
        ...(model ? { model } : {}),
      }
    : { harnessId: "codex", transportModelId: request.params.model };
}
