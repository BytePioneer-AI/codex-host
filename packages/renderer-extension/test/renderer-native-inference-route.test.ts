import { describe, expect, it, vi } from "vitest";
import { hostThreadIdSchema } from "@codexhost/shared-contracts";
import { createRendererModelClient } from "../src/renderer-model-client.js";
import { usesIndependentNativeInference } from "../src/renderer-native-thread.js";

describe("native custom inference has a separate Billing Source", () => {
  const config = {
    model_provider: "custom",
    model_providers: {
      custom: {
        base_url: "http://127.0.0.1:15721/v1",
        experimental_bearer_token: "PROXY_MANAGED",
        requires_openai_auth: true,
      },
    },
  };

  it("reads the active native config on the same Host instead of guessing from a GPT model ID", async () => {
    const sendRequest = vi.fn().mockResolvedValue({ config });
    const client = createRendererModelClient([{ sendRequest }]);
    expect(await client?.usesIndependentNativeInference?.()).toBe(true);
    expect(sendRequest).toHaveBeenCalledExactlyOnceWith("config/read", { includeLayers: false });
    expect(config.model_providers.custom.requires_openai_auth).toBe(true);
  });

  it.each([
    { base_url: "https://api.githubcopilot.com", env_key: "COPILOT_KEY" },
    { base_url: "https://relay.example/v1", requires_openai_auth: false },
  ])("recognizes explicit independent provider authentication: %j", (provider) => {
    expect(
      usesIndependentNativeInference({
        config: { model_provider: "custom", model_providers: { custom: provider } },
      }),
    ).toBe(true);
  });

  it.each([
    { model_provider: "openai", model_providers: config.model_providers },
    {
      model_provider: "cc-switch-official",
      model_providers: { "cc-switch-official": config.model_providers.custom },
    },
    { model_provider: "custom" },
    {
      model_provider: "custom",
      model_providers: {
        custom: { base_url: "https://relay.example", requires_openai_auth: true },
      },
    },
    ...[
      "https://api.openai.com/v1",
      "https://chatgpt.com/backend-api/codex",
      "https://edge.chatgpt.com",
      "file:///tmp/proxy",
      "not a URL",
    ].map((base_url) => ({
      model_provider: "custom",
      model_providers: { custom: { ...config.model_providers.custom, base_url } },
    })),
  ])("keeps official or unverified inference quota-gated: %j", (value) => {
    expect(usesIndependentNativeInference({ config: value })).toBe(false);
  });

  it("propagates config RPC failures rather than inventing an independent route", async () => {
    const sendRequest = vi.fn().mockRejectedValue(new Error("Host disconnected"));
    const client = createRendererModelClient([{ sendRequest }]);
    await expect(client?.usesIndependentNativeInference?.()).rejects.toThrow("Host disconnected");
  });

  it.each(["openai", "custom"])(
    "uses the existing Thread's %s provider, not the default for new Threads",
    async (modelProvider) => {
      const threadId = hostThreadIdSchema.parse("synthetic-native-route-thread");
      const sendRequest = vi
        .fn()
        .mockResolvedValueOnce({
          thread: { id: threadId, modelProvider, cliVersion: "0.151.0" },
        })
        .mockResolvedValueOnce({ config });
      const client = createRendererModelClient([{ sendRequest }]);
      expect(await client?.usesIndependentNativeInference?.({ threadId })).toBe(
        modelProvider === "custom",
      );
      expect(sendRequest.mock.calls).toEqual([
        ["thread/read", { threadId, includeTurns: false }],
        ["config/read", { includeLayers: false }],
      ]);
    },
  );

  it("rejects an unverified Thread instead of reusing the default custom route", async () => {
    const threadId = hostThreadIdSchema.parse("synthetic-native-route-thread");
    const sendRequest = vi.fn().mockResolvedValue({
      thread: { id: "wrong-thread", modelProvider: "custom", cliVersion: "0.151.0" },
    });
    const client = createRendererModelClient([{ sendRequest }]);
    await expect(client?.usesIndependentNativeInference?.({ threadId })).rejects.toThrow(
      /ownership/,
    );
    expect(sendRequest).toHaveBeenCalledTimes(1);
  });

  it("uses the historical Thread's workspace config rather than another project's credentials", async () => {
    const threadId = hostThreadIdSchema.parse("synthetic-native-route-thread");
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({
        thread: {
          id: threadId,
          modelProvider: "custom",
          cliVersion: "0.159.2",
          cwd: "/work/history",
        },
      })
      .mockResolvedValueOnce({ config: { ...config, model_providers: {} } });
    const client = createRendererModelClient([{ sendRequest }]);
    expect(await client?.usesIndependentNativeInference?.({ threadId })).toBe(false);
    expect(sendRequest).toHaveBeenLastCalledWith("config/read", {
      includeLayers: false,
      cwd: "/work/history",
    });
  });
});
