import type { HarnessAdapter } from "@codexhost/harness-adapter";
import {
  harnessModelRefFromKey,
  harnessModelRefKey,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessPreferenceSnapshot,
} from "@codexhost/shared-contracts";
import { normalizeStoredModelRef, storedModelCatalog } from "./stored-model-ref.js";

export function storedPreferenceModels(input: {
  adapters: ReadonlyMap<string, HarnessAdapter>;
  loadAdapters: () => Promise<void>;
  inspectCodex: () => Promise<HarnessModelCatalog | undefined>;
}) {
  const catalogs = new Map<string, Promise<HarnessModelCatalog | undefined>>();
  async function resolve(harnessId: string, ref: HarnessModelRef) {
    let catalog = catalogs.get(harnessId);
    if (!catalog) {
      catalog = (
        harnessId === "codex"
          ? input.inspectCodex()
          : input.loadAdapters().then(() => {
              const adapter = input.adapters.get(harnessId);
              return adapter && storedModelCatalog(adapter);
            })
      ).catch(() => undefined);
      catalogs.set(harnessId, catalog);
    }
    return normalizeStoredModelRef(ref, await catalog, harnessId, input.adapters.get(harnessId));
  }
  async function favorite(harnessId: string, key: string) {
    let ref: HarnessModelRef;
    try {
      ref = harnessModelRefFromKey(key);
    } catch {
      return undefined;
    }
    const model = await resolve(harnessId, ref);
    return model && harnessModelRefKey(model);
  }
  async function snapshot(value: HarnessPreferenceSnapshot): Promise<HarnessPreferenceSnapshot> {
    const { values } = value;
    const favorites = Object.fromEntries(
      await Promise.all(
        Object.entries(values.favorites).map(async ([harnessId, keys]) => {
          const models = new Set<string>();
          for (const key of keys) {
            const model = await favorite(harnessId, key);
            if (model !== undefined) models.add(model);
          }
          return [harnessId, [...models]];
        }),
      ),
    );
    const newThread = values.newThread && {
      ...values.newThread,
      byHarness: Object.fromEntries(
        await Promise.all(
          Object.entries(values.newThread.byHarness).map(async ([harnessId, saved]) => {
            if (!saved.model) return [[harnessId, saved]] as const;
            const model = await resolve(harnessId, saved.model);
            if (model) return [[harnessId, { ...saved, model }]] as const;
            return saved.permissionModeId
              ? ([[harnessId, { permissionModeId: saved.permissionModeId }]] as const)
              : [];
          }),
        ).then((entries) => entries.flat()),
      ),
    };
    const delegation = values.delegation && {
      byHarness: Object.fromEntries(
        await Promise.all(
          Object.entries(values.delegation.byHarness).map(async ([harnessId, saved]) => {
            if (!saved.model) return [[harnessId, saved]] as const;
            const model = await resolve(harnessId, saved.model);
            return model ? ([[harnessId, { ...saved, model }]] as const) : [];
          }),
        ).then((entries) => entries.flat()),
      ),
    };
    return {
      ...value,
      values: {
        ...values,
        favorites,
        ...(newThread ? { newThread } : {}),
        ...(delegation ? { delegation } : {}),
      },
    };
  }
  return { favorite, snapshot };
}
