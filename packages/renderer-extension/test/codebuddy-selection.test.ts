import { describe, expect, it } from "vitest";
import {
  decodeHarnessPluginRoute,
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import { DraftAgentController, KNOWN_RENDERER_AGENTS } from "../src/agent-selection-state.js";
import { restoredThreadOwnership } from "../src/renderer-binding-probe.js";
import { modelSelectionForAgent } from "../src/versioned-renderer-adapter.js";
import { RENDERER_AGENT_INSTALL_URLS } from "../src/renderer-agent-picker.js";

describe("CodeBuddy Desktop selection", () => {
  it("keeps model/effort/permissions isolated and round trips the shared plugin carrier", () => {
    expect(KNOWN_RENDERER_AGENTS).toContain("codebuddy");
    const controller = new DraftAgentController<object>(),
      composer = {};
    const model = harnessModelRefSchema.parse({ id: "cb.bmF0aXZl" });
    const thought = harnessThinkingOptionIdSchema.parse("low"),
      mode = harnessPermissionModeIdSchema.parse("plan");
    controller.mount(composer, ["default"]);
    controller.setExternalModel(composer, "codebuddy", model);
    controller.setExternalThinkingOption(composer, "codebuddy", thought);
    expect(controller.modelForAgent(composer, "codebuddy")).toEqual(model);
    expect(controller.modelForAgent(composer, "claude-code")).toBeUndefined();
    const selected = modelSelectionForAgent(null, null, "codebuddy", model, thought, mode);
    if (typeof selected?.model !== "string") throw Error("No carrier");
    expect(decodeHarnessPluginRoute(selected.model)).toMatchObject({
      harnessId: "codebuddy",
      model,
      thinkingOptionId: thought,
      permissionModeId: mode,
    });
    expect(
      restoredThreadOwnership({
        owner: "external",
        harnessId: "codebuddy",
        transportModelId: selected.model,
        locked: true,
        history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
      }),
    ).toEqual({ agent: "codebuddy", model, thinkingOptionId: thought, permissionModeId: mode });
    controller.setExternalThinkingOption(composer, "codebuddy", undefined);
    expect(controller.thinkingOptionForAgent(composer, "codebuddy")).toBeUndefined();
    expect(RENDERER_AGENT_INSTALL_URLS.codebuddy).toBe(
      "https://www.codebuddy.ai/docs/zh/cli/overview",
    );
  });
  it("rejects another plugin's carrier instead of restoring as Codex", () => {
    const carrier = modelSelectionForAgent(null, null, "kiro-cli")?.model;
    expect(() =>
      restoredThreadOwnership({
        owner: "external",
        harnessId: "codebuddy",
        transportModelId: String(carrier),
        locked: true,
        history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
      }),
    ).toThrow("incompatible");
  });
});
