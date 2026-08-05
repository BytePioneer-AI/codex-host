import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  applyComposerModelWrite,
  draftPermissionMode,
  draftThinkingOptionForModel,
  isLateConversationTarget,
  isComposerModelWriteAllowed,
  isOwnershipSubmissionBlocked,
  lateConversationTargetResolution,
  restoredThreadOwnership,
  shouldTransferComposerState,
} from "../src/renderer-binding-probe.js";
import {
  editorForElement,
  isComposerInputIntent,
  isComposerSubmissionKey,
  isComposerSubmitButton,
  reconcileComposerNativeControls,
  type ComposerAgentControl,
} from "../src/renderer-composer-dom.js";

describe("Renderer Composer DOM behavior", () => {
  it("re-hides a replaced native Model control for an external Agent", () => {
    class FakeElement {
      readonly attributes = new Map<string, string>();
      className = "";
      hidden = false;
      readonly style: Record<string, string> = {};

      click(): void {}
      contains(): boolean {
        return false;
      }
      getAttribute(name: string): string | null {
        return this.attributes.get(name) ?? null;
      }
      hasAttribute(name: string): boolean {
        return this.attributes.has(name);
      }
      matches(selector: string): boolean {
        return selector === 'button[aria-haspopup="menu"]';
      }
      closest(): null {
        return null;
      }
      removeAttribute(name: string): void {
        this.attributes.delete(name);
      }
      setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
      }
    }
    vi.stubGlobal("HTMLElement", FakeElement);
    vi.stubGlobal("document", { activeElement: null });
    const previous = new FakeElement();
    previous.hidden = true;
    previous.setAttribute("aria-hidden", "true");
    const replacement = new FakeElement();
    replacement.className = "native-model";
    replacement.setAttribute("aria-haspopup", "menu");
    replacement.setAttribute("data-codex-intelligence-trigger", "true");
    replacement.setAttribute("data-composer-navigation-target", "reasoning");
    const composer = {
      querySelectorAll: (selector: string) =>
        selector === 'button[aria-haspopup="menu"]' ? [replacement] : [],
    } as unknown as Element;
    const trigger = new FakeElement();
    const control = {
      composer,
      modelPicker: { trigger },
      nativeModelControl: { element: previous, hidden: false, ariaHidden: null },
      nativePermissionModeControl: null,
    } as unknown as ComposerAgentControl;

    reconcileComposerNativeControls(control, true, true);

    expect(previous.hidden).toBe(false);
    expect(previous.getAttribute("aria-hidden")).toBeNull();
    expect(replacement.hidden).toBe(true);
    expect(replacement.getAttribute("aria-hidden")).toBe("true");
    expect(control.nativeModelControl?.element).toBe(replacement);
    vi.unstubAllGlobals();
  });

  it("resolves an inner contenteditable paragraph to its editor", () => {
    const editor = {} as Element;
    const paragraph = {
      matches: vi.fn(() => false),
      closest: vi.fn(() => editor),
    } as unknown as Element;

    expect(editorForElement(paragraph)).toBe(editor);
    expect(paragraph.closest).toHaveBeenCalledWith(
      'textarea, [contenteditable="true"], [role="textbox"]',
    );
  });

  it("recognizes keyboard input before contenteditable mutation events", () => {
    const event = (key: string, overrides: Partial<KeyboardEvent> = {}) =>
      ({ key, ctrlKey: false, metaKey: false, altKey: false, ...overrides }) as KeyboardEvent;

    expect(isComposerInputIntent(event("p"))).toBe(true);
    expect(isComposerInputIntent(event("Backspace"))).toBe(true);
    expect(isComposerInputIntent(event("v", { ctrlKey: true }))).toBe(true);
    expect(isComposerInputIntent(event("Process"))).toBe(true);
    expect(isComposerInputIntent(event("Delete"))).toBe(true);
    expect(isComposerInputIntent(event("ArrowLeft"))).toBe(false);
    expect(isComposerInputIntent(event("c", { ctrlKey: true }))).toBe(false);
  });

  it("does not treat attachment controls as submission", () => {
    const button = (label: string, type = "button") =>
      ({
        type,
        getAttribute(name: string) {
          return name === "aria-label" ? label : null;
        },
      }) as HTMLButtonElement;

    expect(isComposerSubmitButton(button("Attach files"))).toBe(false);
    expect(isComposerSubmitButton(button("Send"))).toBe(true);
    expect(isComposerSubmitButton(button("", "submit"))).toBe(true);
  });

  it("freezes only on a non-composing Enter without Shift", () => {
    const event = (overrides: Partial<KeyboardEvent> = {}) =>
      ({ key: "Enter", shiftKey: false, isComposing: false, ...overrides }) as KeyboardEvent;

    expect(isComposerSubmissionKey(event())).toBe(true);
    expect(isComposerSubmissionKey(event({ shiftKey: true }))).toBe(false);
    expect(isComposerSubmissionKey(event({ isComposing: true }))).toBe(false);
    expect(isComposerSubmissionKey(event({ key: "Process" }))).toBe(false);
  });

  it("restores validated Host ownership and blocks unresolved submission", () => {
    const model = harnessModelRefSchema.parse({ id: "pi-model-v1.restored" });
    const thinkingOptionId = harnessThinkingOptionIdSchema.parse("high");
    expect(
      restoredThreadOwnership({
        owner: "external",
        harnessId: "pi",
        transportModelId: "codexhost/pi-native",
        history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: false },
        effectiveModel: model,
        effectiveThinkingOptionId: thinkingOptionId,
        availableThinkingOptions: [
          { id: harnessThinkingOptionIdSchema.parse("off"), label: "Off" },
          { id: thinkingOptionId, label: "High" },
        ],
        locked: true,
      }),
    ).toEqual({ agent: "pi", model, thinkingOptionId });
    expect(restoredThreadOwnership({ owner: "codex", locked: true })).toEqual({
      agent: "codex",
    });
    expect(
      restoredThreadOwnership({
        owner: "external",
        harnessId: "claude-code",
        transportModelId: "codexhost/claude-code-native@claude-model-v1.c29ubmV0@acceptEdits@high",
        history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: false },
        effectiveModel: harnessModelRefSchema.parse({ id: "claude-model-v1.c29ubmV0" }),
        effectiveThinkingOptionId: thinkingOptionId,
        availableThinkingOptions: [{ id: thinkingOptionId, label: "High" }],
        effectivePermissionModeId: harnessPermissionModeIdSchema.parse("acceptEdits"),
        resolvedModelLabel: "runtime-custom",
        locked: true,
      }),
    ).toEqual({
      agent: "claude-code",
      model: { id: "claude-model-v1.c29ubmV0" },
      thinkingOptionId: "high",
      permissionModeId: "acceptEdits",
    });
    expect(
      restoredThreadOwnership({
        owner: "external",
        harnessId: "claude-code",
        transportModelId: "codexhost/claude-code-native@claude-model-v1.c29ubmV0@acceptEdits",
        history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: false },
        locked: true,
      }),
    ).toEqual({
      agent: "claude-code",
      model: { id: "claude-model-v1.c29ubmV0" },
      permissionModeId: "acceptEdits",
    });
    expect(() =>
      restoredThreadOwnership({
        owner: "external",
        harnessId: "pi",
        transportModelId: "official/model",
        history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: false },
        locked: true,
      }),
    ).toThrow("incompatible transport Model");
    expect(isOwnershipSubmissionBlocked("loading")).toBe(true);
    expect(isOwnershipSubmissionBlocked("error")).toBe(true);
    expect(isOwnershipSubmissionBlocked("ready")).toBe(false);
    expect(isOwnershipSubmissionBlocked("not-required")).toBe(false);
  });

  it("resolves Draft Thinking from the selected Model's in-memory Catalog entry", () => {
    const reasoningModel = harnessModelRefSchema.parse({ id: "pi-model-v1.reasoning" });
    const plainModel = harnessModelRefSchema.parse({ id: "pi-model-v1.plain" });
    const catalog = harnessModelCatalogSchema.parse({
      models: [
        {
          ref: reasoningModel,
          label: "Reasoning",
          supportedThinkingOptionIds: ["off", "high", "max"],
        },
        {
          ref: plainModel,
          label: "Plain",
          supportedThinkingOptionIds: ["off"],
        },
      ],
      defaultModel: reasoningModel,
      thinkingOptions: [
        { id: "off", label: "Off" },
        { id: "high", label: "High" },
        { id: "max", label: "Max" },
      ],
      defaultThinkingOptionId: "high",
    });

    expect(
      draftThinkingOptionForModel(
        catalog,
        reasoningModel,
        harnessThinkingOptionIdSchema.parse("max"),
      ),
    ).toBe("max");
    expect(
      draftThinkingOptionForModel(catalog, plainModel, harnessThinkingOptionIdSchema.parse("max")),
    ).toBe("off");
    expect(draftThinkingOptionForModel(catalog, reasoningModel, undefined)).toBe("high");
  });

  it("selects only an Adapter-catalog Permission Mode and falls back to its default", () => {
    const catalog = harnessPermissionModeCatalogSchema.parse({
      modes: [
        { id: "plan", label: "Plan" },
        { id: "default", label: "Default" },
      ],
      defaultModeId: "default",
    });

    expect(draftPermissionMode(catalog, harnessPermissionModeIdSchema.parse("plan"))).toBe("plan");
    expect(draftPermissionMode(catalog, harnessPermissionModeIdSchema.parse("foreign"))).toBe(
      "default",
    );
    expect(draftPermissionMode(catalog, undefined)).toBe("default");
  });

  it("does not bind readable Thinking when current options are unavailable", () => {
    const model = harnessModelRefSchema.parse({ id: "pi-model-v1.legacy" });
    expect(
      restoredThreadOwnership({
        owner: "external",
        harnessId: "pi",
        transportModelId: `codexhost/pi-native@${model.id}`,
        history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: false },
        effectiveModel: model,
        effectiveThinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
        locked: true,
      }),
    ).toEqual({ agent: "pi", model });
  });

  it("inspects an in-place conversation transition unless the source was submitted", () => {
    const defaultTarget = ["default"];
    const conversationTarget = ["conversation", "opaque-1"];

    expect(isLateConversationTarget(defaultTarget, conversationTarget)).toBe(true);
    expect(lateConversationTargetResolution(defaultTarget, conversationTarget, "draft")).toBe(
      "inspect",
    );
    expect(lateConversationTargetResolution(defaultTarget, conversationTarget, "locked")).toBe(
      "transfer",
    );
    expect(lateConversationTargetResolution(defaultTarget, defaultTarget, "draft")).toBe("none");
    expect(isLateConversationTarget(conversationTarget, conversationTarget)).toBe(false);
    expect(isLateConversationTarget(conversationTarget, ["conversation", "opaque-2"])).toBe(true);
    expect(
      lateConversationTargetResolution(conversationTarget, ["conversation", "opaque-2"], "locked"),
    ).toBe("inspect");
    expect(isLateConversationTarget(null, conversationTarget)).toBe(true);
    expect(lateConversationTargetResolution(null, conversationTarget, "draft")).toBe("inspect");
  });

  it("does not transfer an unsubmitted default draft when an existing conversation opens", () => {
    const defaultTarget = ["default"];
    const firstConversationTarget = ["conversation", "opaque-1"];
    const otherConversationTarget = ["conversation", "opaque-2"];

    expect(shouldTransferComposerState(defaultTarget, defaultTarget, "draft")).toBe(true);
    expect(shouldTransferComposerState(defaultTarget, firstConversationTarget, "draft")).toBe(
      false,
    );
    expect(shouldTransferComposerState(defaultTarget, firstConversationTarget, "locked")).toBe(
      true,
    );
    expect(shouldTransferComposerState(firstConversationTarget, ["default"], "locked")).toBe(false);
    expect(
      shouldTransferComposerState(firstConversationTarget, otherConversationTarget, "locked"),
    ).toBe(false);
    expect(shouldTransferComposerState(null, firstConversationTarget, "locked")).toBe(false);
  });

  it("allows native Model writes only for a new-Thread draft target", () => {
    expect(isComposerModelWriteAllowed(["default", "draft"])).toBe(true);
    expect(isComposerModelWriteAllowed(["conversation", "pi-thread"])).toBe(false);
    expect(isComposerModelWriteAllowed(["conversation", "codex-thread"])).toBe(false);
    expect(isComposerModelWriteAllowed(null)).toBe(false);
  });

  it("never writes the native Model while repeatedly switching existing conversations", () => {
    const write = vi.fn(() => true);

    for (let index = 0; index < 100; index += 1) {
      const agent = index % 2 === 0 ? "pi" : "codex";
      expect(applyComposerModelWrite(["conversation", `${agent}-${index}`], write)).toBe(true);
    }

    expect(write).not.toHaveBeenCalled();
  });
});
