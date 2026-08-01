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
  "overview",
  "routes",
  "providers",
  "credentials",
  "local-models",
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

function mountOverview(
  context: RendererSettingsPageMountContext,
  messages: RendererSettingsMessages,
): undefined {
  const heading = context.content.ownerDocument.createElement("div");
  heading.className = "settings-section-label";
  heading.textContent = messages.runtimeStatus;

  const list = context.content.ownerDocument.createElement("div");
  list.className = "settings-status-list";
  list.setAttribute("role", "list");
  for (const pageId of DEFAULT_RENDERER_SETTINGS_PAGE_IDS.slice(1)) {
    const row = context.content.ownerDocument.createElement("div");
    row.className = "settings-status-row";
    row.setAttribute("role", "listitem");

    const identity = context.content.ownerDocument.createElement("span");
    identity.className = "settings-status-row__identity";
    const label = context.content.ownerDocument.createElement("span");
    label.textContent = messages.pageLabels[pageId];
    identity.append(label);

    const status = context.content.ownerDocument.createElement("span");
    status.className = "settings-status-badge";
    status.textContent = messages.unavailable;
    row.append(identity, status);
    list.append(row);
  }
  context.content.append(heading, list);
  return undefined;
}

function unavailablePage(
  id: Exclude<DefaultRendererSettingsPageId, "overview">,
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
  return Object.freeze([
    Object.freeze({
      id: "overview",
      label: messages.pageLabels.overview,
      icon: "overview",
      mount(context: RendererSettingsPageMountContext) {
        return mountOverview(context, messages);
      },
    }),
    unavailablePage("routes", messages),
    unavailablePage("providers", messages),
    unavailablePage("credentials", messages),
    unavailablePage("local-models", messages),
    unavailablePage("gateway", messages),
  ] satisfies RendererSettingsPageDefinition[]);
}

export function createDefaultRendererSettingsRegistry(
  messages: RendererSettingsMessages = DEFAULT_RENDERER_SETTINGS_MESSAGES,
): RendererSettingsPageRegistry {
  return createRendererSettingsPageRegistry(createDefaultRendererSettingsPages(messages));
}
