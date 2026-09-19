import { describe, expect, it } from "vitest";
import {
  decodeHarnessPluginRoute,
  harnessIdSchema,
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostThreadIdSchema,
} from "@codexhost/shared-contracts";

import { DraftAgentController, KNOWN_RENDERER_AGENTS } from "../src/agent-selection-state.js";
import { restoredThreadOwnership } from "../src/renderer-binding-probe.js";
import { RENDERER_AGENT_LABELS } from "../src/renderer-agent-icon.js";
import { RENDERER_AGENT_INSTALL_URLS } from "../src/renderer-agent-picker.js";
import { rendererAgentForThreadOwnership } from "../src/renderer-sidebar-agent-icons.js";
import { modelSelectionForAgent } from "../src/versioned-renderer-adapter.js";

describe("WorkBuddy Desktop selection", () => {
  it("keeps WorkBuddy configuration isolated and round trips the shared plugin route", () => {
    expect(KNOWN_RENDERER_AGENTS).toContain("workbuddy");
    const controller = new DraftAgentController<object>();
    const composer = {};
    const workBuddyModel = harnessModelRefSchema.parse({ id: "cb.d29ya2J1ZGR5" });
    const codeBuddyModel = harnessModelRefSchema.parse({ id: "cb.Y29kZWJ1ZGR5" });
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("low");
    const permissionModeId = harnessPermissionModeIdSchema.parse("plan");

    controller.mount(composer, ["default"]);
    controller.setExternalModel(composer, "codebuddy", codeBuddyModel);
    controller.setExternalModel(composer, "workbuddy", workBuddyModel);
    controller.setExternalThinkingOption(composer, "workbuddy", thinkingOptionId);

    expect(controller.modelForAgent(composer, "workbuddy")).toEqual(workBuddyModel);
    expect(controller.modelForAgent(composer, "codebuddy")).toEqual(codeBuddyModel);

    const selection = modelSelectionForAgent(
      null,
      null,
      "workbuddy",
      workBuddyModel,
      thinkingOptionId,
      permissionModeId,
    );
    if (typeof selection?.model !== "string") throw new Error("No WorkBuddy carrier");
    expect(decodeHarnessPluginRoute(selection.model)).toMatchObject({
      harnessId: "workbuddy",
      model: workBuddyModel,
      thinkingOptionId,
      permissionModeId,
    });
    expect(
      restoredThreadOwnership({
        owner: "external",
        harnessId: "workbuddy",
        transportModelId: selection.model,
        locked: true,
        history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
      }),
    ).toEqual({
      agent: "workbuddy",
      model: workBuddyModel,
      thinkingOptionId,
      permissionModeId,
    });
    expect(
      rendererAgentForThreadOwnership({
        threadId: hostThreadIdSchema.parse("workbuddy-thread"),
        owner: "external",
        harnessId: harnessIdSchema.parse("workbuddy"),
      }),
    ).toBe("workbuddy");
    expect(RENDERER_AGENT_LABELS.workbuddy).toBe("WorkBuddy");
    expect(RENDERER_AGENT_INSTALL_URLS.workbuddy).toBe(
      "https://www.workbuddy.ai/docs/workbuddy/Quickstart",
    );
  });

  it("rejects another plugin's carrier", () => {
    const carrier = modelSelectionForAgent(null, null, "codebuddy")?.model;
    expect(() =>
      restoredThreadOwnership({
        owner: "external",
        harnessId: "workbuddy",
        transportModelId: String(carrier),
        locked: true,
        history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
      }),
    ).toThrow("incompatible");
  });
});
