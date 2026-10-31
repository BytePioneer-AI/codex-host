import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const { publicModels, nativeModel, readModels } = createRequire(import.meta.url)(
  "../assets/companion/models.cjs",
);

const model = {
  name: "provider//configured-model",
  display_name: "Configured Model",
  selectable: true,
  status: true,
  is_default: true,
  client_connect: false,
  provider: "provider",
  ak: "fixture-api-key",
  sk: "fixture-secondary-secret",
  base_url: "https://provider.example/v1",
  config_source: 3,
  is_preset: false,
};

describe("TRAE CN configured model projection", () => {
  it("exposes only selectable, unique models and no provider credentials or implicit default", () => {
    const catalog = publicModels([
      model,
      model,
      { ...model, name: "hidden", selectable: false },
      { ...model, name: "disabled", status: false },
    ]);
    expect(catalog).toEqual([
      { id: model.name, label: model.display_name, multimodal: false, provider: "provider" },
    ]);
    expect(JSON.stringify(catalog)).not.toContain("fixture-");
    expect(JSON.stringify(catalog)).not.toContain("default");
    expect(JSON.stringify(catalog)).not.toContain("provider.example");
  });

  it("keeps app-managed encrypted credentials on the native remote-service route", () => {
    expect(nativeModel([model], model.name)).toMatchObject({
      config_name: model.name,
      display_model_name: model.display_name,
      ak: model.ak,
      use_remote_service: true,
      is_preset: false,
    });
  });

  it("preserves local credential routing when the app reports a client connection", () => {
    expect(nativeModel([{ ...model, client_connect: true }], model.name).use_remote_service).toBe(
      false,
    );
  });

  it("matches the app's remote routing default for native preset models", () => {
    expect(
      nativeModel([{ ...model, client_connect: undefined }], model.name).use_remote_service,
    ).toBe(true);
  });

  it("rejects a removed or disabled selection", () => {
    expect(() => nativeModel([model], "removed")).toThrow("no longer available");
    expect(() => nativeModel([{ ...model, status: false }], model.name)).toThrow(
      "no longer available",
    );
  });

  it("reads the native conversation function and never falls back to the settings catalog", async () => {
    const call = vi.fn(async () => ({
      list: [
        { function: "builder_v3", models: [model, { ...model, name: "disabled", status: false }] },
      ],
    }));
    expect(await readModels({ call }, "builder_v3", true)).toEqual([model]);
    expect(call).toHaveBeenCalledExactlyOnceWith("model", "model_list_by_function", {
      functions: ["builder_v3"],
      force_refresh: true,
    });
    await expect(readModels({ call }, "solo_agent")).rejects.toThrow(
      "requested conversation model pool",
    );
    expect(call).not.toHaveBeenCalledWith("model", "model_list", expect.anything());
  });
});
