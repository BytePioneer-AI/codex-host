import { describe, expect, it } from "vitest";
import type { JsonRpcRequest } from "@codexhost/protocol-core";

import { classifyCreateRequestRoute, packageMetadata } from "../src/index.js";

describe("host-runtime package", () => {
  it("declares the composition-root dependencies", () => {
    expect(packageMetadata.dependencies).toHaveLength(14);
    expect(packageMetadata.dependencies).toContain("@codexhost/protocol-core");
    expect(packageMetadata.dependencies).toContain("@codexhost/adapter-claude-code");
    expect(packageMetadata.dependencies).toContain("@codexhost/adapter-deepseek-harness");
    expect(packageMetadata.dependencies).toContain("@codexhost/adapter-grok");
    expect(packageMetadata.dependencies).toContain("@codexhost/adapter-opencode");
    expect(packageMetadata.dependencies).toContain("@codexhost/adapter-qwen-code");
    expect(packageMetadata.dependencies).toContain("@codexhost/adapter-omp");
    expect(packageMetadata.dependencies).toContain("@codexhost/harness-adapter");
    expect(packageMetadata.dependencies).toContain("@codexhost/harness-broker");
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
    expect(classifyCreateRequestRoute(request("codexhost/grok-native"), "codex")).toEqual({
      requestMethod: "thread/start",
      modelCarrier: "grok-transport",
      selectedHarness: "grok",
      selectionSource: "transport-model",
    });
    expect(classifyCreateRequestRoute(request("codexhost/opencode-native"), "codex")).toEqual({
      requestMethod: "thread/start",
      modelCarrier: "opencode-transport",
      selectedHarness: "opencode",
      selectionSource: "transport-model",
    });
    expect(
      classifyCreateRequestRoute(request("codexhost/deepseek-harness-native"), "codex"),
    ).toEqual({
      requestMethod: "thread/start",
      modelCarrier: "deepseek-harness-transport",
      selectedHarness: "deepseek-harness",
      selectionSource: "transport-model",
    });
    expect(
      classifyCreateRequestRoute({ id: 43, method: "thread/read", params: {} }, "codex"),
    ).toBeNull();
  });
});
