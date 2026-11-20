import {
  resolveLocalizedExtensionText,
  type DesktopExtensionSettingField,
  type DesktopExtensionsListResult,
} from "@codexhost/shared-contracts";
import {
  cloneStorageValues,
  type DesktopExtensionAssetsApi,
  type DesktopExtensionBackendApi,
  type DesktopExtensionSettingsPageContribution,
  type DesktopExtensionStorageApi,
} from "../desktop-extension-api.js";
import type { DesktopExtensionHost } from "../desktop-extension-host.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import { createEl, errorMessage, formatMessage } from "./desktop-extensions-shared.js";
import { isRendererSettingsIconName, type RendererSettingsIconName } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";
import {
  createPreferenceGroup,
  createPreferenceItem,
  createPreferenceSwitch,
  preferenceId,
} from "./preference-ui.js";

export interface DesktopExtensionSettingsRpcClient {
  listDesktopExtensions?(): Promise<DesktopExtensionsListResult>;
  readDesktopExtensionAsset?(input: {
    id: string;
    path: string;
  }): Promise<{ mimeType: string; dataUrl: string }>;
  getDesktopExtensionSettings?(input: { id: string }): Promise<{ values: Record<string, unknown> }>;
  setDesktopExtensionSettings?(input: {
    id: string;
    values: Record<string, unknown>;
  }): Promise<{ values: Record<string, unknown> }>;
  invokeDesktopExtensionBackend?(input: {
    id: string;
    method: string;
    params?: unknown;
  }): Promise<{ result: unknown }>;
}

export interface RendererSettingsDynamicPageEntry {
  readonly extensionId: string;
  readonly definition: RendererSettingsPageDefinition;
}

export interface RendererSettingsPluginPagesSource {
  getPages(): readonly RendererSettingsDynamicPageEntry[];
  getPageIdForExtension(extensionId: string): string | undefined;
  hasPageForExtension(extensionId: string): boolean;
  syncInstalledExtensions?(extensions: DesktopExtensionsListResult["extensions"]): void;
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

function resolvePageLabel(
  title: string | { readonly en: string; readonly "zh-CN": string } | undefined,
  fallbackId: string,
  locale: RendererSettingsMessages["locale"],
): string {
  const raw = title ? resolveLocalizedExtensionText(title, locale).trim() : "";
  const resolved = raw || fallbackId;
  return resolved.length > 64 ? resolved.slice(0, 64) : resolved;
}

function resolvePageIcon(icon: RendererSettingsIconName | undefined): RendererSettingsIconName {
  return icon && isRendererSettingsIconName(icon) ? icon : "extensions";
}

function fieldDefaultValue(field: DesktopExtensionSettingField): unknown {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case "boolean":
      return false;
    case "string":
      return "";
    case "number":
      return field.min ?? 0;
    case "range":
      return field.min;
    case "select":
      return field.options[0]?.value ?? "";
  }
}

function coerceFieldValue(field: DesktopExtensionSettingField, raw: unknown): unknown {
  switch (field.type) {
    case "boolean":
      return typeof raw === "boolean" ? raw : fieldDefaultValue(field);
    case "string":
      return typeof raw === "string" ? raw : fieldDefaultValue(field);
    case "number":
    case "range":
      if (typeof raw === "number" && Number.isFinite(raw)) {
        if (field.min !== undefined && raw < field.min) return field.min;
        if (field.max !== undefined && raw > field.max) return field.max;
        return raw;
      }
      return fieldDefaultValue(field);
    case "select":
      if (typeof raw === "string" && field.options.some((opt) => opt.value === raw)) {
        return raw;
      }
      return fieldDefaultValue(field);
  }
}

