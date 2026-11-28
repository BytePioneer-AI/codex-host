// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { clampMultiClickSelection } from "../src/client/chat/response-selection.ts";

describe("clampMultiClickSelection", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
  });

  it("clamps a multi-click selection spilling into following chrome back to the last text node", () => {
    const bubble = document.createElement("div");
    bubble.innerHTML = "<span>我希望默认是展开的</span>";
    const running = document.createElement("div");
    running.innerHTML = "<span>正在处理</span>";
    const composer = document.createElement("div");
    composer.setAttribute("contenteditable", "true");
    composer.innerHTML = "<p><br></p>";
    document.body.append(bubble, running, composer);

    const bubbleText = bubble.firstChild!.firstChild as Text;
    const range = document.createRange();
    range.setStart(bubbleText, 0);
    range.setEnd(running.firstChild!, 0);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    clampMultiClickSelection(bubble);

    expect(selection.rangeCount).toBe(1);
    const clamped = selection.getRangeAt(0);
    expect(clamped.startContainer).toBe(bubbleText);
    expect(clamped.startOffset).toBe(0);
    expect(clamped.endContainer).toBe(bubbleText);
    expect(clamped.endOffset).toBe(bubbleText.data.length);
  });

  it("clears a trailing-edge leak that collapses once clamped to the host", () => {
    const bubble = document.createElement("div");
    bubble.innerHTML = "<span>我希望默认是展开的</span>";
    const composer = document.createElement("div");
    composer.setAttribute("contenteditable", "true");
    composer.innerHTML = "<p><br></p>";
    document.body.append(bubble, composer);

    const bubbleText = bubble.firstChild!.firstChild as Text;
    const range = document.createRange();
    range.setStart(bubbleText, bubbleText.data.length);
    range.setEnd(composer, 0);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    clampMultiClickSelection(bubble);

    expect(selection.rangeCount).toBe(0);
  });

  it("preserves selections contained inside the host and respects skipElement", () => {
    const answer = document.createElement("div");
    answer.innerHTML = "<p>正文末尾</p><span class='skip'>标注</span>";
    const following = document.createElement("div");
    following.textContent = "提示条";
    document.body.append(answer, following);

    const proseText = answer.querySelector("p")!.firstChild as Text;
    const range = document.createRange();
    range.setStart(proseText, 0);
    range.setEnd(following, 0);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    clampMultiClickSelection(answer, (el) => el.classList.contains("skip"));

    expect(selection.rangeCount).toBe(1);
    const clamped = selection.getRangeAt(0);
    expect(clamped.endContainer).toBe(proseText);
    expect(clamped.endOffset).toBe(proseText.data.length);
  });
});
