import type { HarnessAdapter } from "@codexhost/harness-adapter";
import {
  harnessModelRefFromKey,
  harnessModelRefKey,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessPreferenceValues,
} from "@codexhost/shared-contracts";
import { normalizeStoredModelRef, storedModelCatalog } from "./stored-model-ref.js";

export function storedPreferenceModelMigration(input: {
  adapters: ReadonlyMap<string, HarnessAdapter>;
  loadAdapters: () => Promise<void>;
  inspectCodex: () => Promise<HarnessModelCatalog | undefined>;
}) {
  return async (values: HarnessPreferenceValues, migrated: Set<string>) => {
    const defaults = values.newThread?.byHarness ?? {};
    const delegation = values.delegation?.byHarness ?? {};
    const harnesses = new Set([
      ...Object.keys(values.favorites),
      ...Object.keys(defaults),
      ...Object.keys(delegation),
    ]);
    await Promise.all(
      [...harnesses].map(async (id) => {
        if (migrated.has(id)) return;
        const favorites = values.favorites[id];
        const newThread = defaults[id];
        const delegated = delegation[id];
        if (!favorites?.length && !newThread?.model && !delegated?.model) return;
        const catalog = await (async () => {
          if (id === "codex") return input.inspectCodex();
          await input.loadAdapters();
          const adapter = input.adapters.get(id);
          return adapter && storedModelCatalog(adapter);
        })().catch(() => undefined);
        if (!catalog) return;

        const adapter = input.adapters.get(id);
        // A missing Model may return later. Catalog consumers decide whether it can be used.
        const normalize = async (ref: HarnessModelRef) =>
          (await normalizeStoredModelRef(ref, catalog, id, adapter)) ?? ref;
        if (favorites?.length) {
          const keys = new Set<string>();
          for (const key of favorites) {
            let ref: HarnessModelRef;
            try {
              ref = harnessModelRefFromKey(key);
            } catch {
              keys.add(key);
              continue;
            }
            const model = await normalize(ref);
            keys.add(model === ref ? key : harnessModelRefKey(model));
          }
          values.favorites[id] = [...keys];
        }
        if (newThread?.model) newThread.model = await normalize(newThread.model);
        if (delegated?.model) delegated.model = await normalize(delegated.model);
        migrated.add(id);
      }),
    );
  };
}
