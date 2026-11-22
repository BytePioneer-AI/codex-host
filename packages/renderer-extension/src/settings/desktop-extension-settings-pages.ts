import {
  resolveLocalizedExtensionText,
  type HostExtensionListItem,
  type JsonObject,
} from "@codexhost/shared-contracts";
import type {
  DesktopExtensionAssetsApi,
  DesktopExtensionBackendApi,
  DesktopExtensionSettingsPageContribution,
  DesktopExtensionStorageApi,
} from "../desktop-extension-api.js";
import type { DesktopExtensionHost } from "../desktop-extension-host.js";
import type { DesktopExtensionSurfaceClient } from "../desktop-extension-surface.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import {
  createDesktopExtensionPageHost,
  desktopExtensionPageTitle,
} from "./desktop-extension-page-host.js";
import { createEl, readContentLocalePreference } from "./desktop-extensions-shared.js";
import { isRendererSettingsIconName } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

export interface RendererSettingsDynamicPageEntry {
  readonly extensionId: string;
  readonly definition: RendererSettingsPageDefinition;
  readonly revision?: string;
  readonly iconDataUrl?: string;
}

export interface RendererSettingsPluginPagesSource {
  getPages(): readonly RendererSettingsDynamicPageEntry[];
  getPageIdForExtension(extensionId: string): string | undefined;
  hasPageForExtension(extensionId: string): boolean;
  syncInstalledExtensions?(
    extensions: readonly HostExtensionListItem[],
    configRevision?: number,
  ): void;
  notifySettingsChanged?(extensionId: string, values: JsonObject): void;
  subscribe(listener: () => void): () => void;
  dispose?(): void;
}

const MAX_PLUGIN_PAGE_ID_LENGTH = 48;

export function desktopExtensionSettingsPageId(
  extensionId: string,
  usedIds: ReadonlySet<string> = new Set(),
): string {
  const slug = extensionId
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const baseBody = (slug || "extension").slice(0, MAX_PLUGIN_PAGE_ID_LENGTH - "plugin-".length);
  const baseId = `plugin-${baseBody.replace(/-+$/gu, "") || "extension"}`;
  if (!usedIds.has(baseId)) return baseId;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const suffixText = `-${suffix}`;
    const candidate = `${baseId.slice(0, MAX_PLUGIN_PAGE_ID_LENGTH - suffixText.length).replace(/-+$/gu, "")}${suffixText}`;
    if (!usedIds.has(candidate)) return candidate;
  }
  return `${baseId.slice(0, MAX_PLUGIN_PAGE_ID_LENGTH - 5)}-x`;
}

function createCustomExtensionSettingsPageDefinition(options: {
  readonly pageId: string;
  readonly extensionId: string;
  readonly title: string | { readonly en: string; readonly "zh-CN": string } | undefined;
  readonly contribution: DesktopExtensionSettingsPageContribution;
  readonly messages: RendererSettingsMessages;
  readonly services: {
    readonly assets: DesktopExtensionAssetsApi;
    readonly storage: DesktopExtensionStorageApi;
    readonly backend: DesktopExtensionBackendApi;
  };
}): RendererSettingsPageDefinition {
  const { pageId, extensionId, title, contribution, messages, services } = options;
  const rawTitle = contribution.title ?? title;
  const label =
    (rawTitle && resolveLocalizedExtensionText(rawTitle, messages.locale).trim()) || extensionId;
  const icon = contribution.icon;

  return Object.freeze<RendererSettingsPageDefinition>({
    id: pageId,
    label: label.slice(0, 64),
    icon: icon && isRendererSettingsIconName(icon) ? icon : "extensions",
    mount(context: RendererSettingsPageMountContext) {
      const container = createEl(
        context.content.ownerDocument,
        "div",
        "settings-extension-plugin-page",
      );
      container.dataset.extensionId = extensionId;
      container.dataset.settingsMode = "custom";
      context.content.append(container);
      const cleanup = contribution.mount(container, {
        locale: messages.locale,
        storage: services.storage,
        assets: services.assets,
        backend: services.backend,
      });
      return typeof cleanup === "function" ? cleanup : undefined;
    },
  });
}

