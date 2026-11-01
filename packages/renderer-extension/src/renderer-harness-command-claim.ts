import type { HarnessCommandDescriptor } from "@codexhost/shared-contracts";

function inputEvent(editor: HTMLElement, text: string): Event {
  const view = editor.ownerDocument.defaultView;
  return view?.InputEvent
    ? new view.InputEvent("input", {
        bubbles: true,
        composed: true,
        data: text,
        inputType: "insertText",
      })
    : new (view?.Event ?? Event)("input", { bubbles: true, composed: true });
}

function prependTextarea(editor: HTMLElement, prefix: string): boolean {
  const view = editor.ownerDocument.defaultView;
  if (!view || !(editor instanceof view.HTMLTextAreaElement)) return false;
  const setter = Object.getOwnPropertyDescriptor(view.HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) return false;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  setter.call(editor, prefix + editor.value);
  editor.dispatchEvent(inputEvent(editor, prefix));
  editor.focus({ preventScroll: true });
  if (start !== null && end !== null) {
    editor.setSelectionRange(start + prefix.length, end + prefix.length);
  }
  return true;
}

function prependContentEditable(editor: HTMLElement, prefix: string): boolean {
  if (editor.getAttribute("contenteditable") !== "true") return false;
  const document = editor.ownerDocument;
  const selection = document.getSelection();
  if (!selection || typeof document.execCommand !== "function") return false;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(true);
  editor.focus({ preventScroll: true });
  selection.removeAllRanges();
  selection.addRange(range);
  return document.execCommand("insertText", false, prefix);
}

function prependEditor(editor: HTMLElement, prefix: string): boolean {
  return prependTextarea(editor, prefix) || prependContentEditable(editor, prefix);
}

// Clicking compact always uses the native default; typed instructions remain supported.
export function rendererHarnessCommandExecutesDirectly(command: HarnessCommandDescriptor): boolean {
  return command.invocation === "/compact" || command.argumentMode === "none";
}

export function routeRendererHarnessCommandSelection(
  editor: HTMLElement | null,
  command: HarnessCommandDescriptor,
  execute: () => void,
): boolean {
  if (rendererHarnessCommandExecutesDirectly(command)) {
    execute();
    return true;
  }
  return editor !== null && prependEditor(editor, `${command.invocation} `);
}
