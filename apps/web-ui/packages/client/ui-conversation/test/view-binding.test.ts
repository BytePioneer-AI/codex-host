import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { blurActiveAnnotationEditor } from "../src/client/input/editor/view-binding.ts";

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
