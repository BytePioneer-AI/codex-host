import {
  REASONING_SOFT_WRAP_CHANGE_EVENT,
  readReasoningTranscriptSoftWrap,
  setReasoningTranscriptSoftWrap,
} from "../renderer-transcript-dom.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import type { RendererSettingsMessages } from "./localization.js";

export function createAppearanceSettingsPage(
  messages: RendererSettingsMessages,
): RendererSettingsPageDefinition {
  return Object.freeze({
    id: "appearance",
    label: messages.pageLabels.appearance,
    icon: "settings",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const ownerWindow = document.defaultView;
      if (!ownerWindow) return;
      const heading = document.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = messages.pageLabels.appearance;

      const description = document.createElement("p");
      description.className = "settings-page-description";
      description.textContent = messages.appearanceDescription;

      const row = document.createElement("label");
      row.className = "settings-preference-row";
      const copy = document.createElement("span");
      copy.className = "settings-preference-row__copy";
      const title = document.createElement("strong");
      title.textContent = messages.reasoningSoftWrapTitle;
      const detail = document.createElement("span");
      detail.textContent = messages.reasoningSoftWrapDescription;
      copy.append(title, detail);

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "settings-preference-checkbox";
      checkbox.checked = readReasoningTranscriptSoftWrap(ownerWindow);
      checkbox.setAttribute("aria-label", messages.reasoningSoftWrapTitle);
      checkbox.addEventListener("change", () => {
        setReasoningTranscriptSoftWrap(ownerWindow, checkbox.checked);
      });

      const sync = (): void => {
        checkbox.checked = readReasoningTranscriptSoftWrap(ownerWindow);
      };
      ownerWindow.addEventListener(REASONING_SOFT_WRAP_CHANGE_EVENT, sync);

      row.append(copy, checkbox);
      context.content.append(heading, description, row);
      return () => ownerWindow.removeEventListener(REASONING_SOFT_WRAP_CHANGE_EVENT, sync);
    },
  });
}
