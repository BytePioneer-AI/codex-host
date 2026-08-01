import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  draftThinkingOptionForModel,
  isLateConversationTarget,
  isOwnershipSubmissionBlocked,
  restoredThreadOwnership,
  shouldTransferComposerState,
} from "../src/renderer-binding-probe.js";
import {
  editorForElement,
  isComposerInputIntent,
  isComposerSubmissionKey,
  isComposerSubmitButton,
} from "../src/renderer-composer-dom.js";

describe("Renderer Composer DOM behavior", () => {
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
        effectiveModel: model,
        effectiveThinkingOptionId: thinkingOptionId,
        availableThinkingOptions: [
          { id: harnessThinkingOptionIdSchema.parse("off"), label: "Off" },
          { id: thinkingOptionId, label: "High" },
        ],
        locked: true,
      }),
    ).toEqual({ agent: "pi", piModel: model, piThinkingOptionId: thinkingOptionId });
    expect(restoredThreadOwnership({ owner: "codex", locked: true })).toEqual({
      agent: "codex",
    });
    expect(() =>
      restoredThreadOwnership({
        owner: "external",
        harnessId: "pi",
        transportModelId: "official/model",
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

  it("does not bind readable Thinking when current options are unavailable", () => {
    const model = harnessModelRefSchema.parse({ id: "pi-model-v1.legacy" });
    expect(
      restoredThreadOwnership({
        owner: "external",
        harnessId: "pi",
        transportModelId: `codexhost/pi-native@${model.id}`,
        effectiveModel: model,
        effectiveThinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
        locked: true,
      }),
    ).toEqual({ agent: "pi", piModel: model });
  });

  it("detects a conversation target that arrives after the Composer mounted", () => {
    const defaultTarget = ["default"];
    const conversationTarget = ["conversation", "opaque-1"];

    expect(isLateConversationTarget(defaultTarget, conversationTarget)).toBe(true);
    expect(isLateConversationTarget(defaultTarget, defaultTarget)).toBe(false);
    expect(isLateConversationTarget(conversationTarget, conversationTarget)).toBe(false);
    expect(isLateConversationTarget(conversationTarget, ["conversation", "opaque-2"])).toBe(false);
    expect(isLateConversationTarget(null, conversationTarget)).toBe(false);
  });

  it("transfers only the same Model target or a first-create transition", () => {
    const defaultTarget = ["default"];
    const firstConversationTarget = ["conversation", "opaque-1"];
    const otherConversationTarget = ["conversation", "opaque-2"];

    expect(shouldTransferComposerState(defaultTarget, defaultTarget, "draft")).toBe(true);
    expect(shouldTransferComposerState(defaultTarget, firstConversationTarget, "draft")).toBe(true);
    expect(shouldTransferComposerState(defaultTarget, firstConversationTarget, "locked")).toBe(
      true,
    );
    expect(shouldTransferComposerState(firstConversationTarget, ["default"], "locked")).toBe(false);
    expect(
      shouldTransferComposerState(firstConversationTarget, otherConversationTarget, "locked"),
    ).toBe(false);
    expect(shouldTransferComposerState(null, firstConversationTarget, "locked")).toBe(false);
  });
});