export function createSchemaSettingsPageDefinition(options: {
  readonly pageId: string;
  readonly extensionId: string;
  readonly title: string | { readonly en: string; readonly "zh-CN": string } | undefined;
  readonly schema: readonly DesktopExtensionSettingField[];
  readonly messages: RendererSettingsMessages;
  readonly storage: DesktopExtensionStorageApi;
}): RendererSettingsPageDefinition {
  const { pageId, extensionId, title, schema, messages, storage } = options;
  const label = resolvePageLabel(title, extensionId, messages.locale);
  const copy = messages.desktopExtensions;

  return Object.freeze({
    id: pageId,
    label,
    icon: "extensions" as const,
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const root = createEl(document, "div", "settings-extension-plugin-page");
      root.dataset.extensionId = extensionId;
      root.dataset.settingsMode = "schema";

      const header = createEl(document, "div", "settings-extension-plugin-page__header");
      const heading = createEl(document, "h1", "settings-section-label", label);
      const status = createEl(document, "span", "settings-extension-plugin-page__status");
      status.setAttribute("role", "status");
      status.hidden = true;
      header.append(heading, status);

      const { group, card } = createPreferenceGroup(document, messages.title);

      let currentValues: Record<string, unknown> = {};
      for (const field of schema) {
        currentValues[field.key] = fieldDefaultValue(field);
      }
      let saveVersion = 0;
      let disposed = false;

      const setStatus = (text: string | null, tone: "muted" | "success" | "danger" = "muted") => {
        if (!text) {
          status.hidden = true;
          status.textContent = "";
          delete status.dataset.tone;
          return;
        }
        status.hidden = false;
        status.dataset.tone = tone;
        status.textContent = text;
      };

      const controlSyncers = new Map<string, (value: unknown) => void>();

      const applyValuesToControls = (values: Record<string, unknown>): void => {
        currentValues = { ...currentValues, ...values };
        for (const field of schema) {
          const coerced = coerceFieldValue(field, currentValues[field.key]);
          currentValues[field.key] = coerced;
          controlSyncers.get(field.key)?.(coerced);
        }
      };

      const persistValue = (key: string, value: unknown): void => {
        const nextValues = { ...currentValues, [key]: value };
        currentValues = nextValues;
        const version = ++saveVersion;
        setStatus(copy.extensionSettingsSaving, "muted");
        void storage
          .set(nextValues)
          .then((saved) => {
            if (disposed || context.signal.aborted || version !== saveVersion) return;
            applyValuesToControls(saved);
            setStatus(copy.extensionSettingsSaved, "success");
          })
          .catch((error: unknown) => {
            if (disposed || context.signal.aborted || version !== saveVersion) return;
            setStatus(
              formatMessage(copy.extensionSettingsSaveFailed, { message: errorMessage(error) }),
              "danger",
            );
          });
      };

      for (const field of schema) {
        const controlId = preferenceId(`ext-setting-${extensionId}-${field.key}`);
        const fieldLabel = resolveLocalizedExtensionText(field.label, messages.locale);
        const fieldDescription = field.description
          ? resolveLocalizedExtensionText(field.description, messages.locale)
          : "";
        const { item, description } = createPreferenceItem(document, {
          title: fieldLabel,
          description: fieldDescription,
          controlId,
        });
        if (!fieldDescription) description.hidden = true;

        if (field.type === "boolean") {
          const toggle = createPreferenceSwitch(document, controlId, description.id);
          toggle.dataset.settingKey = field.key;
          toggle.checked = Boolean(currentValues[field.key]);
          toggle.addEventListener("change", () => {
            persistValue(field.key, toggle.checked);
          });
          controlSyncers.set(field.key, (value) => {
            toggle.checked = Boolean(value);
          });
          item.append(toggle);
        } else if (field.type === "string") {
          const input = createEl(
            document,
            "input",
            "settings-extension-schema__input settings-extension-schema__input--text",
          );
          input.type = "text";
          input.id = controlId;
          input.dataset.settingKey = field.key;
          if (field.placeholder) {
            input.placeholder = resolveLocalizedExtensionText(field.placeholder, messages.locale);
          }
          input.value = String(currentValues[field.key] ?? "");
          input.setAttribute("aria-describedby", description.id);
          input.addEventListener("change", () => {
            persistValue(field.key, input.value);
          });
          controlSyncers.set(field.key, (value) => {
            input.value = String(value ?? "");
          });
          item.append(input);
        } else if (field.type === "number") {
          const input = createEl(
            document,
            "input",
            "settings-extension-schema__input settings-extension-schema__input--number",
          );
          input.type = "number";
          input.id = controlId;
          input.dataset.settingKey = field.key;
          if (field.min !== undefined) input.min = String(field.min);
          if (field.max !== undefined) input.max = String(field.max);
          if (field.step !== undefined) input.step = String(field.step);
          input.value = String(currentValues[field.key] ?? "");
          input.setAttribute("aria-describedby", description.id);
          input.addEventListener("change", () => {
            const parsed = Number(input.value);
            const invalid =
              input.value.trim() === "" ||
              !Number.isFinite(parsed) ||
              (field.min !== undefined && parsed < field.min) ||
              (field.max !== undefined && parsed > field.max);
            if (invalid) {
              input.dataset.invalid = "true";
              return;
            }
            delete input.dataset.invalid;
            persistValue(field.key, parsed);
          });
          controlSyncers.set(field.key, (value) => {
            delete input.dataset.invalid;
            input.value = String(value ?? "");
          });
          item.append(input);
        } else if (field.type === "range") {
          const wrap = createEl(document, "div", "settings-extension-schema__range");
          const input = createEl(document, "input", "settings-extension-schema__slider");
          input.type = "range";
          input.id = controlId;
          input.dataset.settingKey = field.key;
          input.min = String(field.min);
          input.max = String(field.max);
          if (field.step !== undefined) input.step = String(field.step);
          const initialValue = Number(currentValues[field.key] ?? field.min);
          input.value = String(initialValue);
          input.setAttribute("aria-describedby", description.id);
          const output = createEl(
            document,
            "output",
            "settings-extension-schema__range-value",
            String(initialValue),
          );
          input.addEventListener("input", () => {
            output.textContent = input.value;
          });
          input.addEventListener("change", () => {
            const parsed = Number(input.value);
            output.textContent = input.value;
            if (Number.isFinite(parsed)) persistValue(field.key, parsed);
          });
          controlSyncers.set(field.key, (value) => {
            const text = String(value ?? field.min);
            input.value = text;
            output.textContent = text;
          });
          wrap.append(input, output);
          item.append(wrap);
        } else if (field.type === "select") {
          const select = createEl(document, "select", "settings-extension-schema__select");
          select.id = controlId;
          select.dataset.settingKey = field.key;
          select.setAttribute("aria-describedby", description.id);
          for (const option of field.options) {
            const optEl = document.createElement("option");
            optEl.value = option.value;
            optEl.textContent = resolveLocalizedExtensionText(option.label, messages.locale);
            select.append(optEl);
          }
          select.value = String(currentValues[field.key] ?? "");
          select.addEventListener("change", () => {
            persistValue(field.key, select.value);
          });
          controlSyncers.set(field.key, (value) => {
            select.value = String(value ?? "");
          });
          item.append(select);
        }

        card.append(item);
      }

      root.append(header, group);
      context.content.append(root);

      const unsubscribeStorage = storage.onChange((updated) => {
        if (!disposed && !context.signal.aborted) {
          applyValuesToControls(updated);
        }
      });

      void context.runLatest(async () => storage.get(), {
        success(loaded) {
          if (!disposed && !context.signal.aborted) {
            applyValuesToControls(loaded);
          }
        },
        failure(error) {
          if (!disposed && !context.signal.aborted) {
            setStatus(
              formatMessage(copy.extensionSettingsLoadFailed, { message: errorMessage(error) }),
              "danger",
            );
          }
        },
      });

      return () => {
        disposed = true;
        unsubscribeStorage();
      };
    },
  });
}

