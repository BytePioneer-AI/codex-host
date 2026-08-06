import {
  createRendererSettingsPageRegistry,
  type RendererSettingsPageDefinition,
  type RendererSettingsPageMountContext,
  type RendererSettingsPageRegistry,
} from "./core.js";
import {
  DEFAULT_RENDERER_SETTINGS_MESSAGES,
  type RendererSettingsMessages,
} from "./localization.js";
export const DEFAULT_RENDERER_SETTINGS_PAGE_IDS = [
  "connections",
  "model-pool",
  "routes",
  "gateway",
] as const;

export type DefaultRendererSettingsPageId = (typeof DEFAULT_RENDERER_SETTINGS_PAGE_IDS)[number];

function appendUnavailableStatus(content: HTMLElement, messages: RendererSettingsMessages): void {
  const heading = content.ownerDocument.createElement("div");
  heading.className = "settings-section-label";
  heading.textContent = messages.availability;

  const status = content.ownerDocument.createElement("div");
  status.className = "settings-empty";

  const copy = content.ownerDocument.createElement("div");
  const title = content.ownerDocument.createElement("strong");
  title.textContent = messages.notAvailable;
  const detail = content.ownerDocument.createElement("span");
  detail.textContent = messages.runtimeCapabilityNotInstalled;
  copy.append(title, detail);
  status.append(copy);
  content.append(heading, status);
}

function unavailablePage(
  id: DefaultRendererSettingsPageId,
  messages: RendererSettingsMessages,
): RendererSettingsPageDefinition {
  return Object.freeze({
    id,
    label: messages.pageLabels[id],
    icon: id,
    mount(context: RendererSettingsPageMountContext) {
      appendUnavailableStatus(context.content, messages);
      return undefined;
    },
  });
}

export function createDefaultRendererSettingsPages(
  messages: RendererSettingsMessages = DEFAULT_RENDERER_SETTINGS_MESSAGES,
): readonly RendererSettingsPageDefinition[] {
  return Object.freeze(
    DEFAULT_RENDERER_SETTINGS_PAGE_IDS.map((id) => unavailablePage(id, messages)),
  );
}

export function createDefaultRendererSettingsRegistry(
  messages: RendererSettingsMessages = DEFAULT_RENDERER_SETTINGS_MESSAGES,
): RendererSettingsPageRegistry {
  return createRendererSettingsPageRegistry(createDefaultRendererSettingsPages(messages));
}
