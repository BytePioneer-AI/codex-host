import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  isRendererModelPickerDisabled,
  rendererModelPickerPresentation,
  shouldCloseRendererModelPicker,
  syncRendererLabelText,
} from "../src/renderer-model-picker.js";

const model = harnessModelRefSchema.parse({ id: "pi-model-v1.synthetic" });

function catalog(levels: readonly string[]) {
  const thinkingOptions = levels.map((id) => ({
    id: harnessThinkingOptionIdSchema.parse(id),
    label: id === "xhigh" ? "Extra High" : `${id[0]?.toUpperCase() ?? ""}${id.slice(1)}`,
  }));
  return harnessModelCatalogSchema.parse({
    models: [
      {
        ref: model,
        label: "provider / model",
        supportedThinkingOptionIds: thinkingOptions.map(({ id }) => id),
      },
    ],
    defaultModel: model,
    thinkingOptions,
    ...(thinkingOptions[0] ? { defaultThinkingOptionId: thinkingOptions[0].id } : {}),
  });
}

describe("Renderer combined Model and Thinking picker presentation", () => {
  it("does not rewrite an unchanged Thinking label", () => {
    let value: string | null = "High";
    let writes = 0;
    const element = {
      get textContent() {
        return value;
      },
      set textContent(next: string | null) {
        writes += 1;
        value = next;
      },
    };

    expect(syncRendererLabelText(element, "High")).toBe(false);
    expect(writes).toBe(0);
    expect(syncRendererLabelText(element, "Extra High")).toBe(true);
    expect(syncRendererLabelText(element, "Extra High")).toBe(false);
    expect(writes).toBe(1);
  });

  it("shows only Adapter-reported Thinking options and the confirmed label", () => {
    const view = rendererModelPickerPresentation({
      status: "ready",
      catalog: catalog(["off", "low", "high"]),
      selected: model,
      selectedThinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
    });

    expect(view).toEqual({
      modelLabel: "provider / model",
      thinkingLabel: "High",
      thinkingOptions: [
        { id: "off", label: "Off" },
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
      showThinkingSection: true,
      thinkingSelectionEnabled: true,
    });
    expect(view.thinkingOptions.map(({ id }) => id)).not.toContain("xhigh");
    expect(view.thinkingOptions.map(({ id }) => id)).not.toContain("max");
  });

  it("shows Claude runtime-resolved Model display without exposing Thinking controls", () => {
    const claudeModel = harnessModelRefSchema.parse({ id: "claude-model-v1.c29ubmV0" });
    const claudeCatalog = harnessModelCatalogSchema.parse({
      models: [
        {
          ref: claudeModel,
          label: "Family alias",
          resolvedModelLabel: "runtime-custom",
          supportedThinkingOptionIds: ["low", "high"],
        },
      ],
      defaultModel: claudeModel,
      thinkingOptions: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    });

    expect(
      rendererModelPickerPresentation({
        status: "ready",
        catalog: claudeCatalog,
        selected: claudeModel,
        thinkingSelectionSupported: false,
      }),
    ).toEqual({
      modelLabel: "Family alias",
      resolvedModelLabel: "runtime-custom",
      thinkingOptions: [],
      showThinkingSection: false,
      thinkingSelectionEnabled: false,
    });
  });

  it("does not reuse global Thinking options for a Model without a declared list", () => {
    const uninspectedCatalog = harnessModelCatalogSchema.parse({
      models: [{ ref: model, label: "provider / model" }],
      defaultModel: model,
      thinkingOptions: [
        { id: "off", label: "Off" },
        { id: "high", label: "High" },
      ],
      defaultThinkingOptionId: "high",
    });

    expect(
      rendererModelPickerPresentation({
        status: "ready",
        catalog: uninspectedCatalog,
        selected: model,
        selectedThinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      }),
    ).toEqual({
      modelLabel: "provider / model",
      thinkingOptions: [],
      showThinkingSection: false,
      thinkingSelectionEnabled: false,
    });
  });

  it("omits the Thinking section and trigger suffix when Pi reports only off", () => {
    expect(
      rendererModelPickerPresentation({
        status: "ready",
        catalog: catalog(["off"]),
        selected: model,
        selectedThinkingOptionId: harnessThinkingOptionIdSchema.parse("off"),
      }),
    ).toEqual({
      modelLabel: "provider / model",
      thinkingOptions: [{ id: "off", label: "Off" }],
      showThinkingSection: false,
      thinkingSelectionEnabled: false,
    });
  });

  it("shows one non-off Thinking option as read-only", () => {
    expect(
      rendererModelPickerPresentation({
        status: "ready",
        catalog: catalog(["minimal"]),
        selected: model,
        selectedThinkingOptionId: harnessThinkingOptionIdSchema.parse("minimal"),
      }),
    ).toMatchObject({
      thinkingLabel: "Minimal",
      showThinkingSection: true,
      thinkingSelectionEnabled: false,
    });
  });

  it("disables the combined control for loading and selection, but permits retry", () => {
    const readyCatalog = catalog(["off", "low"]);
    expect(isRendererModelPickerDisabled({ status: "loading" })).toBe(true);
    const selectingView = {
      status: "selecting" as const,
      catalog: readyCatalog,
      selected: model,
    };
    expect(isRendererModelPickerDisabled(selectingView)).toBe(true);
    expect(shouldCloseRendererModelPicker(selectingView)).toBe(false);
    expect(shouldCloseRendererModelPicker({ status: "loading" })).toBe(true);
    expect(
      isRendererModelPickerDisabled({
        status: "error",
        catalog: readyCatalog,
        selected: model,
        error: "selection failed",
      }),
    ).toBe(false);
    expect(isRendererModelPickerDisabled({ status: "error", error: "inspection failed" })).toBe(
      true,
    );
  });

  it("uses stable loading and unsupported presentation without inventing options", () => {
    for (const status of ["waitingForAdapter", "loading"] as const) {
      expect(isRendererModelPickerDisabled({ status })).toBe(true);
      expect(rendererModelPickerPresentation({ status })).toEqual({
        modelLabel: "Loading models...",
        thinkingOptions: [],
        showThinkingSection: false,
        thinkingSelectionEnabled: false,
      });
    }
    expect(
      rendererModelPickerPresentation({
        status: "ready",
        catalog: catalog([]),
        selected: model,
      }),
    ).toEqual({
      modelLabel: "provider / model",
      thinkingOptions: [],
      showThinkingSection: false,
      thinkingSelectionEnabled: false,
    });
  });
});
