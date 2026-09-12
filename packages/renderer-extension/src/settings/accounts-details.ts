import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

/** Compact account actions and native-management help use the same native modal behavior. */
export function createAccountDetails(
  document: Document,
  messages: RendererSettingsMessages,
  input: {
    label: string;
    triggerLabel?: string;
    description: string;
    focusKey: string;
    icon: "ellipsis" | "info";
    disabled?: boolean;
    actions: readonly HTMLButtonElement[];
  },
): HTMLElement {
  const root = document.createElement("div");
  root.className = "settings-account-details";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "settings-icon-button";
  trigger.title = input.triggerLabel ?? input.label;
  trigger.disabled = input.disabled ?? false;
  trigger.dataset.accountFocus = input.focusKey;
  trigger.setAttribute("aria-label", trigger.title);
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.append(createRendererSettingsIcon(input.icon, 16));
  const dialog = document.createElement("dialog");
  dialog.className = "settings-account-dialog";
  dialog.id = `settings-account-${input.focusKey}-dialog`;
  dialog.setAttribute("aria-label", input.label);
  trigger.setAttribute("aria-controls", dialog.id);
  const heading = document.createElement("h2");
  heading.textContent = input.label;
  const description = document.createElement("p");
  description.textContent = input.description;
  description.id = `${dialog.id}-description`;
  dialog.setAttribute("aria-describedby", description.id);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "settings-icon-button settings-account-dialog__close";
  close.dataset.accountFocus = `${input.focusKey}:close`;
  close.setAttribute("aria-label", messages.accountDetailsClose);
  close.append(createRendererSettingsIcon("close", 16));
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (trigger.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
  });
  // Close before invoking a mutation, so its async table updates preserve focus on the row.
  dialog.addEventListener(
    "click",
    (event) => {
      if (input.actions.some((action) => action.contains(event.target as Node))) {
        trigger.focus({ preventScroll: true });
        dialog.close();
      }
    },
    { capture: true },
  );
  const actions = document.createElement("div");
  actions.className = "settings-account-dialog__actions";
  actions.append(...input.actions);
  dialog.append(close, heading, description, actions);
  trigger.addEventListener("click", () => dialog.showModal());
  root.append(trigger, dialog);
  return root;
}
