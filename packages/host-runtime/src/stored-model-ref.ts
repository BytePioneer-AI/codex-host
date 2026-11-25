import type { HarnessAdapter, InspectHarnessInput } from "@codexhost/harness-adapter";
import {
  catalogModelForRef,
  normalizeOfficialCodexModelRef,
  type HarnessModelCatalog,
  type HarnessModelRef,
} from "@codexhost/shared-contracts";

export async function normalizeStoredModelRef(
  ref: HarnessModelRef,
  catalog: HarnessModelCatalog | undefined,
  harnessId: string,
  adapter?: HarnessAdapter,
): Promise<HarnessModelRef | undefined> {
  if (!catalog || catalogModelForRef(catalog, ref)) return ref;
  try {
    const normalized =
      harnessId === "codex"
        ? normalizeOfficialCodexModelRef(ref)
        : await adapter?.normalizeStoredModelRef?.(ref, catalog);
    return catalogModelForRef(catalog, normalized) ? normalized : undefined;
  } catch {
    return undefined;
  }
}

export async function storedModelCatalog(adapter: HarnessAdapter, input?: InspectHarnessInput) {
  const inspection = await adapter.inspect(input).catch(() => undefined);
  return inspection?.status === "ready" ? inspection.catalog : undefined;
}
