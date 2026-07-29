import type { JsonRpcRequest } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
  PI_NATIVE_TRANSPORT_MODEL_ID,
  decodeCreateRoute,
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
});
