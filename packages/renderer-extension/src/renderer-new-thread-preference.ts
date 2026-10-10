import {
  catalogModelForRef,
  harnessPluginIdSchema,
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
  type HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";

import { type ExternalRendererAgent, type RendererAgent } from "./agent-selection-state.js";

export const RENDERER_NEW_THREAD_PREFERENCE_KEY = "codexhost.new-thread-preference.v1";

interface ExternalConfigurationPreference {
  model: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  permissionModeId?: HarnessPermissionModeId;
}

interface NewThreadPreference {
  version: 1;
  lastAgent: RendererAgent;
  externalByAgent: Partial<Record<ExternalRendererAgent, ExternalConfigurationPreference>>;
}

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function rendererNewThreadPreferenceStorage(
  hostId: string | null = "local",
): PreferenceStorage | null {
  if (!hostId) return null;
  try {
    const storage = window.localStorage;
    if (hostId === "local") return storage; // Retain the v1 local preference keys.
    const scopedKey = (key: string) => `${key}.host.${encodeURIComponent(hostId)}`;
    return {
      getItem: (key) => storage.getItem(scopedKey(key)),
      setItem: (key, value) => storage.setItem(scopedKey(key), value),
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseExternalConfiguration(value: unknown): ExternalConfigurationPreference | undefined {
  if (!isRecord(value)) return undefined;
  const model = harnessModelRefSchema.safeParse(value.model);
  if (!model.success) return undefined;
  const thinkingOptionId = harnessThinkingOptionIdSchema.safeParse(value.thinkingOptionId);
  const permissionModeId = harnessPermissionModeIdSchema.safeParse(value.permissionModeId);
  return {
    model: model.data,
    ...(thinkingOptionId.success ? { thinkingOptionId: thinkingOptionId.data } : {}),
    ...(permissionModeId.success ? { permissionModeId: permissionModeId.data } : {}),
  };
}

function readPreference(storage: PreferenceStorage | null): NewThreadPreference | undefined {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(RENDERER_NEW_THREAD_PREFERENCE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1) return undefined;
    if (parsed.lastAgent !== "codex" && !harnessPluginIdSchema.safeParse(parsed.lastAgent).success)
      return undefined;
    const externalByAgent = isRecord(parsed.externalByAgent) ? parsed.externalByAgent : {};
    const parsedExternal = Object.fromEntries(
      Object.keys(externalByAgent)
        .filter((agent) => harnessPluginIdSchema.safeParse(agent).success)
        .flatMap((agent) => {
          const configuration = parseExternalConfiguration(externalByAgent[agent]);
          return configuration ? [[agent, configuration]] : [];
        }),
    ) as NewThreadPreference["externalByAgent"];
    return {
      version: 1,
      lastAgent: parsed.lastAgent as RendererAgent,
      externalByAgent: parsedExternal,
    };
  } catch {
    return undefined;
  }
}

function writePreference(preference: NewThreadPreference, storage: PreferenceStorage | null): void {
  if (!storage) return;
  try {
    storage.setItem(RENDERER_NEW_THREAD_PREFERENCE_KEY, JSON.stringify(preference));
  } catch {
    // Preference persistence must not prevent Composer configuration.
  }
}

export function readNewThreadAgentPreference(
  enabledAgents?: ReadonlySet<RendererAgent>,
  storage: PreferenceStorage | null = rendererNewThreadPreferenceStorage(),
): RendererAgent | undefined {
  const agent = readPreference(storage)?.lastAgent;
  return agent && (!enabledAgents || enabledAgents.has(agent)) ? agent : undefined;
}

export function readNewThreadExternalConfigurationPreference(
  agent: ExternalRendererAgent,
  catalog: HarnessModelCatalog,
  permissionModes?: HarnessPermissionModeCatalog,
  storage: PreferenceStorage | null = rendererNewThreadPreferenceStorage(),
): ExternalConfigurationPreference | undefined {
  const preference = readPreference(storage)?.externalByAgent[agent];
  if (!preference) return undefined;
  const catalogModel = catalogModelForRef(catalog, preference.model);
  if (!catalogModel) return undefined;
  const thinkingOptionId =
    preference.thinkingOptionId &&
    catalogModel.supportedThinkingOptionIds?.includes(preference.thinkingOptionId)
      ? preference.thinkingOptionId
      : undefined;
  const permissionModeId =
    preference.permissionModeId &&
    permissionModes?.modes.some(({ id }) => id === preference.permissionModeId)
      ? preference.permissionModeId
      : undefined;
  return {
    model: catalogModel.ref,
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    ...(permissionModeId ? { permissionModeId } : {}),
  };
}

export function writeNewThreadAgentPreference(
  agent: RendererAgent,
  storage: PreferenceStorage | null = rendererNewThreadPreferenceStorage(),
): void {
  const current = readPreference(storage);
  writePreference(
    {
      version: 1,
      lastAgent: agent,
      externalByAgent: current?.externalByAgent ?? {},
    },
    storage,
  );
}

export function writeNewThreadExternalConfigurationPreference(
  agent: ExternalRendererAgent,
  model: HarnessModelRef,
  thinkingOptionId?: HarnessThinkingOptionId,
  permissionModeId?: HarnessPermissionModeId,
  storage: PreferenceStorage | null = rendererNewThreadPreferenceStorage(),
): void {
  const current = readPreference(storage);
  writePreference(
    {
      version: 1,
      lastAgent: current?.lastAgent ?? "codex",
      externalByAgent: {
        ...current?.externalByAgent,
        [agent]: {
          model: harnessModelRefSchema.parse(model),
          ...(thinkingOptionId
            ? { thinkingOptionId: harnessThinkingOptionIdSchema.parse(thinkingOptionId) }
            : {}),
          ...(permissionModeId
            ? { permissionModeId: harnessPermissionModeIdSchema.parse(permissionModeId) }
            : {}),
        },
      },
    },
    storage,
  );
}
