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
    const selection = modelSelectionForAgent(null, null, "cursor-cli", cursor, high, mode);
    if (typeof selection?.model !== "string") throw Error("Missing Cursor carrier");
    expect(decodeHarnessPluginRoute(selection.model)).toMatchObject({
      harnessId: "cursor-cli",
      model: cursor,
      permissionModeId: mode,
    });
    expect(decodeHarnessPluginRoute(selection.model)?.thinkingOptionId).toBeUndefined();
    expect(
      restoredThreadOwnership({
        owner: "external",
        harnessId: "cursor-cli",
        transportModelId: selection.model,
        locked: true,
        history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
      }),
    ).toEqual({ agent: "cursor-cli", model: cursor, permissionModeId: mode });
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
