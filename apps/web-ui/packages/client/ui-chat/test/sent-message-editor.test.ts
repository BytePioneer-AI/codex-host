// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SentMessageEditor, useSentMessageEditing } from "../src/client/chat/SentMessageEditor.tsx";
import type {
  ChatViewInjected,
  ChatViewSlotProps,
  SentMessageEditReceipt,
} from "../src/client/contract/slots.ts";

const original = "第一行\n第二行 👋";
const seq = 1;
const t = ((key: string) => key) as unknown as ChatViewSlotProps["t"];

function EditControl({
  targetSeq,
  send,
}: {
  targetSeq: number;
  send: NonNullable<ChatViewInjected["editMessage"]>;
}) {
  const editing = useSentMessageEditing(send, targetSeq, false);
  return editing.draft
    ? createElement(SentMessageEditor, { editing, t })
    : createElement("button", { onClick: () => editing.begin(seq, original, []) }, "Edit");
}

function expectSelection(textarea: HTMLTextAreaElement, start: number, end = start) {
  expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([start, end]);
}

function press(textarea: HTMLTextAreaElement, key: string) {
  textarea.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("SentMessageEditor caret", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function open() {
    act(() => container.querySelector("button")!.click());
    return container.querySelector("textarea")!;
  }

  it("focuses the end of a multiline Unicode message on open and after canceling", () => {
    const send = async () => ({ status: "accepted" as const });
    act(() => root.render(createElement(EditControl, { targetSeq: seq, send })));

    const textarea = open();
    expect(textarea.value).toBe(original);
    expect(document.activeElement).toBe(textarea);
    expectSelection(textarea, original.length);

    textarea.setSelectionRange(0, 2);
    act(() => press(textarea, "Escape"));
    expect(container.querySelector("textarea")).toBeNull();

    const reopened = open();
    expect(document.activeElement).toBe(reopened);
    expectSelection(reopened, original.length);
  });

  it("preserves the selection across draft changes, a rejected send, and target updates", async () => {
    const receipt = Promise.withResolvers<SentMessageEditReceipt>();
    const send = () => receipt.promise;
    act(() => root.render(createElement(EditControl, { targetSeq: seq, send })));
    const textarea = open();

    const edited = `新${original}`;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea,
        edited,
      );
      textarea.setSelectionRange(1, 3);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expectSelection(textarea, 1, 3);

    act(() => press(textarea, "Enter"));
    expect(textarea.disabled).toBe(true);
    expectSelection(textarea, 1, 3);

    await act(async () => receipt.resolve({ status: "rejected", message: "Try again" }));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Try again");
    expect(textarea.disabled).toBe(false);
    expect(textarea.value).toBe(edited);
    expectSelection(textarea, 1, 3);

    act(() => root.render(createElement(EditControl, { targetSeq: seq + 1, send })));
    expect(container.querySelector("button[type=submit]")).toHaveProperty("disabled", true);
    expectSelection(textarea, 1, 3);
  });
});
