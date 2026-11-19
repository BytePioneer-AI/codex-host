// Adapted from karlorz/codex-host@07d8f010, LGPL-3.0-only.
// This upstream variant handles multi-select groups only; native timers are not projected.
import type { ThreadQuestion } from "@codexhost/shared-contracts";
import type { IconNode } from "lucide";
import createElement from "lucide/dist/esm/createElement.mjs";
import Check from "lucide/dist/esm/icons/check.mjs";
import MessageCircleQuestion from "lucide/dist/esm/icons/message-circle-question-mark.mjs";
import Pencil from "lucide/dist/esm/icons/pencil.mjs";
import X from "lucide/dist/esm/icons/x.mjs";
import { QUESTION_CARD_CSS } from "./renderer-question-card-style.js";

/** The card submits public Host values, never native labels or SDK objects. */
export function createQuestionCard(
  document: Document,
  question: ThreadQuestion,
  submit: (answers: Record<string, string[]>, cancelled: boolean) => Promise<void>,
  initial: Record<string, string[]> = {},
) {
  const icon = (node: IconNode) =>
    document.adoptNode(
      createElement(node, {
        width: 16,
        height: 16,
        "aria-hidden": "true",
        focusable: "false",
      }),
    );
  const selectedIndicator = () => {
    const selected = document.createElement("span");
    selected.className = "selected-indicator";
    selected.setAttribute("aria-hidden", "true");
    selected.append(icon(Check));
    return selected;
  };
  const root = document.createElement("section");
  root.dataset.codexhostQuestion = question.interactionId;
  root.setAttribute("aria-label", question.title ?? "Question");
  root.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter" && event.composedPath()[0] instanceof HTMLInputElement)
      event.preventDefault();
  });
  const shadow = root.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = QUESTION_CARD_CSS;
  const surface = document.createElement("div");
  surface.className = "card";
  shadow.append(style, surface);
  const title = document.createElement("div");
  title.className = "title";
  const titleIcon = document.createElement("span");
  titleIcon.className = "question-icon";
  titleIcon.append(icon(MessageCircleQuestion));
  titleIcon.setAttribute("aria-hidden", "true");
  const titleText = document.createElement("span");
  titleText.textContent = question.title?.trim() || "Question";
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "dismiss";
  dismiss.append(icon(X));
  dismiss.setAttribute("aria-label", "Dismiss question");
  title.append(titleIcon, titleText, dismiss);
  const body = document.createElement("div");
  body.className = "body";
  surface.append(title, body);
  const footer = document.createElement("div");
  footer.className = "footer";
  const readers = new Map<string, () => string[]>();
  const controls: Array<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement> = [dismiss];
  const validOther: Array<() => boolean> = [];
  for (const [index, field] of question.questions.entries()) {
    const group = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = field.prompt;
    group.append(legend);
    const saved = initial[field.id] ?? [];
    if (field.type === "text") {
      const input = document.createElement(field.multiline ? "textarea" : "input");
      input.value = saved[0] ?? field.prefill ?? "";
      input.placeholder = field.placeholder ?? "Your answer";
      input.setAttribute("aria-label", field.prompt);
      controls.push(input);
      group.append(input);
      readers.set(field.id, () => (input.value.trim() ? [input.value] : []));
    } else {
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "Select all that apply";
      if (field.multiple) group.append(hint);
      const inputs: HTMLInputElement[] = [];
      const name = `codexhost-${question.interactionId}-${index}`;
      for (const [optionIndex, option] of field.options.entries()) {
        const label = document.createElement("label");
        label.className = "option";
        const input = document.createElement("input");
        input.type = field.multiple ? "checkbox" : "radio";
        input.name = name;
        input.value = option.value;
        input.checked = saved.includes(option.value);
        const shortcut = document.createElement("span");
        shortcut.className = "shortcut";
        shortcut.setAttribute("aria-hidden", "true");
        shortcut.textContent = String(optionIndex + 1);
        const selected = selectedIndicator();
        const text = document.createElement("span");
        text.className = "option-copy";
        const optionName = document.createElement("span");
        optionName.className = "option-name";
        optionName.textContent = option.label;
        text.append(optionName);
        if (option.description) {
          const description = document.createElement("span");
          description.className = "description";
          description.textContent = option.description;
          text.append(description);
        }
        label.append(input, shortcut, text, selected);
        group.append(label);
        inputs.push(input);
        controls.push(input);
      }
      let other: HTMLInputElement | undefined;
      let notes: HTMLInputElement | undefined;
      if (field.allowOther) {
        const label = document.createElement("label");
        label.className = "option other";
        other = document.createElement("input");
        other.type = field.multiple ? "checkbox" : "radio";
        other.name = name;
        other.setAttribute("aria-label", `Other: ${field.prompt}`);
        const unknown = saved.find(
          (value) => !field.options.some((option) => option.value === value),
        );
        other.checked = unknown !== undefined;
        notes = document.createElement("input");
        notes.value = unknown ?? "";
        notes.placeholder = "Or write your own response";
        notes.setAttribute("aria-label", `${field.prompt}: Other`);
        const checkbox = other;
        const otherText = notes;
        validOther.push(() => !checkbox.checked || otherText.value.trim().length > 0);
        notes.addEventListener("input", () => {
          checkbox.checked = true;
        });
        const copy = document.createElement("span");
        copy.className = "other-copy";
        copy.append(notes);
        const pencil = document.createElement("span");
        pencil.className = "shortcut pencil";
        pencil.append(icon(Pencil));
        pencil.setAttribute("aria-hidden", "true");
        const selected = selectedIndicator();
        label.append(other, pencil, copy, selected);
        if (question.questions.length === 1) footer.append(label);
        else group.append(label);
        controls.push(other, notes);
      }
      readers.set(field.id, () => [
        ...inputs.filter((input) => input.checked).map((input) => input.value),
        ...(other?.checked && notes?.value.trim() ? [notes.value] : []),
      ]);
    }
    body.append(group);
  }
  const error = document.createElement("div");
  error.setAttribute("role", "alert");
  error.className = "error";
  const actions = document.createElement("div");
  actions.className = "actions";
  const readAnswers = () => Object.fromEntries([...readers].map(([id, read]) => [id, read()]));
  let busy = false;
  const send = async (cancelled: boolean) => {
    if (busy) return;
    const answers = cancelled ? {} : readAnswers();
    if (!cancelled && validOther.some((valid) => !valid())) {
      error.textContent = "Type an answer for each selected Other option.";
      return;
    }
    if (
      !cancelled &&
      question.questions.some((field) => !field.optional && !answers[field.id]?.length)
    ) {
      error.textContent = "Answer each required question before submitting.";
      return;
    }
    busy = true;
    error.textContent = "";
    for (const control of controls) control.disabled = true;
    try {
      await submit(answers, cancelled);
    } catch {
      error.textContent =
        "Could not submit. The question may have closed. Try again if it is still available.";
    } finally {
      busy = false;
      for (const control of controls) control.disabled = false;
    }
  };
  for (const [label, cancelled] of [
    ["Skip", true],
    ["Send", false],
  ] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (!cancelled) button.className = "primary";
    button.addEventListener("click", () => {
      void send(cancelled);
    });
    controls.push(button);
    actions.append(button);
  }
  dismiss.addEventListener("click", () => {
    void send(true);
  });
  footer.append(actions);
  surface.append(error, footer);
  return {
    root,
    readAnswers,
    dispose() {
      root.remove();
    },
  };
}
