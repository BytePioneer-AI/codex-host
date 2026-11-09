import { committedReactAncestors } from "./renderer-react-ownership.js";

type Draft = Record<string, unknown>;
type UpdateDraft = (update: (current: Draft) => Draft) => void;
interface DraftElement {
  parentElement: DraftElement | null;
  querySelector?(selector: string): DraftElement | null;
}
interface ScopedDraftModelBinding {
  update: UpdateDraft;
  usesAccountPreferences: boolean;
  creationModes?: readonly Draft[];
}

/** Desktop 26.1021 memo tuples bind the client Thread identity, draft setter
 * and current Model settings mode. Never use the official default Model setter.
 */
export function findScopedDraftModelBinding(
  composer: DraftElement,
  draftId: string,
): ScopedDraftModelBinding | null {
  let element: DraftElement | null =
    composer.querySelector?.('[data-codex-composer], [contenteditable="true"][role="textbox"]') ??
    composer;
  let fiber: unknown;
  while (element && !fiber) {
    const key = Object.getOwnPropertyNames(element).find((name) =>
      name.startsWith("__reactFiber$"),
    );
    if (key) fiber = Object.getOwnPropertyDescriptor(element, key)?.value;
    element = element.parentElement;
  }
  const rows: unknown[][] = [];
  const groups = new Map<unknown[], unknown[][]>();
  const updates = new Set<UpdateDraft>();
  for (const ancestor of committedReactAncestors(fiber)) {
    const queue = ancestor.updateQueue as { memoCache?: { data?: unknown[] } } | null;
    const data = (queue?.memoCache?.data ?? []).filter(Array.isArray);
    for (const row of data) {
      rows.push(row);
      groups.set(row, data);
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
        updates.add(row[9] as UpdateDraft);
    }
  }
  let update: UpdateDraft | undefined;
  const modes = new Set<boolean>();
  const creationModes = new Set<Draft>();
  // The 26.1021 Model hook pairs its current settings mode with this exact
  // draft setter. A stored draft's mode can belong to an earlier Account.
  for (const row of rows) {
    if (
      row.length !== 24 ||
      row[7] !== null ||
      row[10] !== true ||
      !updates.has(row[13] as UpdateDraft)
    )
      continue;
    const context = row[12] as Draft | null;
    const result = row[23] as Draft | null;
    if (
      context &&
      context === row[21] &&
      typeof context.usesAccountPreferences === "boolean" &&
      result?.usesAccountPreferences === context.usesAccountPreferences &&
      typeof row[14] === "function" &&
      row[14] === row[20] &&
      result.setModelAndReasoningEffort === row[14]
    ) {
      // Each native hook can create its own setter for the same draft atom.
      // Bind through its reviewed draft identity and Model context, not through
      // function identity shared by every hook in the Composer.
      update ??= row[13] as UpdateDraft;
      modes.add(context.usesAccountPreferences);
      // Background creation receives a new client Thread id. The reviewed
      // collaboration-mode memo retains the originating draft's Model hook.
      const settings = result.modelSettings as Draft | null;
      const group = groups.get(row);
      const candidate = group?.[group.indexOf(row) - 1];
      const mode = candidate?.[44] as Draft | null;
      const value = candidate?.[51] as Draft | null;
      if (
        candidate?.length === 52 &&
        settings &&
        candidate[39] === settings.model &&
        candidate[40] === settings.reasoningEffort &&
        mode &&
        mode === candidate[49] &&
        mode.settings === candidate[41] &&
        (mode.settings as Draft | null)?.model === settings.model &&
        value?.activeMode === mode
      )
        creationModes.add(mode);
    }
  }
  const [usesAccountPreferences] = modes;
  return update && modes.size === 1 && usesAccountPreferences !== undefined
    ? {
        update,
        usesAccountPreferences,
        ...(creationModes.size ? { creationModes: [...creationModes] } : {}),
      }
    : null;
}

export function createScopedDraftModelWriter() {
  /** Only carriers the native setter accepted; `original` is the draft before the first one. */
  const captured = new Map<string, { update: UpdateDraft; original?: Draft; model: string }>();
  const restore = (key: string): void => {
    const entry = captured.get(key);
    if (!entry) return;
    entry.update((current) => {
      // Earlier queued writes capture the native settings before this updater runs.
      const { original } = entry;
      if (!original) return current;
      const settings = current.modelSettings as Draft | null;
      return settings?.model === entry.model && current.modelSettingsPersistAsDefault === false
        ? {
            ...current,
            modelSettings: original.modelSettings,
            modelSettingsPersistAsDefault: original.modelSettingsPersistAsDefault,
            isManuallyChanged: original.isManuallyChanged,
          }
        : current;
    });
    captured.delete(key);
  };
  return {
    has(key: string): boolean {
      return captured.has(key);
    },
    /** The carrier last written to this draft, or null while it keeps its native setting. */
    model(key: string): string | null {
      return captured.get(key)?.model ?? null;
    },
    apply(key: string, binding: ScopedDraftModelBinding, model: string | null): void {
      if (model === null) {
        restore(key);
        return;
      }
      const { update, usesAccountPreferences } = binding;
      const previous = captured.get(key);
      const entry: { update: UpdateDraft; original?: Draft; model: string } = { update, model };
      update((current) => {
        // Earlier queued writes may capture the native settings after apply() returns.
        entry.original ??= previous?.original ?? current;
        const settings = current.modelSettings as Draft | null;
        if (
          settings?.model === model &&
          settings.usesAccountPreferences === usesAccountPreferences &&
          current.modelSettingsPersistAsDefault === false
        )
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
            usesAccountPreferences,
          },
        };
      });
      // A setter can evaluate the updater and still reject the commit; record the carrier only
      // after it returns, so a later rollback names what the draft actually holds.
      captured.set(key, entry);
    },
    dispose(): void {
      for (const key of captured.keys()) restore(key);
    },
  };
}
