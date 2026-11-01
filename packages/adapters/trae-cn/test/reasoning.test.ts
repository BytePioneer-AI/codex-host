import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
const { modelThinkingPolicy } = createRequire(import.meta.url)("../assets/companion/reasoning.cjs");
const { publicModels } = createRequire(import.meta.url)("../assets/companion/models.cjs");
const { desktopModelSettings } = createRequire(import.meta.url)("../assets/companion/settings.cjs");

describe("TRAE CN native Thinking policy", () => {
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
