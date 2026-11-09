import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  rendererModelPickerMainMenuPlacement,
  rendererModelPickerModelMenuPlacement,
  rendererModelPickerStandaloneModelMenuPlacement,
  rendererModelSelectionNoticePlacement,
} from "../src/renderer-model-picker-positioning.js";

import {
  isRendererModelPickerDisabled,
  rendererModelPickerPresentation,
  rendererModelSelectionFailed,
  rendererModelSelectionNoticeContent,
  shouldCloseRendererModelPicker,
  shouldOpenRendererModelSelectionNotice,
  syncRendererLabelText,
  type RendererModelControlView,
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
  it("uses the same label and Thinking options for a Fast selection", () => {
    const fast = harnessModelRefSchema.parse({ id: "priority" });
    const normal = catalog(["off", "high"]);
    const withFast = harnessModelCatalogSchema.parse({
      ...normal,
      models: normal.models.map((entry) => ({ ...entry, fastModel: fast })),
    });
    expect(
      rendererModelPickerPresentation({
        status: "ready",
        catalog: withFast,
        selected: fast,
        selectedThinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      }),
    ).toMatchObject({ modelLabel: "provider / model", thinkingLabel: "High" });
  });
  it("anchors the main menu's right edge to the model trigger", () => {
    expect(
      rendererModelPickerMainMenuPlacement(
        { left: 700, right: 900, top: 820 },
        { width: 1200, height: 900 },
        180,
      ),
    ).toEqual({ left: 720, width: 180, bottom: 88 });
  });

  it("keeps the main menu inside the viewport when the trigger is near an edge", () => {
    expect(
      rendererModelPickerMainMenuPlacement(
        { left: 0, right: 50, top: 820 },
        { width: 240, height: 900 },
        180,
      ).left,
    ).toBe(8);
  });

  it("opens the model-only picker directly above the model trigger", () => {
    expect(
      rendererModelPickerStandaloneModelMenuPlacement(
        { left: 700, right: 900, top: 820 },
        { width: 1200, height: 900 },
      ),
    ).toEqual({ left: 620, width: 280, maxHeight: 360, bottom: 88 });
  });

  it("keeps the model submenu top-aligned with the main menu while flipping left", () => {
    expect(
      rendererModelPickerModelMenuPlacement(
        { left: 700, right: 1120, top: 100 },
        { width: 1200, height: 900 },
      ),
    ).toEqual({ left: 416, top: 100, width: 280, maxHeight: 360 });
  });

  it("keeps the model submenu on the right when there is enough space", () => {
    expect(
      rendererModelPickerModelMenuPlacement(
        { left: 100, right: 280, top: 100 },
        { width: 1200, height: 900 },
      ),
    ).toEqual({ left: 284, top: 100, width: 280, maxHeight: 360 });
  });

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

  it("shows a runtime-resolved Model label after the selected Model", () => {
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

  it("shows Claude Thinking options through the shared picker when selection is enabled", () => {
    const claudeModel = harnessModelRefSchema.parse({ id: "claude-model-v1.c29ubmV0" });
    const claudeCatalog = harnessModelCatalogSchema.parse({
      models: [
        {
          ref: claudeModel,
          label: "Family alias",
          supportedThinkingOptionIds: ["off", "auto", "high"],
        },
      ],
      defaultModel: claudeModel,
      thinkingOptions: [
        { id: "off", label: "Off" },
        { id: "auto", label: "Auto" },
        { id: "high", label: "High" },
      ],
      defaultThinkingOptionId: "auto",
    });

    expect(
      rendererModelPickerPresentation({
        status: "ready",
        catalog: claudeCatalog,
        selected: claudeModel,
        selectedThinkingOptionId: harnessThinkingOptionIdSchema.parse("auto"),
        thinkingSelectionSupported: true,
      }),
    ).toMatchObject({
      thinkingLabel: "Auto",
      thinkingOptions: [
        { id: "off", label: "Off" },
        { id: "auto", label: "Auto" },
        { id: "high", label: "High" },
      ],
      showThinkingSection: true,
      thinkingSelectionEnabled: true,
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

describe("Renderer Model selection rejection notice", () => {
  const ultracodeRejection =
    "Claude Code reports Ultracode is unavailable for the selected Model; choose another Model or Thinking option";
  const rejectedCatalog = catalog(["high", "ultracode"]);
  const rejected: RendererModelControlView = {
    status: "error",
    catalog: rejectedCatalog,
    selected: model,
    selectedThinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
    error: ultracodeRejection,
    selectionRejected: "model",
    selectionErrorId: 3,
  };

  it("marks only rejected user selections, not catalog or inspection failures", () => {
    expect(rendererModelSelectionFailed(rejected)).toBe(true);
    expect(rendererModelSelectionFailed({ ...rejected, selectionRejected: "thinking" })).toBe(true);
    const catalogFailure: RendererModelControlView = {
      status: "error",
      catalog: rejectedCatalog,
      selected: model,
      error: "Existing Thread Model is absent from the current Catalog",
    };
    expect(rendererModelSelectionFailed(catalogFailure)).toBe(false);
    expect(rendererModelSelectionFailed({ status: "error", error: "inspection failed" })).toBe(
      false,
    );
    // A later selection or reload replaces the view, which clears the trigger mark.
    expect(rendererModelSelectionFailed({ ...rejected, status: "selecting" })).toBe(false);
    expect(rendererModelSelectionFailed({ ...rejected, status: "ready" })).toBe(false);
    expect(rendererModelSelectionFailed({ ...rejected, error: "" })).toBe(false);
  });

  it("opens the notice once per rejection id, so re-renders never replay it", () => {
    expect(shouldOpenRendererModelSelectionNotice(rejected, 0)).toBe(true);
    expect(shouldOpenRendererModelSelectionNotice(rejected, 2)).toBe(true);
    expect(shouldOpenRendererModelSelectionNotice(rejected, 3)).toBe(false);
    // A remounted Composer starts from the newest presented id and skips older ones.
    expect(shouldOpenRendererModelSelectionNotice(rejected, 5)).toBe(false);
    // Repeating the same rejected choice gets a new id and shows the notice again.
    expect(shouldOpenRendererModelSelectionNotice({ ...rejected, selectionErrorId: 4 }, 3)).toBe(
      true,
    );
    const withoutId: RendererModelControlView = { ...rejected };
    delete withoutId.selectionErrorId;
    expect(shouldOpenRendererModelSelectionNotice(withoutId, 0)).toBe(false);
    expect(
      shouldOpenRendererModelSelectionNotice(
        {
          status: "error",
          catalog: rejectedCatalog,
          error: "External configuration control is unavailable",
          selectionErrorId: 9,
        },
        0,
      ),
    ).toBe(false);
  });

  it("titles the notice by the rejected choice and keeps the Host message", () => {
    expect(rendererModelSelectionNoticeContent(rejected)).toEqual({
      heading: "Couldn't switch Model",
      message: ultracodeRejection,
    });
    expect(rendererModelSelectionNoticeContent(rejected, "zh-CN")).toEqual({
      heading: "无法切换模型",
      message: ultracodeRejection,
    });
    expect(
      rendererModelSelectionNoticeContent({ ...rejected, selectionRejected: "thinking" }, "en"),
    ).toEqual({ heading: "Couldn't switch Thinking option", message: ultracodeRejection });
    expect(
      rendererModelSelectionNoticeContent({ ...rejected, selectionRejected: "thinking" }, "zh-CN")
        .heading,
    ).toBe("无法切换思考选项");
  });

  it("places the notice just above the Model trigger with right edges aligned", () => {
    expect(
      rendererModelSelectionNoticePlacement(
        { left: 700, right: 900, top: 820 },
        { width: 1200, height: 900 },
      ),
    ).toEqual({ right: 300, bottom: 88, maxWidth: 320, maxHeight: 804 });
  });

  it("keeps the notice inside a narrow viewport whatever its text width", () => {
    const placement = rendererModelSelectionNoticePlacement(
      { left: 0, right: 50, top: 820 },
      { width: 240, height: 900 },
    );
    expect(placement).toEqual({ right: 8, bottom: 88, maxWidth: 224, maxHeight: 804 });
    // Widest possible notice still starts at the left collision padding.
    expect(240 - placement.right - placement.maxWidth).toBe(8);
    expect(
      rendererModelSelectionNoticePlacement(
        { left: 1150, right: 1199, top: 820 },
        { width: 1200, height: 900 },
      ).right,
    ).toBe(8);
  });
});
