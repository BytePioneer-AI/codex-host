import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import {
  modelCatalog,
  modelRef,
  nativeThinkingSelection,
  confirmedThinking,
} from "../src/models.js";
import type { BridgeInspection } from "../src/protocol.js";
const { nativeModel, prepareModel } = createRequire(import.meta.url)(
  "../assets/companion/models.cjs",
);
const { modelThinkingPolicy } = createRequire(import.meta.url)("../assets/companion/reasoning.cjs");
const { publicModels } = createRequire(import.meta.url)("../assets/companion/models.cjs");
const { desktopModelSettings } = createRequire(import.meta.url)("../assets/companion/settings.cjs");

describe("TRAE CN native Thinking policy", () => {
  it("uses model-scoped opaque choices and hides unimplemented Companion controls", () => {
    const inspection: BridgeInspection = {
      application: { name: "Trae CN", version: "fixture", root: "/app", executable: "/app/trae" },
      instanceId: "fixture",
      workspaceFolders: ["/workspace"],
      agentType: "builder_v3",
      configuration: { modelSelection: "per-request", thinkingSelection: "per-request" },
      models: ["one", "two"].map((id) => ({
        id,
        label: id,
        provider: "native",
        multimodal: false,
        thinking: { field: "reasoning_effort_level", options: ["light", "high"] },
      })),
    };
    const catalog = modelCatalog(inspection);
    expect(catalog.thinkingOptions).toHaveLength(4);
    expect(new Set(catalog.thinkingOptions.map((option) => option.id)).size).toBe(4);
    const first = catalog.models[0]?.supportedThinkingOptionIds?.[0];
    if (!first) throw new Error("Missing fixture Thinking option");
    expect(nativeThinkingSelection(inspection, modelRef("builder_v3", "one"), first)).toEqual({
      field: "reasoning_effort_level",
      level: "light",
    });
    expect(() => nativeThinkingSelection(inspection, modelRef("builder_v3", "two"), first)).toThrow(
      "does not belong",
    );
    expect(
      confirmedThinking({ config_name: "one", reasoning_effort_level: "light" }, inspection),
    ).toBe(first);
    expect(
      confirmedThinking({ config_name: "one", reasoning_effort: "light" }, inspection),
    ).toBeUndefined();
    expect(
      confirmedThinking({ config_name: "one", reasoning_effort_level: "medium" }, inspection),
    ).toBeUndefined();
    inspection.configuration = { modelSelection: "per-request" };
    expect(modelCatalog(inspection).thinkingOptions).toEqual([]);
    expect(
      modelCatalog(inspection).models.every(
        (model) => model.supportedThinkingOptionIds?.length === 0,
      ),
    ).toBe(true);
  });
  it("prepares exactly the requested native Thinking field without selecting a default or sending a prompt", async () => {
    const model = {
      name: "native",
      config_source: 1,
      reasoning_effort_config: {
        support_thinking: true,
        options: ["light", "high"],
        default_level: "high",
      },
    };
    const thinking = { field: "reasoning_effort_level", level: "light" };
    expect(nativeModel([model], "native", thinking)).toMatchObject({
      reasoning_effort_level: "light",
    });
    expect(nativeModel([model], "native").reasoning_effort_level).toBeUndefined();
    expect(() =>
      nativeModel([model], "native", { field: "reasoning_effort", level: "light" }),
    ).toThrow();
    expect(() =>
      nativeModel([model], "native", { field: "reasoning_effort_level", level: "medium" }),
    ).toThrow();
    const call = vi.fn(async () => ({ list: [{ function: "builder_v3", models: [model] }] }));
    expect(await prepareModel({ call }, "builder_v3", "native", thinking)).toEqual({
      agentType: "builder_v3",
      modelId: "native",
      thinking,
    });
    expect(call).toHaveBeenCalledExactlyOnceWith("model", "model_list_by_function", {
      functions: ["builder_v3"],
      force_refresh: true,
    });
    const internal = { name: "internal", config_source: 1, reasoning_effort_options: ["high"] };
    expect(
      nativeModel(
        [internal],
        "internal",
        { field: "reasoning_effort", level: "high" },
        { internal: true },
      ),
    ).toMatchObject({ reasoning_effort: "high" });
  });
  it("uses the ordinary native model's declared options only with a valid default", () => {
    const model = {
      config_source: 1,
      reasoning_effort_config: {
        support_thinking: true,
        options: ["none", "high"],
        default_level: "high",
      },
    };
    expect(modelThinkingPolicy(model)).toEqual({
      field: "reasoning_effort_level",
      options: ["none", "high"],
    });
    for (const config of [
      { ...model.reasoning_effort_config, support_thinking: false },
      { ...model.reasoning_effort_config, default_level: "missing" },
      { ...model.reasoning_effort_config, options: ["high", "high"] },
      { ...model.reasoning_effort_config, options: [" "] },
    ])
      expect(modelThinkingPolicy({ ...model, reasoning_effort_config: config })).toBeUndefined();
    expect(
      modelThinkingPolicy({ config_source: 1, reasoning_effort_options: ["high"] }),
    ).toBeUndefined();
  });
  it("matches the internal account's legacy field and known-level filtering", () => {
    expect(
      modelThinkingPolicy(
        { config_source: 1, reasoning_effort_options: [" HIGH ", "low", "high", "unknown"] },
        true,
      ),
    ).toEqual({ field: "reasoning_effort", options: ["high", "low"] });
    expect(
      modelThinkingPolicy({ config_source: 1, reasoning_effort_options: ["unknown"] }, true),
    ).toBeUndefined();
  });
  it("validates custom parameter declarations without assuming official level names or defaults", () => {
    const model = {
      config_source: 3,
      reasoning_effort_config: {
        parameter: "thinking.level",
        support_thinking: true,
        options: ["enabled", "disabled"],
      },
    };
    expect(modelThinkingPolicy(model)).toEqual({
      field: "reasoning_effort_level",
      options: ["enabled", "disabled"],
    });
    expect(
      modelThinkingPolicy({
        ...model,
        reasoning_effort_config: { ...model.reasoning_effort_config, parameter: "" },
      }),
    ).toBeUndefined();
    expect(
      modelThinkingPolicy({
        ...model,
        reasoning_effort_config: {
          ...model.reasoning_effort_config,
          options: ["enabled", "enabled"],
        },
      }),
    ).toBeUndefined();
    const legacy = {
      config_source: 3,
      thinking_enable: 1,
      reasoning_param: { parameter: "thinking", values: ["on", "off"] },
    };
    expect(modelThinkingPolicy(legacy, true)).toEqual({
      field: "reasoning_effort_level",
      options: ["on", "off"],
    });
    expect(modelThinkingPolicy({ ...legacy, thinking_enable: 0 })).toBeUndefined();
  });
  it("exports options while retaining model credentials and parameter configuration in the app", () => {
    const result = publicModels([
      {
        name: "configured",
        config_source: 3,
        ak: "fixture-secret",
        base_url: "https://private.example/",
        reasoning_effort_config: {
          parameter: "private-parameter",
          support_thinking: true,
          options: ["on", "off"],
        },
      },
    ]);
    expect(result[0].thinking).toEqual({ field: "reasoning_effort_level", options: ["on", "off"] });
    expect(JSON.stringify(result)).not.toMatch(/fixture-secret|private\.example|private-parameter/);
  });
  it("reads only the account-policy boolean from the credential-owning extension host", async () => {
    const executeCommand = vi.fn(async () => ({
      token: "fixture-secret",
      account: { scope: "bytedance", username: "private-name" },
    }));
    expect(await desktopModelSettings({ commands: { executeCommand } })).toEqual({
      internal: true,
    });
    expect(executeCommand).toHaveBeenCalledExactlyOnceWith("icube.common.getUserInfo");
    executeCommand.mockResolvedValueOnce({
      token: "",
      account: { scope: "bytedance", username: "private-name" },
    });
    await expect(desktopModelSettings({ commands: { executeCommand } })).rejects.toMatchObject({
      code: "authenticationRequired",
    });
  });
});
