import { describe, expect, it, vi } from "vitest";
import {
  decodeHarnessPluginRoute,
  harnessIdSchema,
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostThreadIdSchema,
} from "@codexhost/shared-contracts";
import { DraftAgentController } from "../src/agent-selection-state.js";
import { rendererAgentLabel } from "../src/renderer-agent-icon.js";
import { pluginDescriptor } from "../../../tests/fixtures/harness-plugin-descriptors.js";
import { modelSelectionForAgent } from "../src/versioned-renderer-adapter.js";
import { restoredThreadOwnership } from "../src/renderer-binding-probe.js";
import { rendererAgentForThreadOwnership } from "../src/renderer-sidebar-agent-icons.js";

const model = harnessModelRefSchema.parse({ id: "qoder-model-v1.YXV0bw" });
const thinking = harnessThinkingOptionIdSchema.parse("high");
const permission = harnessPermissionModeIdSchema.parse("default");

describe("Qoder distribution identity in Desktop", () => {
  it.each(["qoder", "qoder-cn"] as const)(
    "round trips %s through the shared route and ownership",
    (agent) => {
      const selection = modelSelectionForAgent(null, null, agent, model, thinking, permission);
      if (!selection || typeof selection.model !== "string") throw new Error("Missing carrier");
      expect(decodeHarnessPluginRoute(selection.model)).toEqual({
        harnessId: agent,
        model,
        thinkingOptionId: thinking,
        permissionModeId: permission,
      });
      const inspection = {
        owner: "external" as const,
        harnessId: agent,
        transportModelId: selection.model,
        locked: true as const,
        history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
      };
      expect(restoredThreadOwnership(inspection)).toEqual({
        agent,
        model,
        thinkingOptionId: thinking,
        permissionModeId: permission,
      });
      expect(
        restoredThreadOwnership({ ...inspection, availableThinkingOptions: [] }).thinkingOptionId,
      ).toBeUndefined();
      expect(() =>
        restoredThreadOwnership({
          ...inspection,
          harnessId: agent === "qoder" ? "qoder-cn" : "qoder",
        }),
      ).toThrow("identity mismatch");
      expect(
        rendererAgentForThreadOwnership({
          owner: "external",
          threadId: hostThreadIdSchema.parse("thread"),
          harnessId: harnessIdSchema.parse(agent),
        }),
      ).toBe(agent);
    },
  );

  it("keeps model, Thinking and Permission Mode separate when switching and restoring", async () => {
    const controller = new DraftAgentController({ enabledAgents: ["codex", "qoder", "qoder-cn"] });
    const composer = {};
    controller.mount(composer, ["default"]);
    const globalModel = harnessModelRefSchema.parse({ id: "global-model" });
    const globalThinking = harnessThinkingOptionIdSchema.parse("low");
    const globalPermission = harnessPermissionModeIdSchema.parse("plan");
    controller.setExternalModel(composer, "qoder", globalModel);
    controller.setExternalThinkingOption(composer, "qoder", globalThinking);
    controller.setExternalPermissionMode(composer, "qoder", globalPermission);
    controller.setExternalModel(composer, "qoder-cn", model);
    controller.setExternalThinkingOption(composer, "qoder-cn", thinking);
    controller.setExternalPermissionMode(composer, "qoder-cn", permission);
    const operations = {
      applyAgent: vi.fn(() => true),
      clearPrewarm: vi.fn(async () => undefined),
    };
    for (const agent of ["qoder-cn", "qoder", "qoder-cn"] as const) {
      await controller.switchAgent(composer, agent, operations);
      expect(controller.get(composer).agent).toBe(agent);
    }
    expect(controller.modelForAgent(composer, "qoder")).toEqual(globalModel);
    expect(controller.thinkingOptionForAgent(composer, "qoder")).toBe(globalThinking);
    expect(controller.permissionModeForAgent(composer, "qoder")).toBe(globalPermission);
    expect(controller.modelForAgent(composer, "qoder-cn")).toEqual(model);
    expect(controller.thinkingOptionForAgent(composer, "qoder-cn")).toBe(thinking);
    expect(controller.permissionModeForAgent(composer, "qoder-cn")).toBe(permission);
    controller.restore(composer, "qoder-cn", model, thinking, permission);
    controller.restore(composer, "qoder", globalModel, globalThinking, globalPermission);
    expect(controller.permissionModeForAgent(composer, "qoder-cn")).toBe(permission);
    controller.restore(composer, "qoder-cn");
    expect(controller.modelForAgent(composer, "qoder-cn")).toBeUndefined();
    expect(controller.thinkingOptionForAgent(composer, "qoder-cn")).toBeUndefined();
    expect(controller.permissionModeForAgent(composer, "qoder-cn")).toBeUndefined();
    expect(controller.modelForAgent(composer, "qoder")).toEqual(globalModel);
    expect(controller.permissionModeForAgent(composer, "qoder")).toBe(globalPermission);
  });

  it("shows distinct names for the two Agents", () => {
    expect(rendererAgentLabel("qoder", pluginDescriptor("qoder"))).toBe("Qoder");
    expect(rendererAgentLabel("qoder-cn", pluginDescriptor("qoder-cn"))).toBe("Qoder CN");
  });
});