export function createCustomExtensionSettingsPageDefinition(options: {
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
  const label = resolvePageLabel(contribution.title ?? title, extensionId, messages.locale);
  const icon = resolvePageIcon(contribution.icon);

  return Object.freeze({
    id: pageId,
    label,
    icon,
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
  readonly getClient?: () => DesktopExtensionSettingsRpcClient | null | undefined;
}): RendererSettingsPluginPagesSource {
  const { messages, getHost = () => null, getClient = () => null } = options;
  const listeners = new Set<() => void>();
  const localStorageListeners = new Map<string, Set<(values: Record<string, unknown>) => void>>();
  let installedSchemaExtensions: Array<{
    readonly id: string;
    readonly name: string | { readonly en: string; readonly "zh-CN": string };
    readonly schema: readonly DesktopExtensionSettingField[];
  }> = [];
  let cachedPages: readonly RendererSettingsDynamicPageEntry[] = [];
  let extensionToPageId = new Map<string, string>();
  let hostUnsubscribe: (() => void) | null = null;
  let boundHost: DesktopExtensionHost | null = null;
  let disposed = false;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // Ignore subscriber errors.
      }
    }
  };

  const subscribeLocalStorage = (
    extensionId: string,
    listener: (values: Record<string, unknown>) => void,
  ): (() => void) => {
    let bucket = localStorageListeners.get(extensionId);
    if (!bucket) {
      bucket = new Set();
      localStorageListeners.set(extensionId, bucket);
    }
    bucket.add(listener);
    return () => {
      const current = localStorageListeners.get(extensionId);
      current?.delete(listener);
      if (current && current.size === 0) localStorageListeners.delete(extensionId);
    };
  };

  const createFallbackServices = (extensionId: string) => {
    const assets: DesktopExtensionAssetsApi = {
      async readDataUrl(relativePath: string) {
        const reader = getClient()?.readDesktopExtensionAsset;
        if (!reader) throw new Error("Desktop extension assets RPC is unavailable");
        return reader({ id: extensionId, path: relativePath });
      },
    };
    const storage: DesktopExtensionStorageApi = {
      async get() {
        const reader = getClient()?.getDesktopExtensionSettings;
        if (!reader) throw new Error("Desktop extension settings RPC is unavailable");
        return cloneStorageValues((await reader({ id: extensionId })).values);
      },
      async set(values: Record<string, unknown>) {
        const writer = getClient()?.setDesktopExtensionSettings;
        if (!writer) throw new Error("Desktop extension settings RPC is unavailable");
        const updated = (await writer({ id: extensionId, values })).values;
        getHost()?.notifyStorageChange(extensionId, updated);
        const bucket = localStorageListeners.get(extensionId);
        if (bucket) {
          for (const listener of [...bucket]) {
            try {
              listener(cloneStorageValues(updated));
            } catch {
              // Ignore subscriber errors.
            }
          }
        }
        return cloneStorageValues(updated);
      },
      onChange(listener) {
        const host = getHost();
        if (host) {
          return host.createExtensionServices(extensionId).storage.onChange(listener);
        }
        return subscribeLocalStorage(extensionId, listener);
      },
    };
    const backend: DesktopExtensionBackendApi = {
      async invoke(method: string, params?: unknown) {
        const invoker = getClient()?.invokeDesktopExtensionBackend;
        if (!invoker) throw new Error("Desktop extension backend RPC is unavailable");
        return (
          await invoker({
            id: extensionId,
            method,
            ...(params !== undefined ? { params } : {}),
          })
        ).result;
      },
    };
    return { assets, storage, backend };
  };

  const ensureHostSubscription = (): DesktopExtensionHost | null => {
    const host = getHost() ?? null;
    if (host === boundHost) return host;
    hostUnsubscribe?.();
    hostUnsubscribe = null;
    boundHost = host;
    if (host && !disposed) {
      hostUnsubscribe = host.subscribeSettingsPages(() => {
        rebuild();
        notify();
      });
    }
    return host;
  };

  const servicesForExtension = (extensionId: string) => {
    const host = ensureHostSubscription();
    // Prefer direct RPC client when available so settings pages work even without a bound bridge,
    // while still broadcasting storage updates into the live DesktopExtensionHost.
    if (getClient()?.getDesktopExtensionSettings || getClient()?.setDesktopExtensionSettings) {
      return createFallbackServices(extensionId);
    }
    return host ? host.createExtensionServices(extensionId) : createFallbackServices(extensionId);
  };

  const rebuild = (): void => {
    const host = ensureHostSubscription();
    const hostPages = host?.getRegisteredSettingsPages() ?? [];
    const nextPages: RendererSettingsDynamicPageEntry[] = [];
    const usedIds = new Set<string>();
    const nextMap = new Map<string, string>();
    const seenExtensions = new Set<string>();

    for (const entry of hostPages) {
      if (seenExtensions.has(entry.extensionId)) continue;
      seenExtensions.add(entry.extensionId);
      const pageId = desktopExtensionSettingsPageId(entry.extensionId, usedIds);
      usedIds.add(pageId);
      nextMap.set(entry.extensionId, pageId);

      if (entry.kind === "custom" && entry.page) {
        nextPages.push({
          extensionId: entry.extensionId,
          definition: createCustomExtensionSettingsPageDefinition({
            pageId,
            extensionId: entry.extensionId,
            title: entry.title,
            contribution: entry.page,
            messages,
            services: servicesForExtension(entry.extensionId),
          }),
        });
      } else if (entry.kind === "schema" && entry.schema && entry.schema.length > 0) {
        nextPages.push({
          extensionId: entry.extensionId,
          definition: createSchemaSettingsPageDefinition({
            pageId,
            extensionId: entry.extensionId,
            title: entry.title,
            schema: entry.schema,
            messages,
            storage: servicesForExtension(entry.extensionId).storage,
          }),
        });
      }
    }

    for (const ext of installedSchemaExtensions) {
      if (seenExtensions.has(ext.id)) continue;
      seenExtensions.add(ext.id);
      const pageId = desktopExtensionSettingsPageId(ext.id, usedIds);
      usedIds.add(pageId);
      nextMap.set(ext.id, pageId);
      nextPages.push({
        extensionId: ext.id,
        definition: createSchemaSettingsPageDefinition({
          pageId,
          extensionId: ext.id,
          title: ext.name,
          schema: ext.schema,
          messages,
          storage: servicesForExtension(ext.id).storage,
        }),
      });
    }

    cachedPages = Object.freeze(nextPages);
    extensionToPageId = nextMap;
  };

  rebuild();

  return {
    getPages() {
      ensureHostSubscription();
      return cachedPages;
    },
    getPageIdForExtension(extensionId: string) {
      ensureHostSubscription();
      return extensionToPageId.get(extensionId);
    },
    hasPageForExtension(extensionId: string) {
      ensureHostSubscription();
      return extensionToPageId.has(extensionId);
    },
    syncInstalledExtensions(extensions) {
      if (disposed) return;
      const nextSchemaExtensions: typeof installedSchemaExtensions = [];
      for (const item of extensions) {
        if (!item.enabled) continue;
        const manifest = item.manifest;
        if (!manifest?.settingsSchema || manifest.settingsSchema.length === 0) continue;
        nextSchemaExtensions.push({
          id: item.id,
          name: manifest.name,
          schema: manifest.settingsSchema,
        });
      }
      const prevSignature = installedSchemaExtensions
        .map((ext) => `${ext.id}:${JSON.stringify(ext.schema)}`)
        .join("\0");
      const nextSignature = nextSchemaExtensions
        .map((ext) => `${ext.id}:${JSON.stringify(ext.schema)}`)
        .join("\0");
      if (prevSignature === nextSignature) return;
      installedSchemaExtensions = nextSchemaExtensions;
      rebuild();
      notify();
    },
    subscribe(listener) {
      ensureHostSubscription();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      hostUnsubscribe?.();
      hostUnsubscribe = null;
      boundHost = null;
      listeners.clear();
      localStorageListeners.clear();
    },
  };
}
