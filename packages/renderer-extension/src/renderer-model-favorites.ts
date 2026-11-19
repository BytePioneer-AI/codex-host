const STORAGE_KEY = "codexhost.model-favorites.v1";
import { installedHarnessPluginIdSchema } from "@codexhost/shared-contracts";
import {
  rendererHarnessPreferences,
  rendererHarnessPreferenceGeneration,
  HARNESS_PREFERENCES_UPDATED_EVENT,
  writeRendererHarnessPreferences,
} from "./renderer-harness-preferences.js";

export interface ModelFavoritesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const pending = new Map<string, { generation: number }>();
export function modelFavoritesPending(harnessId: string): boolean {
  return (
    !rendererHarnessPreferences() ||
    pending.get(harnessId)?.generation === rendererHarnessPreferenceGeneration()
  );
}

// Each Harness owns its opaque model refs; never infer identity from display labels.
export function readModelFavorites(
  harnessId: string,
  storage?: ModelFavoritesStorage | null,
): Set<string> {
  try {
    if (storage === undefined)
      return new Set(rendererHarnessPreferences()?.values.favorites[harnessId] ?? []);
    const value: unknown = JSON.parse(storage?.getItem(`${STORAGE_KEY}:${harnessId}`) ?? "[]");
    return new Set(
      Array.isArray(value)
        ? value.filter((id): id is string => typeof id === "string" && id.length > 0)
        : [],
    );
  } catch {
    return new Set();
  }
}

export function writeModelFavorites(
  harnessId: string,
  favorites: ReadonlySet<string>,
  storage?: ModelFavoritesStorage | null,
): Promise<void> {
  try {
    if (storage === undefined) {
      if (modelFavoritesPending(harnessId)) return Promise.resolve();
      const before = new Set(rendererHarnessPreferences()?.values.favorites[harnessId] ?? []);
      const operations = [...new Set([...before, ...favorites])]
        .filter((id) => before.has(id) !== favorites.has(id))
        .map((modelId) => ({
          kind: "favorite" as const,
          harnessId: installedHarnessPluginIdSchema.parse(harnessId),
          modelId,
          enabled: favorites.has(modelId),
        }));
      if (!operations.length) return Promise.resolve();
      const operation = { generation: rendererHarnessPreferenceGeneration() };
      pending.set(harnessId, operation);
      return writeRendererHarnessPreferences(window, "local", operations).finally(() => {
        if (pending.get(harnessId) !== operation) return;
        pending.delete(harnessId);
        window.dispatchEvent(
          new CustomEvent(HARNESS_PREFERENCES_UPDATED_EVENT, { detail: { hostId: "local" } }),
        );
      });
    }
    storage?.setItem(`${STORAGE_KEY}:${harnessId}`, JSON.stringify([...favorites]));
  } catch {
    // A storage failure must not interrupt model selection.
  }
  return Promise.resolve();
}
