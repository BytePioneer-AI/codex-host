import { describe, expect, it, vi } from "vitest";
import type { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import {
  confirmedConfiguration,
  modelCatalog,
  modelRef,
  readModels,
  requireModel,
  selectThinking,
} from "../src/configuration.js";

function client(authenticated = true, authType = "gh-cli") {
  return {
    getAuthStatus: vi.fn(async () => ({ isAuthenticated: authenticated, authType })),
    rpc: { models: { list: vi.fn(async () => ({ models: [] })) } },
    listModels: vi.fn(() => {
      throw new Error("Must not use the SDK's permanent catalog cache");
    }),
  };
}

describe("Copilot native model choices", () => {
  it("preselects Auto or the first available model without fabricating an empty catalog choice", () => {
    const auto = { id: "auto", name: "Auto" };
    const first = { id: "first", name: "First" };
    const second = { id: "second", name: "Second" };
    expect(modelCatalog([auto]).defaultModel).toEqual(modelRef("auto"));
    expect(modelCatalog([first, auto, second]).defaultModel).toEqual(modelRef("auto"));
    expect(modelCatalog([first, second]).defaultModel).toEqual(modelRef("first"));
    expect(modelCatalog([first]).defaultModel).toEqual(modelRef("first"));
    expect(modelCatalog([]).defaultModel).toBeUndefined();
  });
  it("does not present a stored but unadvertised Auto effort as effective Thinking", async () => {
    const session = {
      rpc: {
        model: {
          getCurrent: async () => ({ modelId: "auto", reasoningEffort: "high" }),
          list: async () => ({ list: [], providers: [{ kind: "copilot" }] }),
        },
        permissions: { getMode: async () => ({ mode: "manual" }) },
      },
    } as unknown as CopilotSession;
    const state = await confirmedConfiguration(session, client() as unknown as CopilotClient);
    expect(state.resolvedModelLabel).toBe("Auto");
    expect(state.availableThinkingOptions).toEqual([]);
    expect(state.effectiveThinkingOptionId).toBeUndefined();
  });
  it("includes the authenticated native Auto routing choice when concrete models are empty", async () => {
    const native = client();
    expect(await readModels(native as unknown as CopilotClient)).toEqual([
      { id: "auto", name: "Auto" },
    ]);
    expect(await readModels(client(false) as unknown as CopilotClient)).toEqual([]);
    expect(await readModels(client(true, "api-key") as unknown as CopilotClient)).toEqual([]);
    expect(native.listModels).not.toHaveBeenCalled();
  });

  it("uses the refreshed session catalog and provider roster instead of stale global entries", async () => {
    const native = client();
    const list = vi.fn(async () => ({
      list: [
        { id: "native-model", name: "Native", supportedReasoningEfforts: ["low", "high"] },
        { id: "blocked", name: "Blocked", policy: { state: "disabled" } },
      ],
      providers: [{ kind: "copilot" }],
    }));
    const session = { rpc: { model: { list } } } as unknown as CopilotSession;
    const models = await readModels(native as unknown as CopilotClient, session);
    expect(models.map(({ id }) => id)).toEqual(["auto", "native-model"]);
    expect(requireModel(models, "native-model").supportedReasoningEfforts).toEqual(["low", "high"]);
    expect(() => requireModel(models, "blocked")).toThrow("does not offer");
    expect(list).toHaveBeenCalledWith({ skipCache: true });
    expect(native.rpc.models.list).not.toHaveBeenCalled();
    list.mockResolvedValue({ list: [], providers: [] });
    expect(await readModels(native as unknown as CopilotClient, session)).toEqual([]);
  });

  it("sets an advertised effort without reselecting the model and rejects unadvertised efforts", async () => {
    const setReasoningEffort = vi.fn(async () => ({ reasoningEffort: "high" }));
    const setModel = vi.fn();
    const session = {
      setModel,
      rpc: { model: { setReasoningEffort } },
    } as unknown as CopilotSession;
    const models = [
      { id: "native-model", name: "Native", supportedReasoningEfforts: ["low", "high"] },
      { id: "auto", name: "Auto" },
    ];
    await selectThinking(session, models, "native-model", "high");
    expect(setReasoningEffort).toHaveBeenCalledWith({ reasoningEffort: "high" });
    expect(setModel).not.toHaveBeenCalled();
    await expect(selectThinking(session, models, "auto", "high")).rejects.toMatchObject({
      code: "invalidRequest",
    });
    expect(setReasoningEffort).toHaveBeenCalledTimes(1);
  });
});
