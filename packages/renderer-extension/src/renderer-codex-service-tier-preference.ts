import {
  DEFAULT_CODEX_SERVICE_TIER_SETTINGS,
  codexServiceTierSettingsSchema,
  type CodexServiceTierEffect,
  type CodexServiceTierSettings,
} from "@codexhost/shared-contracts";
import type { RendererModelClient } from "./renderer-model-client.js";
import { RendererMethodUnavailableError } from "./renderer-request-sender.js";

export const CODEX_SERVICE_TIER_STORAGE_KEY = "codexhost.codex-service-tier.v1";
export const CODEX_SERVICE_TIER_CHANGE_EVENT = "codexhost:codex-service-tier-changed";
export const CODEX_SERVICE_TIER_STATUS_EVENT = "codexhost:codex-service-tier-status";
/** The `<html>` attribute that mirrors a Host-confirmed active tier. */
export const CODEX_SERVICE_TIER_ATTRIBUTE = "data-codexhost-service-tier";
export type CodexServiceTierSyncStatus = "pending" | "applied" | "unavailable" | "failed";

/** Status payload for observers; the Host effect is carried only by an `applied` report. */
export interface CodexServiceTierStatusDetail {
  readonly status: CodexServiceTierSyncStatus;
  readonly effect?: CodexServiceTierEffect;
}

export function readCodexServiceTierPreference(owner: Window): CodexServiceTierSettings {
  try {
    const raw = owner.localStorage.getItem(CODEX_SERVICE_TIER_STORAGE_KEY);
    const parsed = codexServiceTierSettingsSchema.safeParse(raw ? JSON.parse(raw) : null);
    if (parsed.success) return parsed.data;
  } catch {
    /* An unavailable preference store must not change the Codex config. */
  }
  return { ...DEFAULT_CODEX_SERVICE_TIER_SETTINGS };
}

export function writeCodexServiceTierPreference(
  owner: Window,
  value: CodexServiceTierSettings,
): boolean {
  const parsed = codexServiceTierSettingsSchema.safeParse(value);
  if (!parsed.success) return false;
  try {
    owner.localStorage.setItem(CODEX_SERVICE_TIER_STORAGE_KEY, JSON.stringify(parsed.data));
  } catch {
    return false;
  }
  owner.dispatchEvent(new Event(CODEX_SERVICE_TIER_CHANGE_EVENT));
  return true;
}

/** One connection synchronizer per Renderer installation; never uses the active remote route. */
export function installCodexServiceTierPreferenceSync(owner: Window): {
  connect(client: RendererModelClient | null): void;
  dispose(): void;
} {
  let client: RendererModelClient | null = null;
  let disposed = false;
  let generation = 0;
  let work = { pending: false, dirty: false };
  // The marker mirrors the last confirmed active effect; each local Composer
  // projects it into its own display scope without exposing a draft choice.
  const documentElement = (): HTMLElement | null =>
    (owner as { document?: Document }).document?.documentElement ?? null;
  const clearTierMarker = (): void => {
    const element = documentElement();
    if (element) delete element.dataset.codexhostServiceTier;
  };
  const applyEffect = (
    settings: CodexServiceTierSettings,
    effect: CodexServiceTierEffect,
  ): void => {
    const element = documentElement();
    if (!element) return;
    if (effect.state === "active") element.dataset.codexhostServiceTier = settings.tier;
    else delete element.dataset.codexhostServiceTier;
  };
  const publish = (detail: CodexServiceTierStatusDetail): void => {
    owner.dispatchEvent(new CustomEvent(CODEX_SERVICE_TIER_STATUS_EVENT, { detail }));
  };
  const sync = async (): Promise<void> => {
    const currentWork = work;
    const version = generation;
    currentWork.dirty = true;
    if (currentWork.pending || disposed) return;
    currentWork.pending = true;
    try {
      while (currentWork.dirty && !disposed && version === generation) {
        currentWork.dirty = false;
        const target = client;
        if (!target) {
          publish({ status: "pending" });
          continue;
        }
        if (!target.setCodexServiceTier) {
          clearTierMarker();
          publish({ status: "unavailable" });
          continue;
        }
        // Read at send time, never replay a window's cached preference on reconnect.
        const settings = readCodexServiceTierPreference(owner);
        publish({ status: "pending" });
        try {
          const result = await target.setCodexServiceTier(settings);
          if (!disposed && version === generation && !currentWork.dirty) {
            applyEffect(result.settings, result.effect);
            publish({ status: "applied", effect: result.effect });
          }
        } catch (error) {
          if (!disposed && version === generation && !currentWork.dirty) {
            clearTierMarker();
            publish({
              status: error instanceof RendererMethodUnavailableError ? "unavailable" : "failed",
            });
          }
        }
      }
    } finally {
      currentWork.pending = false;
    }
  };
  const changed = (): void => {
    void sync();
  };
  const storage = (event: StorageEvent): void => {
    if (event.key === CODEX_SERVICE_TIER_STORAGE_KEY || event.key === null) changed();
  };
  owner.addEventListener(CODEX_SERVICE_TIER_CHANGE_EVENT, changed);
  owner.addEventListener("storage", storage);
  return {
    connect(next) {
      if (disposed) return;
      if (next === client) return;
      client = next;
      generation += 1;
      work = { pending: false, dirty: false };
      // Without a connection no effect can be confirmed, so a previous one stops applying.
      if (!next) clearTierMarker();
      void sync();
    },
    dispose() {
      disposed = true;
      generation += 1;
      client = null;
      clearTierMarker();
      owner.removeEventListener(CODEX_SERVICE_TIER_CHANGE_EVENT, changed);
      owner.removeEventListener("storage", storage);
    },
  };
}
