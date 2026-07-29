import { harnessModelRefSchema, type JsonRpcRequest } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  PI_NATIVE_TRANSPORT_MODEL_ID,
  decodeCreateRoute,
  decodePiTransportModel,
  encodePiTransportModel,
} from "../src/index.js";

describe("Pi transport model routing", () => {
  it("decodes only thread/start transport selection", () => {
    const piRequest: JsonRpcRequest = {
      id: 2,
      method: "thread/start",
      params: { model: PI_NATIVE_TRANSPORT_MODEL_ID },
    };
    expect(decodeCreateRoute(piRequest)).toEqual({
      harnessId: "pi",
      routeMode: "native",
      transportModelId: PI_NATIVE_TRANSPORT_MODEL_ID,
    });
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
  });
});
