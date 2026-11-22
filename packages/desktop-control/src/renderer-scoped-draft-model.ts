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

type DraftIdentity = { draftId: string; update: UpdateDraft; draft: Draft };
type ModelContext = {
  row: readonly unknown[];
  usesAccountPreferences: boolean;
  settings: Draft | null;
};
type Writer = DraftIdentity & Pick<ScopedDraftModelBinding, "usesAccountPreferences">;
type Mode = Draft & { settings: Draft & { model: string } };

function isDraftId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("client-new-thread:");
}

function repeated(row: readonly unknown[], value: unknown): boolean {
  return row.indexOf(value) !== row.lastIndexOf(value);
}

function draftIdentities(row: readonly unknown[]): DraftIdentity[] {
  const ids = row.filter(isDraftId);
  const [draftId] = ids;
  if (!draftId || ids.length < 2 || ids.some((id) => id !== draftId)) return [];
  return [...new Set(row)].flatMap((value) => {
    const result = record(value);
    const draft = record(result?.draftSettings);
    const update = result?.updateDraftSettings;
    return result?.isNewThreadDraft === true &&
      draft &&
      row.includes(draft) &&
      typeof update === "function" &&
      repeated(row, update)
      ? [{ draftId, draft, update: update as UpdateDraft }]
      : [];
  });
}

function modelContexts(row: readonly unknown[]): ModelContext[] {
  return [...new Set(row)].flatMap((value) => {
    const result = record(value);
    const callback = result?.setModelAndReasoningEffort;
    const usesAccountPreferences = result?.usesAccountPreferences;
    if (
      typeof callback !== "function" ||
      !repeated(row, callback) ||
      typeof usesAccountPreferences !== "boolean" ||
      !row.some(
        (context) =>
          context !== value && record(context)?.usesAccountPreferences === usesAccountPreferences,
      )
    )
      return [];
    return [{ row, usesAccountPreferences, settings: record(result?.modelSettings) }];
  });
}

function collaborationMode(value: unknown): Mode | null {
  const mode = record(value);
  const settings = record(mode?.settings);
  return typeof mode?.mode === "string" && settings && typeof settings.model === "string"
    ? (mode as Mode)
    : null;
}

function activeModes(row: readonly unknown[]): Set<Mode> {
  const modes = new Set<Mode>();
  for (const value of row) {
    const mode = collaborationMode(record(value)?.activeMode);
    if (mode && row.includes(mode) && row.includes(mode.settings)) modes.add(mode);
  }
  return modes;
}

function submitModesFor(rows: readonly unknown[][], draftId: string): Set<Mode> {
  const modes = new Set<Mode>();
  for (const row of rows) {
    if (
      !row.includes(draftId) ||
      row.some((value) => isDraftId(value) && value !== draftId) ||
      !row.some((value) => {
        const result = record(value);
        return (
          typeof result?.handleSubmitLocal === "function" &&
          typeof result.handleNewWorktreeConversation === "function"
        );
      })
    )
      continue;
    for (const value of row) {
      const mode = collaborationMode(value);
      if (mode) modes.add(mode);
    }
  }
  return modes;
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
  const writers = new Map<UpdateDraft, Writer | null>();
  const submitModes = new Set<Mode>();
  const owners: Writer[] = [];
  for (const ancestor of committedReactAncestors(fiber)) {
    const data = record(record(ancestor.updateQueue)?.memoCache)?.data;
    if (!Array.isArray(data)) continue;
    const rows: unknown[][] = data.filter(Array.isArray);
    const identities = rows.map(draftIdentities);
    const allIdentities = identities.flat();
    const models = rows.map(modelContexts);
    for (const { row, usesAccountPreferences } of models.flat()) {
      for (const identity of allIdentities) {
        if (identity.draftId !== draftId || !row.includes(identity.update)) continue;
        const previous = writers.get(identity.update);
        const agrees =
          previous === undefined ||
          (previous?.draft === identity.draft &&
            previous.usesAccountPreferences === usesAccountPreferences);
        writers.set(identity.update, agrees ? { ...identity, usesAccountPreferences } : null);
      }
    }

    const localModes = submitModesFor(rows, draftId);
    for (const mode of localModes) submitModes.add(mode);
    if (localModes.size !== 1) continue;
    const [mode] = localModes;
    if (!mode) continue;

    const active = rows.map(activeModes);
    for (const [index, modes] of active.entries()) {
      if (modes.size !== 1 || !modes.has(mode)) continue;
      // Compiled hooks allocate the collaboration, Model and draft rows in nesting order.
      const end = rows.findIndex(
        (_, next) => next > index && (identities[next]?.length || active[next]?.size),
      );
      if (end === -1 || identities[end]?.length !== 1) continue;
      const [identity] = identities[end];
      if (identity?.draftId !== draftId) continue;
      const related = models.slice(index + 1, end).flat();
      const [model] = related;
      if (
        related.length !== 1 ||
        !model ||
        !model.row.includes(identity.update) ||
        allIdentities.some(
          ({ update }) => update !== identity.update && model.row.includes(update),
        ) ||
        model.settings?.model !== mode.settings.model ||
        model.settings.reasoningEffort !== mode.settings.reasoning_effort
      )
        continue;
      owners.push({ ...identity, usesAccountPreferences: model.usesAccountPreferences });
    }
  }
  const [mode] = submitModes;
  const selected = mode
    ? submitModes.size === 1 && owners.length === 1 && Object.isExtensible(mode)
      ? owners[0]
      : null
    : writers.size === 1
      ? writers.values().next().value
      : null;
  if (
    !selected ||
    [...writers.values()].some(
      (writer) =>
        writer?.draft !== selected.draft ||
        writer.usesAccountPreferences !== selected.usesAccountPreferences,
    )
  )
    return null;
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
