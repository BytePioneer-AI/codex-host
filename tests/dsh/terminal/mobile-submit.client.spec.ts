// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { bindMobileTerminalSubmit } from "@deepseek-ai/dsh-client-ui-sidebar-terminal/src/client/mobile-terminal-submit.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
});
function fixture() {
  const textarea = document.createElement("textarea");
  textarea.value = "你好 world";
  const submit = vi.fn();
  const restore = vi.fn();
  const dispose = bindMobileTerminalSubmit(textarea, submit, restore);
  cleanup.push(dispose);
  const key = (options: KeyboardEventInit = {}) =>
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ...options }));
  const line = (options: InputEventInit = {}) => {
    const event = new InputEvent("beforeinput", {
      inputType: "insertLineBreak",
      cancelable: true,
      ...options,
    });
    textarea.dispatchEvent(event);
    return event;
  };
  return { textarea, submit, restore, dispose, key, line };
}

it.each(["insertLineBreak", "insertParagraph"])(
  "submits %s without a keydown and without changing the text",
  (inputType) => {
    const h = fixture();
    expect(h.line({ inputType }).defaultPrevented).toBe(true);
    expect(h.submit).toHaveBeenCalledOnce();
    expect(h.textarea.value).toBe("你好 world");
  },
);

it("uses one send source for keyboard Enter, permits Shift+Enter and ignores held Enter", () => {
  const h = fixture();
  h.key();
  expect(h.submit).not.toHaveBeenCalled();
  h.line();
  expect(h.submit).toHaveBeenCalledOnce();
  h.key({ repeat: true });
  expect(h.line().defaultPrevented).toBe(true);
  expect(h.submit).toHaveBeenCalledOnce();
  h.key({ shiftKey: true });
  expect(h.line().defaultPrevented).toBe(false);
  expect(h.submit).toHaveBeenCalledOnce();
  h.textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter" }));
  h.line();
  expect(h.submit).toHaveBeenCalledTimes(2);
});

it("does not submit composition confirmation or Safari's late closing Enter", () => {
  vi.useFakeTimers();
  const h = fixture();
  h.textarea.dispatchEvent(new CompositionEvent("compositionstart"));
  h.key();
  h.line();
  expect(h.submit).not.toHaveBeenCalled();
  h.textarea.dispatchEvent(new CompositionEvent("compositionend"));
  h.key();
  h.line();
  expect(h.submit).not.toHaveBeenCalled();
  h.textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter" }));
  vi.advanceTimersByTime(11);
  h.key();
  h.line();
  expect(h.submit).toHaveBeenCalledOnce();
});

it("recognizes composing flags and legacy IME Enter without composition events", () => {
  const h = fixture();
  h.line({ isComposing: true });
  h.key({ keyCode: 229 });
  h.line();
  expect(h.submit).not.toHaveBeenCalled();
  h.textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter" }));
  h.line();
  expect(h.submit).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "restores only an observed newline edit (cancelable=%s), without duplicate sends",
  (cancelable) => {
    const h = fixture();
    h.textarea.setSelectionRange(3, 7);
    h.line({ cancelable });
    h.textarea.value = "你好 \nd";
    h.textarea.dispatchEvent(new InputEvent("input", { inputType: "insertLineBreak" }));
    expect(h.textarea.value).toBe("你好 world");
    expect(h.restore).toHaveBeenCalledExactlyOnceWith("你好 world");
    expect(h.submit).toHaveBeenCalledOnce();
  },
);

it("does not turn paste or unrelated text changes into a submit; removes listeners on disposal", () => {
  const h = fixture();
  h.line({ inputType: "insertFromPaste", data: "one\ntwo" });
  expect(h.submit).not.toHaveBeenCalled();
  h.line({ cancelable: false });
  h.textarea.value = "a different candidate";
  h.textarea.dispatchEvent(new InputEvent("input", { inputType: "insertLineBreak" }));
  expect(h.submit).not.toHaveBeenCalled();
  expect(h.textarea.value).toBe("a different candidate");
  h.dispose();
  h.line();
  expect(h.submit).not.toHaveBeenCalled();
});