export function createDesktopExtensionPluginPagesSource(options: {
  readonly messages: RendererSettingsMessages;
  readonly getHost?: () => DesktopExtensionHost | null | undefined;
  readonly getClient?: () => DesktopExtensionSurfaceClient | null | undefined;
}): RendererSettingsPluginPagesSource {
  const { messages, getHost = () => null, getClient = () => null } = options;
  const listeners = new Set<() => void>();
  // Remember listed IDs so an uninstalled extension cannot fall back to a stale legacy registration.
  const knownInstalledIds = new Set<string>();
  let installedById = new Map<string, HostExtensionListItem>();
  let lastAppliedConfigRevision: number | null = null;
  let cachedPages: readonly RendererSettingsDynamicPageEntry[] = [];
  let cachedEntriesByExtension = new Map<string, RendererSettingsDynamicPageEntry>();
  let hostUnsubscribe: (() => void) | undefined;
  let boundHost: DesktopExtensionHost | null = null;
  let hostGeneration = 0;
  let disposed = false;

  const rebuild = (): void => {
    const nextEntries = new Map<string, RendererSettingsDynamicPageEntry>();
    // Keep IDs stable for surviving pages whose extension IDs map to the same slug.
    const usedIds = new Set(cachedPages.map((entry) => entry.definition.id));
    const add = (
      extensionId: string,
      revision: string,
      iconDataUrl: string | undefined,
      buildDefinition: (pageId: string) => RendererSettingsPageDefinition,
    ): void => {
      const existing = cachedEntriesByExtension.get(extensionId);
      if (existing?.revision === revision && existing.iconDataUrl === iconDataUrl) {
        nextEntries.set(extensionId, existing);
        return;
      }
      const pageId =
        existing?.definition.id ?? desktopExtensionSettingsPageId(extensionId, usedIds);
      usedIds.add(pageId);
      nextEntries.set(extensionId, {
        extensionId,
        definition: buildDefinition(pageId),
        revision,
        ...(iconDataUrl ? { iconDataUrl } : {}),
      });
    };

    for (const item of installedById.values()) {
      if (item.state !== "valid" || !item.enabled || !item.manifest.page) continue;
      const revision = `page:${item.activationId}:${item.digest}`;
      add(item.id, revision, item.iconDataUrl, (pageId) =>
        Object.freeze<RendererSettingsPageDefinition>({
          id: pageId,
          label: desktopExtensionPageTitle(item, messages.locale).slice(0, 64),
          icon: "extensions",
          mount({ content, signal }) {
            const document = content.ownerDocument;
            const preference = readContentLocalePreference(document.defaultView);
            const pageHost = createDesktopExtensionPageHost({
              document,
              host: content,
              signal,
              messages,
              getClient: () => getClient() ?? null,
              getContentLocale: () => (preference === "system" ? messages.locale : preference),
            });
            pageHost.open(item);
            return () => pageHost.dispose();
          },
        }),
      );
    }

    const host = boundHost;
    for (const entry of host?.getRegisteredSettingsPages() ?? []) {
      if (entry.kind !== "custom" || !entry.page || !host || nextEntries.has(entry.extensionId))
        continue;
      const installed = installedById.get(entry.extensionId);
      if (
        knownInstalledIds.has(entry.extensionId) &&
        (installed?.state !== "valid" || !installed.enabled)
      )
        continue;
      const contribution = entry.page;
      add(
        entry.extensionId,
        `custom:${hostGeneration}:${entry.revision}`,
        installed?.state === "valid" ? installed.iconDataUrl : undefined,
        (pageId) =>
          createCustomExtensionSettingsPageDefinition({
            pageId,
            extensionId: entry.extensionId,
            title: entry.title,
            contribution,
            messages,
            services: host.createExtensionServices(entry.extensionId),
          }),
      );
    }

    const nextPages = [...nextEntries.values()];
    if (
      nextPages.length === cachedPages.length &&
      nextPages.every((entry, index) => entry === cachedPages[index])
    )
      return;
    cachedEntriesByExtension = nextEntries;
    cachedPages = Object.freeze(nextPages);
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // Ignore subscriber errors.
      }
    }
  };

  const ensureHostSubscription = (): void => {
    if (disposed) return;
    const host = getHost() ?? null;
    if (host === boundHost) return;
    hostUnsubscribe?.();
    boundHost = host;
    hostGeneration += 1;
    hostUnsubscribe = host?.subscribeSettingsPages(rebuild);
    rebuild();
  };

  ensureHostSubscription();

  return {
    getPages() {
      ensureHostSubscription();
      return cachedPages;
    },
    getPageIdForExtension(extensionId) {
      ensureHostSubscription();
      return cachedEntriesByExtension.get(extensionId)?.definition.id;
    },
    hasPageForExtension(extensionId) {
      ensureHostSubscription();
      return cachedEntriesByExtension.has(extensionId);
    },
    syncInstalledExtensions(extensions, configRevision) {
      if (disposed) return;
      if (typeof configRevision === "number" && Number.isFinite(configRevision)) {
        if (lastAppliedConfigRevision !== null && configRevision < lastAppliedConfigRevision)
          return;
        lastAppliedConfigRevision = configRevision;
      }
      installedById = new Map(extensions.map((item) => [item.id, item]));
      for (const id of installedById.keys()) knownInstalledIds.add(id);
      ensureHostSubscription();
      rebuild();
    },
    notifySettingsChanged(extensionId, values) {
      if (!disposed) getHost()?.notifyStorageChange(extensionId, values);
    },
    subscribe(listener) {
      ensureHostSubscription();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      hostUnsubscribe?.();
      hostUnsubscribe = undefined;
      boundHost = null;
      listeners.clear();
    },
  };
}
