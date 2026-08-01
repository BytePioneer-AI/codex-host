import { harnessModelRefSchema, type JsonRpcRequest } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
  PI_NATIVE_TRANSPORT_MODEL_ID,
  decodeCreateRoute,
  decodeExternalTransportModel,
  decodePiTransportModel,
  encodePiTransportModel,
  transportModelIdForHarness,
} from "../src/index.js";

describe("external Harness transport model routing", () => {
  it.each([
    ["pi", PI_NATIVE_TRANSPORT_MODEL_ID],
    ["claude-code", CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID],
  ] as const)("decodes the %s native transport token", (harnessId, transportModelId) => {
    const request: JsonRpcRequest = {
      id: 2,
      method: "thread/start",
      params: { model: transportModelId },
    };
    expect(decodeCreateRoute(request)).toEqual({
      harnessId,
      routeMode: "native",
      transportModelId,
    });
    expect(transportModelIdForHarness(harnessId)).toBe(transportModelId);
  });

  it("keeps official models transparent and ignores other methods", () => {
    expect(
      decodeCreateRoute({ id: 3, method: "thread/start", params: { model: "official/model" } }),
    ).toEqual({ harnessId: "codex", transportModelId: "official/model" });
    expect(decodeCreateRoute({ id: 4, method: "model/list", params: {} })).toBeNull();
  });

  it("round-trips a bounded opaque selected Pi Model Ref", () => {
    const model = harnessModelRefSchema.parse({ id: "pi-model-v1.cHJvdmlkZXItaWQ" });
    const transportModelId = encodePiTransportModel(model);

    expect(transportModelId).toBe(`${PI_NATIVE_TRANSPORT_MODEL_ID}@${model.id}`);
    expect(decodePiTransportModel(transportModelId)).toEqual(model);
    expect(
      decodeCreateRoute({
        id: 5,
        method: "thread/start",
        params: { model: transportModelId },
      }),
    ).toEqual({
      harnessId: "pi",
      routeMode: "native",
      transportModelId,
      model,
    });
  });

  it("decodes existing Thread carriers only for their owning Harness", () => {
    const model = harnessModelRefSchema.parse({ id: "pi-model-v1.cHJvdmlkZXItaWQ" });
    const selectedPi = encodePiTransportModel(model);

    expect(decodeExternalTransportModel("pi", PI_NATIVE_TRANSPORT_MODEL_ID)).toBeUndefined();
    expect(decodeExternalTransportModel("pi", selectedPi)).toEqual(model);
    expect(
      decodeExternalTransportModel("claude-code", CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID),
    ).toBeUndefined();
    expect(decodeExternalTransportModel("claude-code", selectedPi)).toBeNull();
    expect(decodeExternalTransportModel("pi", CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID)).toBeNull();
  });

  it("rejects malformed selected Pi carriers instead of forwarding them as official Models", () => {
    for (const model of [
      `${PI_NATIVE_TRANSPORT_MODEL_ID}@`,
      `${PI_NATIVE_TRANSPORT_MODEL_ID}@provider/model`,
      `${PI_NATIVE_TRANSPORT_MODEL_ID}@${"x".repeat(513)}`,
    ]) {
      expect(() => decodeCreateRoute({ id: 6, method: "thread/start", params: { model } })).toThrow(
        "invalid Model Ref",
      );
    }
    expect(decodePiTransportModel("official/model")).toBeNull();
    expect(() =>
      decodeExternalTransportModel("pi", `${PI_NATIVE_TRANSPORT_MODEL_ID}@provider/model`),
    ).toThrow("invalid Model Ref");
  });
});
