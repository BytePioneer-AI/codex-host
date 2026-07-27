import type { JsonRpcRequest } from "@codexhost/shared-contracts";

export const PI_NATIVE_TRANSPORT_MODEL_ID = "codexhost/pi-native";

export type CreateRoute =
  | { harnessId: "codex"; transportModelId: string }
  | { harnessId: "pi"; routeMode: "native"; transportModelId: typeof PI_NATIVE_TRANSPORT_MODEL_ID };

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeCreateRoute(request: JsonRpcRequest): CreateRoute | null {
  if (request.method !== "thread/start") return null;
  if (!isJsonObject(request.params) || typeof request.params.model !== "string") {
    throw new Error("thread/start params.model must be text");
  }
  return request.params.model === PI_NATIVE_TRANSPORT_MODEL_ID
    ? {
        harnessId: "pi",
        routeMode: "native",
        transportModelId: PI_NATIVE_TRANSPORT_MODEL_ID,
      }
    : { harnessId: "codex", transportModelId: request.params.model };
}
