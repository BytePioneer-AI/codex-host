/** Submit gestures for a native textarea, including soft keyboards without keydown. */
export function bindMobileTerminalSubmit(
  textarea: HTMLTextAreaElement,
  submit: () => void,
  restoreDraft: (text: string) => void,
): () => void {
  let composing = false;
  let composingUntil = 0;
  let newline = false;
  let imeEnter = false;
  let repeated = false;
  let pending: { text: string; start: number; end: number; submitted: boolean } | undefined;
  const start = (): void => {
    composing = true;
    pending = undefined;
  };
  const end = (): void => {
    composing = false;
    // Same short Safari closing-key guard used by the conversation composer.
    composingUntil = Date.now() + 10;
  };
  const release = (): void => {
    newline = false;
    imeEnter = false;
    repeated = false;
  };
  const blur = (): void => {
    release();
    composing = false;
    composingUntil = 0;
    pending = undefined;
  };
  const keydown = (event: KeyboardEvent): void => {
    release();
    if (event.key !== "Enter") return;
    newline = event.shiftKey || event.altKey || event.ctrlKey || event.metaKey;
    imeEnter = event.isComposing || event.keyCode === 229;
    repeated = event.repeat;
  };
  const isBreak = (event: InputEvent): boolean =>
    event.inputType === "insertLineBreak" || event.inputType === "insertParagraph";
  const beforeInput = (event: InputEvent): void => {
    pending = undefined;
    if (
      !isBreak(event) ||
      newline ||
      composing ||
      event.isComposing ||
      imeEnter ||
      Date.now() < composingUntil
    )
      return;
    // Use beforeinput as the single submit source: handling both keydown and
    // beforeinput as sends would duplicate Enter on keyboards that emit both.
    if (event.cancelable) event.preventDefault();
    if (repeated) return;
    pending = {
      text: textarea.value,
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
      submitted: event.cancelable,
    };
    if (event.cancelable) submit();
  };
  const input = (event: InputEvent): void => {
    const edit = pending;
    pending = undefined;
    if (!edit || !isBreak(event) || event.isComposing || composing) return;
    // Some IMEs expose a non-cancelable beforeinput. Remove only the exact
    // newline edit we observed, never infer arbitrary text replacements.
    const expected = edit.text.slice(0, edit.start) + "\n" + edit.text.slice(edit.end);
    if (textarea.value !== expected) return;
    textarea.value = edit.text;
    textarea.setSelectionRange(edit.start, edit.end);
    restoreDraft(edit.text);
    if (!edit.submitted) submit();
  };
  textarea.addEventListener("compositionstart", start);
  textarea.addEventListener("compositionend", end);
  textarea.addEventListener("keydown", keydown);
  textarea.addEventListener("keyup", release);
  textarea.addEventListener("beforeinput", beforeInput);
  textarea.addEventListener("input", input);
  textarea.addEventListener("blur", blur);
  return () => {
    textarea.removeEventListener("compositionstart", start);
    textarea.removeEventListener("compositionend", end);
    textarea.removeEventListener("keydown", keydown);
    textarea.removeEventListener("keyup", release);
    textarea.removeEventListener("beforeinput", beforeInput);
    textarea.removeEventListener("input", input);
    textarea.removeEventListener("blur", blur);
  };
}
