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

function record(value: unknown): Draft | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Draft)
    : null;
}

function draftIdentity(row: readonly unknown[], draftId: string) {
  const result = record(row[13]);
  return row.length === 14 &&
    row[6] === draftId &&
    row[7] === draftId &&
    result?.isNewThreadDraft === true &&
    row[11] === true &&
    !!record(row[10]) &&
    result.draftSettings === row[10] &&
    result.updateDraftSettings === row[9] &&
    row[9] === row[12] &&
    typeof row[9] === "function"
    ? { update: row[9] as UpdateDraft, store: row[8], draft: row[10] }
    : null;
}

/** Reviewed memo layouts; the callback and setting identities, not row length, authorize writes. */
function modelContext(row: readonly unknown[]) {
  const offset = row.length === 25 ? 1 : 0;
  const current = row.length === 37;
  if (!current && row.length !== 24 && row.length !== 25) return null;
  const context = record(row[current ? 34 : 12 + offset]);
  const result = record(row[current ? 36 : 23 + offset]);
  const callback = row[current ? 27 : 14 + offset];
  const usesAccountPreferences = context?.usesAccountPreferences;
  if (
    row[current ? 16 : 7 + offset] !== null ||
    row[current ? 21 : 10 + offset] !== true ||
    typeof usesAccountPreferences !== "boolean" ||
    result?.usesAccountPreferences !== usesAccountPreferences ||
    typeof callback !== "function" ||
    result.setModelAndReasoningEffort !== callback ||
    row[current ? 33 : 20 + offset] !== callback ||
    (current
      ? row[25] !== usesAccountPreferences || row[32] !== result.modelSettings || !record(row[32])
      : row[21 + offset] !== context)
  )
    return null;
  return { update: row[current ? 24 : 13 + offset], usesAccountPreferences, result };
}

function creationModeFor(
  row: unknown,
  model: Draft,
  owner: unknown,
  draftId: string,
): Draft | null {
  if (!Array.isArray(row) || (row.length !== 52 && row.length !== 55)) return null;
  const current = row.length === 55;
  const settings = record(row[current ? 44 : 41]);
  const mode = record(row[current ? 47 : 44]);
  const result = record(row[current ? 54 : 51]);
  const modelSettings = record(model.modelSettings);
  // Desktop 26.1117's Composer memoizes the actual submit mode and client Thread ID.
  if (
    current &&
    (!Array.isArray(owner) || owner.length !== 263 || owner[82] !== mode || owner[85] !== draftId)
  )
    return null;
  return mode &&
    settings &&
    modelSettings &&
    typeof mode.mode === "string" &&
    typeof modelSettings.model === "string" &&
    row[current ? 42 : 39] === modelSettings.model &&
    row[current ? 43 : 40] === modelSettings.reasoningEffort &&
    settings.model === modelSettings.model &&
    settings.reasoning_effort === modelSettings.reasoningEffort &&
    mode.settings === settings &&
    (!current || row[46] === settings) &&
    mode === row[current ? 52 : 49] &&
    result?.activeMode === mode
    ? mode
    : null;
}

export function findScopedDraftModelBinding(
  composer: DraftElement,
  draftId: string,
): ScopedDraftModelBinding | null {
  if (!draftId.startsWith("client-new-thread:")) return null;
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
  type Candidate = NonNullable<ReturnType<typeof draftIdentity>> & {
    usesAccountPreferences: boolean;
    modes: Set<Draft>;
  };
  const candidates = new Map<UpdateDraft, Candidate>();
  for (const ancestor of committedReactAncestors(fiber)) {
    const data = record(record(ancestor.updateQueue)?.memoCache)?.data;
    if (!Array.isArray(data)) continue;
    // Nested compiled hooks allocate their memo rows on the same Fiber.
    const identities = data.filter(Array.isArray).map((row) => draftIdentity(row, draftId));
    for (const [index, row] of data.entries()) {
      const model = Array.isArray(row) ? modelContext(row) : null;
      if (!model) continue;
      for (const identity of identities) {
        if (!identity || identity.update !== model.update) continue;
        const candidate = candidates.get(identity.update) ?? {
          ...identity,
          usesAccountPreferences: model.usesAccountPreferences,
          modes: new Set<Draft>(),
        };
        if (
          candidate.store !== identity.store ||
          candidate.draft !== identity.draft ||
          candidate.usesAccountPreferences !== model.usesAccountPreferences
        )
          return null;
        // The owning collaboration hook allocates its row before its nested Model hook.
        const mode = creationModeFor(data[index - 1], model.result, data[0], draftId);
        if (mode) candidate.modes.add(mode);
        candidates.set(identity.update, candidate);
      }
    }
  }
  const writers = [...candidates.values()];
  const creationOwners = writers.filter(({ modes }) => modes.size > 0);
  const selected =
    writers.length === 1 ? writers[0] : creationOwners.length === 1 ? creationOwners[0] : undefined;
  if (
    !selected ||
    (writers.length > 1 &&
      (!record(selected.store) ||
        typeof record(selected.store)?.set !== "function" ||
        writers.some(
          (writer) =>
            writer.store !== selected.store ||
            writer.draft !== selected.draft ||
            writer.usesAccountPreferences !== selected.usesAccountPreferences,
        )))
  )
    return null;

  const [mode] = selected.modes;
  if (selected.modes.size > 1 || (mode && !Object.isExtensible(mode))) return null;
  const { update, usesAccountPreferences } = selected;
  return { update, usesAccountPreferences, ...(mode ? { creationModes: [mode] } : {}) };
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
