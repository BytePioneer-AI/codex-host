import {
  decodeHarnessPluginRoute,
  harnessIdSchema,
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostThreadIdSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { DraftAgentController } from "../src/agent-selection-state.js";
import { restoredThreadOwnership } from "../src/renderer-binding-probe.js";
import { rendererAgentForThreadOwnership } from "../src/renderer-sidebar-agent-icons.js";
import { modelSelectionForAgent } from "../src/versioned-renderer-adapter.js";
import {
  isRendererModelSelectionReady,
  rendererModelPickerPresentation,
} from "../src/renderer-model-picker.js";
import {
  readNewThreadAgentPreference,
  writeNewThreadAgentPreference,
} from "../src/renderer-new-thread-preference.js";

describe("Kimi and MiMo Desktop integration", () => {
  it.each(["kimi-code", "mimo-code"] as const)(
    "round trips %s ownership and configuration through the shared carrier",
    (agent) => {
      const model = harnessModelRefSchema.parse({ id: `${agent}.model` });
      const thinkingOptionId = harnessThinkingOptionIdSchema.parse("native-high");
      const permissionModeId = harnessPermissionModeIdSchema.parse("native-default");
      const selection = modelSelectionForAgent(
        null,
        null,
        agent,
        model,
        thinkingOptionId,
        permissionModeId,
      );
      if (!selection || typeof selection.model !== "string")
        throw new Error("Missing plugin carrier");
      expect(decodeHarnessPluginRoute(selection.model)).toMatchObject({
        harnessId: agent,
        model,
        thinkingOptionId,
        permissionModeId,
      });
      const inspection = {
        owner: "external" as const,
        harnessId: agent,
        transportModelId: selection.model,
        locked: true as const,
        effectiveModel: model,
        effectivePermissionModeId: permissionModeId,
        availableThinkingOptions: [],
        history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
      };
      expect(restoredThreadOwnership(inspection)).toEqual({ agent, model, permissionModeId });
      expect(() =>
        restoredThreadOwnership({
          ...inspection,
          harnessId: agent === "kimi-code" ? "mimo-code" : "kimi-code",
        }),
      ).toThrow("incompatible");
      expect(
        rendererAgentForThreadOwnership({
          threadId: hostThreadIdSchema.parse("thread"),
          owner: "external",
          harnessId: harnessIdSchema.parse(agent),
        }),
      ).toBe(agent);

      const nativeDefault = modelSelectionForAgent(
        null,
        null,
        agent,
        undefined,
        undefined,
        permissionModeId,
      );
      if (!nativeDefault || typeof nativeDefault.model !== "string")
        throw new Error("Missing native-default carrier");
      expect(decodeHarnessPluginRoute(nativeDefault.model)).toEqual({
        harnessId: agent,
        permissionModeId,
      });
    },
  );

  it("keeps model, thinking, permission, and new task preference separate", () => {
    const controller = new DraftAgentController<object>();
    const composer = {};
    for (const agent of ["kimi-code", "mimo-code"] as const) {
      controller.setExternalModel(
        composer,
        agent,
        harnessModelRefSchema.parse({ id: `${agent}.model` }),
      );
      controller.setExternalThinkingOption(
        composer,
        agent,
        harnessThinkingOptionIdSchema.parse(`${agent}.thinking`),
      );
      controller.setExternalPermissionMode(
        composer,
        agent,
        harnessPermissionModeIdSchema.parse(`${agent}.permission`),
      );
    }
    controller.restore(composer, "kimi-code");
    expect(controller.modelForAgent(composer, "kimi-code")).toBeUndefined();
    expect(controller.thinkingOptionForAgent(composer, "kimi-code")).toBeUndefined();
    expect(controller.permissionModeForAgent(composer, "kimi-code")).toBeUndefined();
    expect(controller.modelForAgent(composer, "mimo-code")?.id).toBe("mimo-code.model");
    expect(controller.thinkingOptionForAgent(composer, "mimo-code")).toBe("mimo-code.thinking");
    expect(controller.permissionModeForAgent(composer, "mimo-code")).toBe("mimo-code.permission");
    let saved: string | null = null;
    const storage = {
      getItem: () => saved,
      setItem: (_key: string, value: string) => {
        saved = value;
      },
    };
    writeNewThreadAgentPreference("mimo-code", storage);
    expect(readNewThreadAgentPreference(new Set(["codex", "mimo-code"]), storage)).toBe(
      "mimo-code",
    );
    expect(readNewThreadAgentPreference(new Set(["codex"]), storage)).toBeUndefined();
  });

  it("allows a confirmed native default without making an empty selectable catalog ready", () => {
    const catalog = harnessModelCatalogSchema.parse({ models: [], thinkingOptions: [] });
    const fixed = { status: "empty" as const, catalog, modelSelectionSupported: false };
    expect(isRendererModelSelectionReady(fixed)).toBe(true);
    expect(rendererModelPickerPresentation(fixed).modelLabel).toBe("Native model");
    expect(isRendererModelSelectionReady({ ...fixed, modelSelectionSupported: true })).toBe(false);
    expect(isRendererModelSelectionReady({ ...fixed, status: "error" })).toBe(false);
    expect(isRendererModelSelectionReady({ ...fixed, status: "loading" })).toBe(false);
    expect(isRendererModelSelectionReady({ status: "empty", modelSelectionSupported: false })).toBe(
      false,
    );
  });
});
