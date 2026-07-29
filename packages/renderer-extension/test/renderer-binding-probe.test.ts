import { describe, expect, it, vi } from "vitest";

import {
  applyDraftAgentSwitch,
  editorForElement,
  isComposerInputIntent,
  isComposerSubmissionKey,
  isComposerSubmitButton,
  shouldTransferComposerState,
} from "../src/renderer-binding-probe.js";

describe("Renderer binding event targeting", () => {
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

  it("does not clear when the selected Agent is unchanged", async () => {
    const applyAgent = vi.fn(() => true);
    const clearPrewarm = vi.fn(async () => undefined);

    await expect(applyDraftAgentSwitch("pi", "pi", { applyAgent, clearPrewarm })).resolves.toBe(
      true,
    );
    expect(applyAgent).not.toHaveBeenCalled();
    expect(clearPrewarm).not.toHaveBeenCalled();
  });

  it("applies the final Agent before clearing the stale prewarm", async () => {
    const operations: string[] = [];

    await expect(
      applyDraftAgentSwitch("codex", "pi", {
        applyAgent(agent) {
          operations.push(`apply:${agent}`);
          return true;
        },
        async clearPrewarm() {
          operations.push("clear");
        },
      }),
    ).resolves.toBe(true);
    expect(operations).toEqual(["apply:pi", "clear"]);
  });

  it("restores the prior Agent when prewarm clearing fails", async () => {
    const operations: string[] = [];

    await expect(
      applyDraftAgentSwitch("pi", "codex", {
        applyAgent(agent) {
          operations.push(`apply:${agent}`);
          return true;
        },
        async clearPrewarm() {
          operations.push("clear");
          throw new Error("synthetic clear failure");
        },
      }),
    ).resolves.toBe(false);
    expect(operations).toEqual(["apply:codex", "clear", "apply:pi"]);
  });

  it("fails closed when the prior Agent cannot be restored", async () => {
    await expect(
      applyDraftAgentSwitch("codex", "pi", {
        applyAgent(agent) {
          return agent === "pi";
        },
        async clearPrewarm() {
          throw new Error("synthetic clear failure");
        },
      }),
    ).rejects.toThrow("could not restore the prior Agent");
  });
});
