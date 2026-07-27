import { describe, expect, it, vi } from "vitest";

import { editorForElement, isComposerInputIntent } from "../src/renderer-binding-probe.js";

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
    expect(isComposerInputIntent(event("ArrowLeft"))).toBe(false);
    expect(isComposerInputIntent(event("c", { ctrlKey: true }))).toBe(false);
  });
});
