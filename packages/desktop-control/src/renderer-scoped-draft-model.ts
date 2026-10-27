import { committedReactAncestors } from "./renderer-react-ownership.js";

type Draft = Record<string, unknown>;
type UpdateDraft = (update: (current: Draft) => Draft) => void;
interface DraftElement {
  parentElement: DraftElement | null;
}

/** The 26.1021 Sfa memo tuple contains both the client Thread identity and
 * its bound draft setter. Never use the official default Model setter.
 */
export function findScopedDraftUpdater(
  composer: DraftElement,
  draftId: string,
): UpdateDraft | null {
  let element: DraftElement | null = composer;
  let fiber: unknown;
  while (element && !fiber) {
    const key = Object.getOwnPropertyNames(element).find((name) =>
      name.startsWith("__reactFiber$"),
    );
    if (key) fiber = Object.getOwnPropertyDescriptor(element, key)?.value;
    element = element.parentElement;
  }
  for (const ancestor of committedReactAncestors(fiber)) {
    const queue = ancestor.updateQueue as { memoCache?: { data?: unknown[] } } | null;
    for (const row of queue?.memoCache?.data ?? []) {
      if (!Array.isArray(row) || row.length !== 14 || row[6] !== draftId || row[7] !== draftId)
        continue;
      const result = row[13] as {
        draftSettings?: unknown;
        isNewThreadDraft?: unknown;
        updateDraftSettings?: unknown;
      } | null;
      if (
        result?.isNewThreadDraft === true &&
        row[11] === true &&
        result.draftSettings === row[10] &&
        result.updateDraftSettings === row[9] &&
        row[9] === row[12] &&
        typeof row[9] === "function"
      )
        return row[9] as UpdateDraft;
    }
  }
  return null;
}

export function createScopedDraftModelWriter() {
  const captured = new Map<string, { update: UpdateDraft; original: Draft; model: string }>();
  const restore = (key: string): void => {
    const entry = captured.get(key);
    if (!entry) return;
    entry.update((current) => {
      const settings = current.modelSettings as Draft | null;
      return settings?.model === entry.model && current.modelSettingsPersistAsDefault === false
        ? {
            ...current,
            modelSettings: entry.original.modelSettings,
            modelSettingsPersistAsDefault: entry.original.modelSettingsPersistAsDefault,
            isManuallyChanged: entry.original.isManuallyChanged,
          }
        : current;
    });
    captured.delete(key);
  };
  return {
    has(key: string): boolean {
      return captured.has(key);
    },
    apply(key: string, update: UpdateDraft, model: string | null): void {
      if (model === null) {
        restore(key);
        return;
      }
      update((current) => {
        const previous = captured.get(key);
        captured.set(key, { update, original: previous?.original ?? current, model });
        const settings = current.modelSettings as Draft | null;
        if (settings?.model === model && current.modelSettingsPersistAsDefault === false)
          return current;
        return {
          ...current,
          isManuallyChanged: true,
          modelSettingsPersistAsDefault: false,
          modelSettings: {
            ...settings,
            model,
            reasoningEffort: settings?.reasoningEffort ?? null,
            profile: settings?.profile ?? null,
          },
        };
      });
    },
    dispose(): void {
      for (const key of captured.keys()) restore(key);
    },
  };
}
