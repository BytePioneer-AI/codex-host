import {
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";

import {
  KNOWN_RENDERER_AGENTS,
  type ExternalRendererAgent,
  type RendererAgent,
} from "./agent-selection-state.js";

export const RENDERER_NEW_THREAD_PREFERENCE_KEY = "codexhost.new-thread-preference.v1";

interface ExternalConfigurationPreference {
  model: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
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

function rendererStorage(): PreferenceStorage | null {
  try {
    return window.localStorage;
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
  return {
    model: model.data,
    ...(thinkingOptionId.success ? { thinkingOptionId: thinkingOptionId.data } : {}),
  };
}

function readPreference(storage: PreferenceStorage | null): NewThreadPreference | undefined {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(RENDERER_NEW_THREAD_PREFERENCE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1) return undefined;
    if (!KNOWN_RENDERER_AGENTS.some((agent) => agent === parsed.lastAgent)) return undefined;
    const externalByAgent = isRecord(parsed.externalByAgent) ? parsed.externalByAgent : {};
    const pi = parseExternalConfiguration(externalByAgent.pi);
    const claudeCode = parseExternalConfiguration(externalByAgent["claude-code"]);
    return {
      version: 1,
      lastAgent: parsed.lastAgent as RendererAgent,
      externalByAgent: {
        ...(pi ? { pi } : {}),
        ...(claudeCode ? { "claude-code": claudeCode } : {}),
      },
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
  enabledAgents: ReadonlySet<RendererAgent>,
  storage: PreferenceStorage | null = rendererStorage(),
): RendererAgent | undefined {
  const agent = readPreference(storage)?.lastAgent;
  return agent && enabledAgents.has(agent) ? agent : undefined;
}

export function readNewThreadExternalConfigurationPreference(
  agent: ExternalRendererAgent,
  catalog: HarnessModelCatalog,
  storage: PreferenceStorage | null = rendererStorage(),
): ExternalConfigurationPreference | undefined {
  const preference = readPreference(storage)?.externalByAgent[agent];
  if (!preference) return undefined;
  const catalogModel = catalog.models.find(({ ref }) => ref.id === preference.model.id);
  if (!catalogModel) return undefined;
  const thinkingOptionId =
    preference.thinkingOptionId &&
    catalogModel.supportedThinkingOptionIds?.includes(preference.thinkingOptionId)
      ? preference.thinkingOptionId
      : undefined;
  return {
    model: catalogModel.ref,
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
  };
}

export function writeNewThreadAgentPreference(
  agent: RendererAgent,
  storage: PreferenceStorage | null = rendererStorage(),
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
  storage: PreferenceStorage | null = rendererStorage(),
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
        },
      },
    },
    storage,
  );
}
