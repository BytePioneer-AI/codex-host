import { describe, expect, it } from "vitest";
import {
  decodeHarnessPluginRoute,
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import { DraftAgentController, KNOWN_RENDERER_AGENTS } from "../src/agent-selection-state.js";
import { cursorModelPickerPresentation } from "../src/cursor-model-picker.js";
import { restoredThreadOwnership } from "../src/renderer-binding-probe.js";
import { modelSelectionForAgent } from "../src/versioned-renderer-adapter.js";
import { RENDERER_AGENT_INSTALL_URLS } from "../src/renderer-agent-picker.js";
import { RENDERER_AGENT_LABELS } from "../src/renderer-agent-icon.js";

describe("Cursor and Kiro selection in one Desktop", () => {
  it("keeps both models isolated and never carries Kiro Thinking into Cursor", () => {
    expect(KNOWN_RENDERER_AGENTS).toEqual(expect.arrayContaining(["kiro-cli", "cursor-cli"]));
    const controller = new DraftAgentController<object>(),
      composer = {};
    const cursor = harnessModelRefSchema.parse({ id: "cursor.Y29tcG9zZXItMi41" });
    const kiro = harnessModelRefSchema.parse({ id: "kiro.test-model" });
    const high = harnessThinkingOptionIdSchema.parse("high"),
      mode = harnessPermissionModeIdSchema.parse("ask");
    controller.mount(composer, ["default"]);
    controller.setExternalModel(composer, "kiro-cli", kiro);
    controller.setExternalThinkingOption(composer, "kiro-cli", high);
    controller.setExternalModel(composer, "cursor-cli", cursor);
    expect(controller.modelForAgent(composer, "cursor-cli")).toEqual(cursor);
    expect(controller.modelForAgent(composer, "kiro-cli")).toEqual(kiro);
    expect(controller.thinkingOptionForAgent(composer, "cursor-cli")).toBeUndefined();
    expect(controller.thinkingOptionForAgent(composer, "kiro-cli")).toBe(high);
    controller.setExternalThinkingOption(composer, "cursor-cli", high);
    expect(controller.thinkingOptionForAgent(composer, "cursor-cli")).toBe(high);
    expect(controller.thinkingOptionForAgent(composer, "kiro-cli")).toBe(high);
    const selection = modelSelectionForAgent(null, null, "cursor-cli", cursor, high, mode);
    if (typeof selection?.model !== "string") throw Error("Missing Cursor carrier");
    expect(decodeHarnessPluginRoute(selection.model)).toMatchObject({
      harnessId: "cursor-cli",
      model: cursor,
      thinkingOptionId: high,
      permissionModeId: mode,
    });
    expect(
      restoredThreadOwnership({
        owner: "external",
        harnessId: "cursor-cli",
        transportModelId: selection.model,
        locked: true,
        history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
      }),
    ).toEqual({
      agent: "cursor-cli",
      model: cursor,
      thinkingOptionId: high,
      permissionModeId: mode,
    });
    expect(RENDERER_AGENT_LABELS["cursor-cli"]).toBe("Cursor CLI (Experimental)");
    expect(RENDERER_AGENT_INSTALL_URLS["cursor-cli"]).toBe(
      "https://cursor.com/docs/cli/installation",
    );
  });
  it("rejects a Kiro carrier when restoring a Cursor-owned Thread", () => {
    const carrier = modelSelectionForAgent(null, null, "kiro-cli")?.model;
    expect(() =>
      restoredThreadOwnership({
        owner: "external",
        harnessId: "cursor-cli",
        transportModelId: String(carrier),
        locked: true,
        history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
      }),
    ).toThrow("incompatible");
  });
});

describe("cursor model picker presentation", () => {
  it("exposes Fast separately and does not repeat Fast in the thinking label", () => {
    const model = harnessModelRefSchema.parse({ id: "cursor.composer" });
    const off = "g.fast~false";
    const on = "g.fast~true";
    const catalog = harnessModelCatalogSchema.parse({
      models: [{ ref: model, label: "Composer 2.5", supportedThinkingOptionIds: [off, on] }],
      defaultModel: model,
      thinkingOptions: [
        { id: off, label: "Off" },
        { id: on, label: "Fast" },
      ],
    });
    const view = cursorModelPickerPresentation({
      status: "ready",
      catalog,
      selected: model,
      selectedThinkingOptionId: on,
      thinkingSelectionSupported: true,
    });
    expect(view.modelLabel).toBe("Composer 2.5");
    expect(view.thinkingLabel).toBeUndefined();
    expect(view.fast).toEqual({ enabled: true, nextThinkingOptionId: off });
    expect(view.groups).toEqual([]);
  });

  it("lists Reasoning independently from Fast", () => {
    const model = harnessModelRefSchema.parse({ id: "cursor.gpt" });
    const medium = "g.fast~false.reasoning~medium";
    const mediumFast = "g.fast~true.reasoning~medium";
    const high = "g.fast~false.reasoning~high";
    const highFast = "g.fast~true.reasoning~high";
    const catalog = harnessModelCatalogSchema.parse({
      models: [
        {
          ref: model,
          label: "GPT-5.6 Sol",
          supportedThinkingOptionIds: [medium, mediumFast, high, highFast],
        },
      ],
      defaultModel: model,
      thinkingOptions: [
        { id: medium, label: "Medium" },
        { id: mediumFast, label: "Medium · Fast" },
        { id: high, label: "High" },
        { id: highFast, label: "High · Fast" },
      ],
    });
    const view = cursorModelPickerPresentation({
      status: "ready",
      catalog,
      selected: model,
      selectedThinkingOptionId: medium,
      thinkingSelectionSupported: true,
    });
    expect(view.groups.map((group) => group.id)).toEqual(["reasoning"]);
    expect(view.thinkingLabel).toBe("Medium");
    expect(view.fast?.enabled).toBe(false);
  });
});
