import { describe, expect, it } from "vitest";
import type { JsonRpcRequest } from "@codexhost/protocol-core";

import { classifyCreateRequestRoute, packageMetadata } from "../src/index.js";

describe("host-runtime package", () => {
  it("declares the composition-root dependencies", () => {
    expect(packageMetadata.dependencies).toHaveLength(8);
    expect(packageMetadata.dependencies).toContain("@codexhost/protocol-core");
    expect(packageMetadata.dependencies).toContain("@codexhost/adapter-claude-code");
    expect(packageMetadata.dependencies).toContain("@codexhost/harness-adapter");
    expect(packageMetadata.dependencies).toContain("@codexhost/shared-contracts");
    expect(packageMetadata.dependencies).toContain("@codexhost/update-manager");
  });

  it("classifies create routes without exposing Model values or request IDs", () => {
    const request = (model: string): JsonRpcRequest => ({
      id: 42,
      method: "thread/start",
      params: { model },
    });

    expect(classifyCreateRequestRoute(request("official/model"), "codex")).toEqual({
      requestMethod: "thread/start",
      modelCarrier: "official-model",
      selectedHarness: "codex",
      selectionSource: "official-model",
    });
    expect(classifyCreateRequestRoute(request("official/model"), "pi")).toEqual({
      requestMethod: "thread/start",
      modelCarrier: "official-model",
      selectedHarness: "pi",
      selectionSource: "default-agent",
    });
    expect(classifyCreateRequestRoute(request("codexhost/pi-native"), "codex")).toEqual({
      requestMethod: "thread/start",
      modelCarrier: "pi-transport",
      selectedHarness: "pi",
      selectionSource: "transport-model",
    });
    expect(classifyCreateRequestRoute(request("codexhost/claude-code-native"), "codex")).toEqual({
      requestMethod: "thread/start",
      modelCarrier: "claude-code-transport",
      selectedHarness: "claude-code",
      selectionSource: "transport-model",
    });
    expect(
      classifyCreateRequestRoute({ id: 43, method: "thread/read", params: {} }, "codex"),
    ).toBeNull();
  });
});
