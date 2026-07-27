import type { JsonRpcRequest } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { PI_NATIVE_TRANSPORT_MODEL_ID, decodeCreateRoute } from "../src/index.js";

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
});
