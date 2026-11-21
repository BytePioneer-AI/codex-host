// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  captureResponseAnnotationAnchor,
  locateResponseAnnotation,
  restoreResponseAnnotationRange,
  selectedText,
} from "../../apps/web-ui/packages/client/ui-chat/src/client/chat/response-selection.ts";

function answer(markup: string, answerKey = "answer-1"): HTMLElement {
  const host = document.createElement("div");
  host.setAttribute("data-selection-answer", answerKey);
  host.innerHTML = markup;
  return host;
}

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected a value");
  return value;
}

function textNode(element: Element, selector = ":scope"): Text {
  const node = element.matches(selector)
    ? element.firstChild
    : element.querySelector(selector)?.firstChild;
  if (node === null || node === undefined || node.nodeType !== 3)
    throw new Error("Missing text node");
  return node as Text;
}

function rangeBetween(start: Node, startOffset: number, end: Node, endOffset: number): Range {
  const range = present(start.ownerDocument).createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  return range;
}

describe("response annotation selection anchors", () => {
  it("restores the repeated occurrence after excluded controls change", () => {
    const host = answer(
      "<p>repeat marker</p><div data-code-block-controls>old control</div><p>repeat marker</p>",
    );
    const paragraphs = host.querySelectorAll("p");
    const selected = textNode(present(paragraphs[1]));
    const original = rangeBetween(selected, 0, selected, selected.length);
    const anchor = captureResponseAnnotationAnchor(host, original);
    const savedAnchor = present(anchor);
    expect(anchor).toEqual({ answerKey: "answer-1", start: 13, end: 26 });

    present(host.querySelector("[data-code-block-controls]")).textContent =
      "a much longer control with repeat marker";
    const restored = restoreResponseAnnotationRange(host, savedAnchor, "repeat marker");
    const restoredRange = present(restored);

    expect(restored).toBeDefined();
    expect(restoredRange.startContainer).toBe(selected);
    expect(restoredRange.startOffset).toBe(0);
    expect(selectedText(restoredRange)).toBe("repeat marker");
  });

  it("restores a selection spanning inline formatting", () => {
    const host = answer("<p>Alpha <strong>bold</strong> and <em>tail</em>.</p>");
    const paragraph = present(host.querySelector("p"));
    const start = present(paragraph.firstChild);
    const end = present(present(paragraph.querySelector("em")).firstChild);
    const original = rangeBetween(start, 0, end, present(end.textContent).length);
    const text = selectedText(original);
    const anchor = captureResponseAnnotationAnchor(host, original);
    const savedAnchor = present(anchor);

    expect(text).toBe("Alpha bold and tail");
    expect(anchor).toEqual({ answerKey: "answer-1", start: 0, end: 19 });
    const restored = restoreResponseAnnotationRange(host, savedAnchor, text);
    expect(restored).toBeDefined();
    expect(selectedText(present(restored))).toBe(text);
  });

  it("prefers the next text node for a start boundary and the previous one for an end boundary", () => {
    const host = answer("<p><span>first</span><span>second</span></p>");
    const spans = host.querySelectorAll("span");
    const first = textNode(present(spans[0]));
    const second = textNode(present(spans[1]));

    const startsAtBoundary = rangeBetween(first, first.length, second, second.length);
    const startAnchor = captureResponseAnnotationAnchor(host, startsAtBoundary);
    const restoredStart = restoreResponseAnnotationRange(host, present(startAnchor), "second");
    const restoredStartRange = present(restoredStart);
    expect(restoredStart).toBeDefined();
    expect(restoredStartRange.startContainer).toBe(second);
    expect(restoredStartRange.startOffset).toBe(0);

    const endsAtBoundary = rangeBetween(first, 0, second, 0);
    const endAnchor = captureResponseAnnotationAnchor(host, endsAtBoundary);
    const restoredEnd = restoreResponseAnnotationRange(host, present(endAnchor), "first");
    const restoredEndRange = present(restoredEnd);
    expect(restoredEnd).toBeDefined();
    expect(restoredEndRange.endContainer).toBe(first);
    expect(restoredEndRange.endOffset).toBe(first.length);
  });

  it("rejects stale answers, invalid offsets, foreign ranges, and control-only selections", () => {
    const host = answer(
      "<p>visible text</p><div data-selection-actions>annotation control</div><textarea>draft</textarea>",
    );
    const visible = textNode(host, "p");
    const original = rangeBetween(visible, 0, visible, visible.length);
    const anchor = captureResponseAnnotationAnchor(host, original);
    const savedAnchor = present(anchor);
    expect(anchor).toEqual({ answerKey: "answer-1", start: 0, end: 12 });

    host.setAttribute("data-selection-answer", "new-answer");
    expect(restoreResponseAnnotationRange(host, savedAnchor, "visible text")).toBeUndefined();
    host.setAttribute("data-selection-answer", "answer-1");
    expect(
      restoreResponseAnnotationRange(
        host,
        { ...savedAnchor, end: savedAnchor.end + 1 },
        "visible text",
      ),
    ).toBeUndefined();

    const foreignDocument = document.implementation.createHTMLDocument("foreign");
    const foreignText = foreignDocument.createTextNode("visible text");
    const foreignRange = foreignDocument.createRange();
    foreignRange.setStart(foreignText, 0);
    foreignRange.setEnd(foreignText, foreignText.length);
    expect(captureResponseAnnotationAnchor(host, foreignRange)).toBeUndefined();

    const controlsOnly = answer(
      "<div data-code-block-controls>toolbar</div><div data-selection-actions>actions</div><textarea>input</textarea>",
    );
    const controlsRange = rangeBetween(
      controlsOnly,
      0,
      controlsOnly,
      controlsOnly.childNodes.length,
    );
    expect(selectedText(controlsRange)).toBe("");
    expect(captureResponseAnnotationAnchor(controlsOnly, controlsRange)).toBeUndefined();
  });

  it("locates the matching owner when two answers contain the same passage", () => {
    const transcript = document.createElement("div");
    const first = answer("<p>same passage</p>", "answer-1");
    const second = answer("<p>same passage</p>", "answer-2");
    transcript.append(first, second);
    const selected = textNode(second, "p");
    const range = rangeBetween(selected, 0, selected, selected.length);
    const anchor = captureResponseAnnotationAnchor(second, range);

    const located = locateResponseAnnotation(transcript, present(anchor), "same passage");
    const locatedRange = present(located?.range);

    expect(located?.host).toBe(second);
    expect(located?.range).toBeDefined();
    expect(selectedText(locatedRange)).toBe("same passage");
    expect(first.contains(locatedRange.startContainer)).toBe(false);
  });

  it("preserves serialization consistency for multi-paragraph, list, inline-code, and table selections", () => {
    const looseList = answer("<ul><li>\n<p>First para</p>\n<p>Second para</p>\n</li></ul>");
    const ul = present(looseList.querySelector("ul"));
    const looseElementRange = rangeBetween(ul, 0, ul, 1);
    const looseText = selectedText(looseElementRange);
    const looseAnchor = captureResponseAnnotationAnchor(looseList, looseElementRange);
    const restoredLoose = restoreResponseAnnotationRange(
      looseList,
      present(looseAnchor),
      looseText,
    );
    expect(looseText).toBe("First para\n\nSecond para");
    expect(restoredLoose).toBeDefined();
    expect(selectedText(present(restoredLoose))).toBe(looseText);

    const mixed = answer(
      "<p>Intro with <code>alpha()</code></p>\n<ol><li>First item</li><li>Second with <code>beta()</code></li></ol>\n<p>Outro</p>",
    );
    const introCode = textNode(present(mixed.querySelector("code")));
    const secondItemCode = textNode(present(mixed.querySelectorAll("code")[1]));
    const mixedRange = rangeBetween(introCode, 0, secondItemCode, secondItemCode.length);
    const mixedText = selectedText(mixedRange);
    const mixedAnchor = captureResponseAnnotationAnchor(mixed, mixedRange);
    const restoredMixed = restoreResponseAnnotationRange(mixed, present(mixedAnchor), mixedText);
    expect(restoredMixed).toBeDefined();
    expect(selectedText(present(restoredMixed))).toBe(mixedText);

    const tableHost = answer(
      "<table><thead><tr><th>Col A</th><th>Col B</th></tr></thead><tbody><tr><td>Row 1A</td><td>Row 1B</td></tr><tr><td>Row 2A</td><td>Row 2B</td></tr></tbody></table>",
    );
    const wholeTableRange = rangeBetween(tableHost, 0, tableHost, 1);
    const tableText = selectedText(wholeTableRange);
    const tableAnchor = captureResponseAnnotationAnchor(tableHost, wholeTableRange);
    const restoredTable = restoreResponseAnnotationRange(
      tableHost,
      present(tableAnchor),
      tableText,
    );
    expect(tableText).toBe("Col A\tCol B\nRow 1A\tRow 1B\nRow 2A\tRow 2B");
    expect(restoredTable).toBeDefined();
    expect(selectedText(present(restoredTable))).toBe(tableText);
  });

  it("restores the second occurrence of repeated text inside a list", () => {
    const host = answer(
      "<p>duplicate phrase</p>\n<ul><li>duplicate phrase</li><li>other item</li></ul>",
    );
    const listItemText = textNode(present(host.querySelector("li")));
    const original = rangeBetween(listItemText, 0, listItemText, listItemText.length);
    const text = selectedText(original);
    const anchor = captureResponseAnnotationAnchor(host, original);
    const restored = restoreResponseAnnotationRange(host, present(anchor), text);
    const restoredRange = present(restored);

    expect(restoredRange.startContainer).toBe(listItemText);
    expect(restoredRange.startOffset).toBe(0);
    expect(restoredRange.endContainer).toBe(listItemText);
    expect(restoredRange.endOffset).toBe(listItemText.length);
    expect(selectedText(restoredRange)).toBe("duplicate phrase");
  });
});
