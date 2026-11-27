import type { LexicalEditor } from "lexical";
import type { MouseEvent } from "react";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  blurActiveAnnotationEditor,
  blurDraftEditor,
  keepDraftFocus,
} from "../src/client/input/editor/view-binding.ts";

function stubBrowserDevice(options: {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  narrowTouch?: boolean;
}): void {
  vi.stubGlobal("navigator", {
    userAgent: options.userAgent,
    platform: options.platform ?? "MacIntel",
    maxTouchPoints: options.maxTouchPoints ?? 0,
  });
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({
      matches:
        query === "(width < 640px) and (pointer: coarse) and (hover: none)" &&
        options.narrowTouch === true,
    }),
  });
}

function fakeEditor(root: HTMLElement | null): LexicalEditor {
  return { getRootElement: () => root } as unknown as LexicalEditor;
}

describe("blurActiveAnnotationEditor", () => {
  it("blurs an active textarea inside [data-composer-annotations] so blur-commit runs before send", () => {
    const dom = new JSDOM(`
      <section data-composer-annotations>
        <textarea id="note">new mobile note</textarea>
        <button id="quote" type="button">quoted</button>
      </section>
      <textarea id="other">unrelated</textarea>
    `);
    const doc = dom.window.document;
    const note = doc.getElementById("note") as HTMLTextAreaElement;
    const quote = doc.getElementById("quote") as HTMLButtonElement;
    const other = doc.getElementById("other") as HTMLTextAreaElement;

    let blurCount = 0;
    note.addEventListener("blur", () => {
      blurCount += 1;
    });

    note.focus();
    expect(doc.activeElement).toBe(note);
    expect(blurActiveAnnotationEditor(doc)).toBe(true);
    expect(blurCount).toBe(1);
    expect(doc.activeElement).not.toBe(note);

    quote.focus();
    expect(blurActiveAnnotationEditor(doc)).toBe(false);
    expect(doc.activeElement).toBe(quote);

    other.focus();
    expect(blurActiveAnnotationEditor(doc)).toBe(false);
    expect(doc.activeElement).toBe(other);
  });
});

describe("keepDraftFocus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    {
      label: "desktop browser prevents default and keeps focus in the editor",
      device: {
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
        platform: "MacIntel",
        maxTouchPoints: 0,
        narrowTouch: false,
      },
      expectedKept: true,
    },
    {
      label: "mobile user agent neither prevents default nor focuses the editor",
      device: {
        userAgent:
          "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36",
        platform: "Linux armv8l",
        maxTouchPoints: 5,
        narrowTouch: true,
      },
      expectedKept: false,
    },
    {
      label:
        "desktop user agent on a narrow coarse touch viewport neither prevents default nor focuses",
      device: {
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
        platform: "Linux x86_64",
        maxTouchPoints: 5,
        narrowTouch: true,
      },
      expectedKept: false,
    },
  ])("$label", ({ device, expectedKept }) => {
    stubBrowserDevice(device);
    const dom = new JSDOM(`
      <div id="root" contenteditable="true" tabindex="0">draft</div>
      <button id="send" type="button">send</button>
    `);
    const doc = dom.window.document;
    const root = doc.getElementById("root") as HTMLDivElement;
    const send = doc.getElementById("send") as HTMLButtonElement;
    send.focus();

    const preventDefault = vi.fn();
    keepDraftFocus(
      { preventDefault } as unknown as MouseEvent<HTMLButtonElement>,
      fakeEditor(root),
    );

    expect(preventDefault).toHaveBeenCalledTimes(expectedKept ? 1 : 0);
    expect(doc.activeElement).toBe(expectedKept ? root : send);
  });
});

describe("blurDraftEditor", () => {
  it("blurs the editor root or a focused descendant without touching unrelated focus", () => {
    const dom = new JSDOM(`
      <div id="root" contenteditable="true" tabindex="0">
        <span id="chip" tabindex="0">chip</span>
      </div>
      <button id="other" type="button">other</button>
    `);
    const doc = dom.window.document;
    const root = doc.getElementById("root") as HTMLDivElement;
    const chip = doc.getElementById("chip") as HTMLSpanElement;
    const other = doc.getElementById("other") as HTMLButtonElement;
    const editor = fakeEditor(root);

    root.focus();
    expect(doc.activeElement).toBe(root);
    expect(blurDraftEditor(editor)).toBe(true);
    expect(doc.activeElement).not.toBe(root);

    chip.focus();
    expect(doc.activeElement).toBe(chip);
    expect(blurDraftEditor(editor)).toBe(true);
    expect(root.contains(doc.activeElement)).toBe(false);

    other.focus();
    expect(blurDraftEditor(editor)).toBe(false);
    expect(doc.activeElement).toBe(other);

    expect(blurDraftEditor(null)).toBe(false);
    expect(blurDraftEditor(fakeEditor(null))).toBe(false);
  });
});
