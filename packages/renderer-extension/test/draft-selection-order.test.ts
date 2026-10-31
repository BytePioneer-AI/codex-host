import { harnessModelRefSchema } from "@codexhost/shared-contracts";
import { afterEach, expect, it, vi } from "vitest";

import { installCurrentRendererAdapter } from "../src/versioned-renderer-adapter.js";

type Draft = Record<string, unknown> & { modelSettings: { model: string } };

function setup(hostId: string) {
  const draftId = "client-new-thread:selection-order";
  const original: Draft = { modelSettings: { model: "native-model" }, isManuallyChanged: false };
  let draft = original;
  let rejectNextWrite = false;
  let rejectAfterUpdater = 0;
  const selections = new Map<string, string>();
  const commits: { model: string; selected: string | null }[] = [];
  const row = Array<unknown>(14).fill(null);
  const updateDraft = (update: (current: Draft) => Draft): void => {
    if (rejectNextWrite) {
      rejectNextWrite = false;
      throw new Error("Draft setter is unavailable");
    }
    if (rejectAfterUpdater > 0) {
      // A setter that evaluates the updater and then refuses to commit it.
      rejectAfterUpdater -= 1;
      update(draft);
      throw new Error("Draft setter rejected the update");
    }
    draft = update(draft);
    row[10] = draft;
    (row[13] as { draftSettings: Draft }).draftSettings = draft;
    // An external-store write can synchronously render a replacement native mode.
    commits.push({ model: draft.modelSettings.model, selected: selections.get(draftId) ?? null });
  };
  Object.assign(row, {
    6: draftId,
    7: draftId,
    9: updateDraft,
    10: draft,
    11: true,
    12: updateDraft,
    13: { draftSettings: draft, isNewThreadDraft: true, updateDraftSettings: updateDraft },
  });
  const context = { usesAccountPreferences: false, modelSettings: original.modelSettings };
  const setModel = vi.fn();
  const modelRow = Object.assign(Array<unknown>(24).fill(null), {
    7: null,
    10: true,
    12: context,
    13: updateDraft,
    14: setModel,
    20: setModel,
    21: context,
    23: { ...context, setModelAndReasoningEffort: setModel },
  });
  const editor = {
    matches: () => true,
    querySelector: () => null,
    parentElement: null,
    __reactFiber$draft: {
      updateQueue: { memoCache: { data: [row, modelRow] } },
      return: null,
    },
  } as unknown as Element;
  const policy = {
    state: "ready" as const,
    hostId,
    scopedCreation: true,
    select: vi.fn((model: string | null, id?: string) => {
      if (id === undefined) {
        selections.clear();
        return true;
      }
      const changed = (selections.get(id) ?? null) !== model;
      if (model === null) selections.delete(id);
      else selections.set(id, model);
      return changed;
    }),
    clear: vi.fn(async () => {}),
  };
  const manager = { sendRequest: vi.fn(async () => null) };
  const route = { hostId, policy, manager };
  const events = new EventTarget();
  vi.stubGlobal("window", {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    setTimeout,
    clearTimeout,
    __codexhostHostRoutingV1: {
      forComposer: () => route,
      forHost: (id: string) => (id === hostId ? route : null),
      hostIdForComposer: () => hostId,
    },
  });
  vi.stubGlobal("document", {
    querySelector: () => editor,
    querySelectorAll: () => [editor],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    documentElement: {},
  });
  const adapter = installCurrentRendererAdapter();
  return {
    adapter,
    editor,
    policy,
    commits,
    selections,
    original,
    readDraft: () => draft,
    rejectNextWrite: () => {
      rejectNextWrite = true;
    },
    rejectAfterUpdater: (count: number) => {
      rejectAfterUpdater = count;
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

it.each(["local", "remote-ssh-discovered:linux"])(
  "publishes each %s draft selection before a synchronous model commit",
  (hostId) => {
    const f = setup(hostId);
    try {
      expect(f.adapter.applyAgent("pi", undefined, undefined, undefined, f.editor)).toBe(true);
      const first = f.readDraft().modelSettings.model;
      expect(first).toMatch(/^codexhost\//u);
      expect(f.commits.at(-1)).toEqual({ model: first, selected: first });

      const replacement = harnessModelRefSchema.parse({ id: "replacement-model" });
      expect(f.adapter.applyAgent("pi", replacement, undefined, undefined, f.editor)).toBe(true);
      const second = f.readDraft().modelSettings.model;
      expect(second).not.toBe(first);
      expect(f.commits.at(-1)).toEqual({ model: second, selected: second });

      expect(f.adapter.applyAgent("codex", undefined, undefined, undefined, f.editor)).toBe(true);
      expect(f.commits.at(-1)).toEqual({ model: "native-model", selected: null });
      expect(f.readDraft()).toMatchObject(f.original);
    } finally {
      f.adapter.dispose();
    }
  },
);

it("does not write the draft when its selection policy rejects the change", () => {
  const f = setup("local");
  try {
    f.policy.select.mockImplementationOnce(() => {
      throw new Error("Retired Host route");
    });
    expect(f.adapter.applyAgent("pi", undefined, undefined, undefined, f.editor)).toBe(false);
    expect(f.commits).toEqual([]);
    expect(f.readDraft()).toBe(f.original);
    expect(f.selections.size).toBe(0);
  } finally {
    f.adapter.dispose();
  }
});

it("restores the previous external selection if the setter rejects a change", () => {
  const f = setup("local");
  try {
    expect(f.adapter.applyAgent("pi", undefined, undefined, undefined, f.editor)).toBe(true);
    const first = f.readDraft().modelSettings.model;
    f.rejectNextWrite();
    const replacement = harnessModelRefSchema.parse({ id: "replacement-model" });
    expect(f.adapter.applyAgent("pi", replacement, undefined, undefined, f.editor)).toBe(false);
    // The draft still carries the first Agent, and so does its selection.
    expect(f.readDraft().modelSettings.model).toBe(first);
    expect(f.selections.get("client-new-thread:selection-order")).toBe(first);
  } finally {
    f.adapter.dispose();
  }
});

it("keeps the committed carrier when the setter evaluates the updater and then rejects", () => {
  const f = setup("local");
  try {
    expect(f.adapter.applyAgent("pi", undefined, undefined, undefined, f.editor)).toBe(true);
    const committed = f.readDraft().modelSettings.model;
    f.rejectAfterUpdater(2);
    const b = harnessModelRefSchema.parse({ id: "model-b" });
    const c = harnessModelRefSchema.parse({ id: "model-c" });
    expect(f.adapter.applyAgent("pi", b, undefined, undefined, f.editor)).toBe(false);
    expect(f.adapter.applyAgent("pi", c, undefined, undefined, f.editor)).toBe(false);
    // Neither rejected write may become the rollback target.
    expect(f.readDraft().modelSettings.model).toBe(committed);
    expect(f.selections.get("client-new-thread:selection-order")).toBe(committed);
    // Switching back to Codex restores the native draft.
    expect(f.adapter.applyAgent("codex", undefined, undefined, undefined, f.editor)).toBe(true);
    expect(f.readDraft()).toMatchObject(f.original);
  } finally {
    f.adapter.dispose();
  }
});

it("clears the new selection if the native draft setter rejects the write", () => {
  const f = setup("local");
  try {
    f.selections.set("client-new-thread:other", "codexhost/other");
    f.rejectNextWrite();
    expect(f.adapter.applyAgent("pi", undefined, undefined, undefined, f.editor)).toBe(false);
    expect(f.readDraft()).toBe(f.original);
    expect([...f.selections]).toEqual([["client-new-thread:other", "codexhost/other"]]);
  } finally {
    f.adapter.dispose();
  }
});
