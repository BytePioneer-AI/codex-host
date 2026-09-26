import { describe, expect, it, vi } from "vitest";
import {
  decodeHarnessPluginRoute,
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import { DraftAgentController, DEFAULT_RENDERER_AGENTS } from "../src/agent-selection-state.js";
import { RENDERER_AGENT_LABELS } from "../src/renderer-agent-icon.js";
import { modelSelectionForAgent } from "../src/versioned-renderer-adapter.js";
import { restoredThreadOwnership } from "../src/renderer-binding-probe.js";
import { RENDERER_AGENT_INSTALL_URLS } from "../src/renderer-agent-picker.js";
import { harnessInstallationGuide } from "../src/settings/harness-installation-guides.js";

describe("ZCode Desktop selection", () => {
  it.each(["zcode-local-v1"])(
    "round trips %s configuration and locked Thread restoration through the shared plugin route",
    async (prefix) => {
      expect(DEFAULT_RENDERER_AGENTS).toContain("zcode");
      expect(RENDERER_AGENT_LABELS.zcode).toBe("ZCode");
      const model = harnessModelRefSchema.parse({ id: `${prefix}.WyJwIiwibSJd` });
      const thinking = harnessThinkingOptionIdSchema.parse("high"),
        permission = harnessPermissionModeIdSchema.parse("build");
      const selection = modelSelectionForAgent(null, null, "zcode", model, thinking, permission);
      if (!selection || typeof selection.model !== "string")
        throw new Error("Missing plugin route");
      expect(decodeHarnessPluginRoute(selection.model)).toEqual({
        harnessId: "zcode",
        model,
        thinkingOptionId: thinking,
        permissionModeId: permission,
      });
      expect(
        restoredThreadOwnership({
          owner: "external",
          harnessId: "zcode",
          transportModelId: selection.model,
          locked: true,
          history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
        }),
      ).toEqual({
        agent: "zcode",
        model,
        thinkingOptionId: thinking,
        permissionModeId: permission,
      });
      const controller = new DraftAgentController(),
        composer = {};
      controller.mount(composer, ["default"]);
      controller.setExternalModel(composer, "zcode", model);
      controller.setExternalThinkingOption(composer, "zcode", thinking);
      controller.setExternalPermissionMode(composer, "zcode", permission);
      const operations = {
        applyAgent: vi.fn(() => true),
        clearPrewarm: vi.fn(async () => undefined),
      };
      for (const agent of ["zcode", "codex", "zcode"] as const)
        await controller.switchAgent(composer, agent, operations);
      expect(controller.modelForAgent(composer, "zcode")).toEqual(model);
      expect(controller.thinkingOptionForAgent(composer, "zcode")).toBe(thinking);
      expect(controller.permissionModeForAgent(composer, "zcode")).toBe(permission);
      controller.restore(composer, "zcode");
      expect(controller.modelForAgent(composer, "zcode")).toBeUndefined();
      expect(controller.thinkingOptionForAgent(composer, "zcode")).toBeUndefined();
      expect(controller.permissionModeForAgent(composer, "zcode")).toBeUndefined();
    },
  );
  it("points both install entries at the codexhost runtime installation steps", () => {
    const guide = harnessInstallationGuide("zcode", "en");
    expect(guide.url).toMatch(
      /codex-host\/blob\/main\/docs\/harnesses\/zcode\/zcode-harness-integration\.md#/,
    );
    expect(RENDERER_AGENT_INSTALL_URLS.zcode).toBe(guide.url);
    expect(guide.before).toContain("Node 24");
  });
});
