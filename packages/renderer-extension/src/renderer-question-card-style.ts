// Adapted from karlorz/codex-host@07d8f010, LGPL-3.0-only; countdown styling omitted.
/** Isolated from Desktop resets; follows the native question card's compact visual layout. */
export const QUESTION_CARD_CSS = `
  :host {
    display: block;
    min-width: 0;
    margin: 8px 0;
    color-scheme: inherit;
    --question-text: light-dark(#171717, #ececec);
    --question-muted: light-dark(#737373, #a3a3a3);
    --question-border: light-dark(rgb(0 0 0 / 8%), rgb(255 255 255 / 8%));
    --question-selected: light-dark(#e9e9e9, #333333);
    --question-primary: light-dark(#202020, #ececec);
    --question-primary-text: light-dark(#fff, #171717);
  }
  *, ::before, ::after { box-sizing: border-box; }
  .card {
    display: flex;
    flex-direction: column;
    max-height: min(60vh, 560px);
    overflow: hidden;
    padding: 16px 12px 12px;
    border: 1px solid var(--question-border);
    border-radius: 24px;
    background: light-dark(#f7f7f7, #262626);
    color: var(--question-text);
    font: 13px/1.5 system-ui, sans-serif;
  }
  .title { display: flex; align-items: center; gap: 10px; flex-shrink: 0; margin: 0 6px 14px; color: var(--question-muted); font-weight: 400; }
  .question-icon { display: inline-flex; justify-content: center; align-items: center; width: 16px; height: 16px; flex-shrink: 0; }
  svg { display: block; width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .body { min-height: 0; overflow: auto; }
  fieldset { min-width: 0; border: 0; padding: 0; margin: 0 0 14px; }
  fieldset:last-child { margin-bottom: 0; }
  legend { width: 100%; padding: 0 6px; margin-bottom: 14px; font: inherit; }
  .hint { color: var(--question-muted); font-size: 12px; margin: -10px 6px 10px; }
  .option {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    min-height: 34px;
    padding: 6px;
    margin: 2px 0;
    border-radius: 12px;
    cursor: pointer;
    background: transparent;
    overflow-wrap: anywhere;
  }
  .option:hover, .option:has(:checked) { background: var(--question-selected); }
  input[type=checkbox], input[type=radio] {
    appearance: none;
    display: block;
    flex: 0 0 21px;
    width: 21px;
    height: 21px;
    margin: 0;
    padding: 0;
    border: 1px solid var(--question-border);
    border-radius: 5px;
    background: light-dark(#ededed, #303030);
    cursor: pointer;
  }
  .shortcut { position: absolute; top: 6px; left: 6px; width: 21px; height: 21px; text-align: center; line-height: 21px; color: var(--question-muted); pointer-events: none; font-size: 12px; }
  .option-copy { flex: 1; min-width: 0; white-space: pre-wrap; }
  .option-name { display: block; font-weight: 400; }
  .description { display: block; color: var(--question-muted); font-size: 12px; margin-top: 1px; }
  .selected-indicator { align-self: center; visibility: hidden; color: var(--question-muted); padding-right: 4px; }
  :checked ~ .selected-indicator { visibility: visible; }
  .other { align-items: center; flex: 1; min-width: 0; margin: 0; }
  .other input[type=checkbox], .other input[type=radio] { background: transparent; border-color: transparent; }
  .other:has(:checked), .other:focus-within { background: var(--question-selected); }
  .other:has(:checked) .pencil { color: var(--question-text); }
  .pencil { display: flex; align-items: center; justify-content: center; }
  .other-copy { display: flex; flex: 1; min-width: 0; }
  input:not([type=checkbox]):not([type=radio]), textarea {
    appearance: none;
    display: block;
    min-width: 0;
    width: 100%;
    padding: 6px;
    border: 1px solid var(--question-border);
    border-radius: 8px;
    background: transparent;
    color: var(--question-text);
    font: inherit;
  }
  .other-copy input:not([type=checkbox]):not([type=radio]) { border: 0; padding: 0; }
  textarea { min-height: 60px; resize: vertical; }
  input::placeholder, textarea::placeholder { color: var(--question-muted); opacity: .65; }
  input:focus-visible, textarea:focus-visible, button:focus-visible {
    outline: 2px solid var(--question-muted);
    outline-offset: 2px;
  }
  .other-copy input:focus-visible { outline: none; }
  .other:has(input:focus-visible) { outline: 2px solid var(--question-muted); outline-offset: -2px; }
  .error { flex-shrink: 0; color: light-dark(#b42318, #ffaaa3); font-size: 12px; }
  .error:not(:empty) { margin: 8px 6px 0; }
  .footer { display: flex; align-items: center; gap: 8px; flex-shrink: 0; margin-top: 8px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-left: auto; flex-shrink: 0; }
  button {
    appearance: none;
    min-height: 28px;
    padding: 3px 10px;
    border: 1px solid var(--question-border);
    border-radius: 999px;
    background: transparent;
    color: var(--question-text);
    font: inherit;
    font-weight: 400;
    cursor: pointer;
  }
  button:hover { background: var(--question-selected); }
  button.primary { background: var(--question-primary); color: var(--question-primary-text); border-color: transparent; }
  button.primary:hover { opacity: .85; }
  button.dismiss { display: flex; align-items: center; justify-content: center; border: 0; padding: 0; min-height: 24px; width: 24px; margin-left: auto; color: var(--question-muted); }
  :disabled { cursor: wait; opacity: .5; }
  @media (max-width: 420px) { .footer { flex-wrap: wrap; } .footer > .other { flex-basis: 100%; } }
  @media (forced-colors: active) {
    .card, input, textarea { background: Canvas; color: CanvasText; }
    button, .card, input[type=checkbox], input[type=radio] { border-color: ButtonBorder; }
    .option:has(:checked) { outline: 1px solid Highlight; outline-offset: -1px; }
    button.primary { background: Highlight; color: HighlightText; }
  }
`;
