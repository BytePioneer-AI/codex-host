import {
  createRendererSettingsPageRegistry,
  type RendererSettingsPageDefinition,
  type RendererSettingsPageMountContext,
  type RendererSettingsPageRegistry,
} from "./core.js";

export const DEFAULT_RENDERER_SETTINGS_PAGE_IDS = [
  "overview",
  "routes",
  "providers",
  "credentials",
  "local-models",
  "gateway",
] as const;

export type DefaultRendererSettingsPageId = (typeof DEFAULT_RENDERER_SETTINGS_PAGE_IDS)[number];

const PAGE_LABELS: Record<DefaultRendererSettingsPageId, string> = {
  overview: "Overview",
  routes: "Routes",
  providers: "Providers",
  credentials: "Credentials",
  "local-models": "Local Models",
  gateway: "Gateway",
};

function appendUnavailableStatus(content: HTMLElement): void {
  const heading = content.ownerDocument.createElement("div");
  heading.className = "settings-section-label";
  heading.textContent = "Availability";

  const status = content.ownerDocument.createElement("div");
  status.className = "settings-empty";

  const copy = content.ownerDocument.createElement("div");
  const title = content.ownerDocument.createElement("strong");
  title.textContent = "Not available";
  const detail = content.ownerDocument.createElement("span");
  detail.textContent = "Runtime capability is not installed.";
  copy.append(title, detail);
  status.append(copy);
  content.append(heading, status);
}

function mountOverview(context: RendererSettingsPageMountContext): undefined {
  const heading = context.content.ownerDocument.createElement("div");
  heading.className = "settings-section-label";
  heading.textContent = "Runtime status";

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
    label.textContent = PAGE_LABELS[pageId];
    identity.append(label);

    const status = context.content.ownerDocument.createElement("span");
    status.className = "settings-status-badge";
    status.textContent = "Unavailable";
    row.append(identity, status);
    list.append(row);
  }
  context.content.append(heading, list);
  return undefined;
}

function unavailablePage(
  id: Exclude<DefaultRendererSettingsPageId, "overview">,
): RendererSettingsPageDefinition {
  return Object.freeze({
    id,
    label: PAGE_LABELS[id],
    icon: id,
    mount(context: RendererSettingsPageMountContext) {
      appendUnavailableStatus(context.content);
      return undefined;
    },
  });
}

export function createDefaultRendererSettingsPages(): readonly RendererSettingsPageDefinition[] {
  return Object.freeze([
    Object.freeze({
      id: "overview",
      label: PAGE_LABELS.overview,
      icon: "overview",
      mount: mountOverview,
    }),
    unavailablePage("routes"),
    unavailablePage("providers"),
    unavailablePage("credentials"),
    unavailablePage("local-models"),
    unavailablePage("gateway"),
  ] satisfies RendererSettingsPageDefinition[]);
}

export function createDefaultRendererSettingsRegistry(): RendererSettingsPageRegistry {
  return createRendererSettingsPageRegistry(createDefaultRendererSettingsPages());
}
