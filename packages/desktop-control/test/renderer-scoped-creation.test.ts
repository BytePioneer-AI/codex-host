import { describe, expect, it, vi } from "vitest";
import { isolateRendererPrewarmConsumption } from "../src/renderer-prewarm-consumption.js";
import {
  createScopedDraftModelWriter,
  findScopedDraftModelBinding,
} from "../src/renderer-scoped-draft-model.js";

const mode = (model: string) => ({ collaborationMode: { settings: { model } } });
const warmed = (id: string, model: string) => ({ response: { thread: { id }, model } });
function fixture() {
  const consume = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  const deleted = vi.fn();
  const discarded = vi.fn();
  const pool = {
    hasPrewarmedThread: vi.fn(() => true),
    consumePrewarmedThread: consume,
    deletePrewarmedThread: deleted,
  };
  const creation = {
    params: { prewarmedThreadManager: pool },
    async createConversation(_input: unknown, ready: Promise<void> = Promise.resolve()) {
      await ready;
      if (!this.params.prewarmedThreadManager.hasPrewarmedThread()) return null;
      return this.params.prewarmedThreadManager.consumePrewarmedThread("/same-cwd");
    },
  };
  const restore = isolateRendererPrewarmConsumption(
    { threadCreation: creation, startConversation: vi.fn() },
    discarded,
  );
  return { creation, pool, consume, discarded, deleted, restore };
}

describe("native prewarm consumption isolation", () => {
  it("keeps native pool ownership and allows matching external prewarms", async () => {
    const f = fixture();
    f.consume.mockResolvedValue(warmed("pi-draft", "codexhost/pi-native"));
    await expect(f.creation.createConversation(mode("codexhost/pi-native"))).resolves.toEqual(
      warmed("pi-draft", "codexhost/pi-native"),
    );
    expect(f.pool.hasPrewarmedThread).toHaveBeenCalledOnce();
    expect(f.pool.hasPrewarmedThread.mock.contexts[0]).toBe(f.pool);
    expect(f.consume.mock.contexts[0]).toBe(f.pool);
    expect(f.discarded).not.toHaveBeenCalled();
    expect(f.deleted).not.toHaveBeenCalled();
  });
  it("does not let the official entry consume an external draft at the same cwd", async () => {
    const f = fixture();
    f.consume.mockResolvedValue(warmed("pi-draft", "codexhost/pi-native"));
    await expect(f.creation.createConversation(mode("gpt-5"))).resolves.toBeNull();
    expect(f.discarded).toHaveBeenCalledExactlyOnceWith("pi-draft");
    expect(f.deleted).not.toHaveBeenCalled();
  });
  it("keeps concurrent invocation ownership across asynchronous native preparation", async () => {
    const f = fixture();
    const first = Promise.withResolvers<undefined>();
    const official = f.creation.createConversation(mode("gpt-5"), first.promise);
    f.consume.mockResolvedValueOnce(warmed("pi", "codexhost/pi-native"));
    await expect(f.creation.createConversation(mode("codexhost/pi-native"))).resolves.toEqual(
      warmed("pi", "codexhost/pi-native"),
    );
    f.consume.mockResolvedValueOnce(warmed("other-pi", "codexhost/pi-native"));
    first.resolve(undefined);
    await expect(official).resolves.toBeNull();
    expect(f.discarded).toHaveBeenCalledExactlyOnceWith("other-pi");
  });
  it("rejects wrong external configuration and official prewarm for an external creation", async () => {
    const f = fixture();
    f.consume
      .mockResolvedValueOnce(warmed("native", "gpt-5"))
      .mockResolvedValueOnce(warmed("pi", "codexhost/pi-native"));
    await expect(
      f.creation.createConversation(mode("codexhost/claude-code-native")),
    ).resolves.toBeNull();
    await expect(
      f.creation.createConversation(mode("codexhost/claude-code-native")),
    ).resolves.toBeNull();
    expect(f.deleted).toHaveBeenCalledWith("native");
    expect(f.discarded).toHaveBeenCalledWith("pi");
  });
  it("preserves official consumption and restores only its own hook", async () => {
    const f = fixture();
    f.consume.mockResolvedValue(warmed("official", "gpt-5"));
    await expect(f.creation.createConversation(mode("gpt-5"))).resolves.toEqual(
      warmed("official", "gpt-5"),
    );
    f.restore?.dispose();
    expect(f.creation.params.prewarmedThreadManager.consumePrewarmedThread).toBe(f.consume);
    expect(isolateRendererPrewarmConsumption({}, vi.fn())).toBeNull();
  });
  it.each(["throw", "reject"])(
    "rejects an incompatible prewarm even when its cleanup fails by %s",
    async (failure) => {
      const f = fixture();
      f.consume.mockResolvedValue(warmed("official", "gpt-5"));
      f.deleted.mockImplementation(() => {
        if (failure === "throw") throw new Error("Cleanup unavailable");
        return Promise.reject(new Error("Cleanup unavailable"));
      });
      await expect(f.creation.createConversation(mode("codexhost/pi-native"))).resolves.toBeNull();
      expect(f.deleted).toHaveBeenCalledExactlyOnceWith("official");
    },
  );
});

it("binds the reviewed draft setter tuple to its exact client identity", () => {
  const update = vi.fn();
  const draft = { modelSettings: null, isManuallyChanged: false };
  const row = Array<unknown>(14).fill(null);
  Object.assign(row, {
    6: "client-new-thread:a",
    7: "client-new-thread:a",
    9: update,
    10: draft,
    11: true,
    12: update,
    13: { draftSettings: draft, isNewThreadDraft: true, updateDraftSettings: update },
  });
  const context = { usesAccountPreferences: true };
  const setModel = vi.fn();
  const modelRow = Array<unknown>(24).fill(null);
  Object.assign(modelRow, {
    7: null,
    10: true,
    12: context,
    13: update,
    14: setModel,
    20: setModel,
    21: context,
    23: { ...context, setModelAndReasoningEffort: setModel },
  });
  const data = [row, modelRow];
  const element = {
    parentElement: null,
    __reactFiber$test: { updateQueue: { memoCache: { data } } },
  };
  expect(findScopedDraftModelBinding(element, "client-new-thread:a")).toEqual({
    update,
    usesAccountPreferences: true,
  });
  data.push([...row], [...modelRow]);
  expect(findScopedDraftModelBinding(element, "client-new-thread:a")?.update).toBe(update);
  data.pop();
  data.pop();
  const otherUpdate = vi.fn();
  const otherDraftRow = Object.assign([...row], {
    9: otherUpdate,
    12: otherUpdate,
    13: { draftSettings: draft, isNewThreadDraft: true, updateDraftSettings: otherUpdate },
  });
  data.push(otherDraftRow, Object.assign([...modelRow], { 13: otherUpdate }));
  expect(findScopedDraftModelBinding(element, "client-new-thread:a")).toBeNull();
  data.pop();
  data.pop();
  const root = { parentElement: null, querySelector: () => element, __reactFiber$root: {} };
  expect(findScopedDraftModelBinding(root, "client-new-thread:a")).toMatchObject({
    usesAccountPreferences: true,
  });
  modelRow[13] = vi.fn();
  expect(findScopedDraftModelBinding(element, "client-new-thread:a")).toBeNull();
  modelRow[13] = update;
  const conflicting = { usesAccountPreferences: false };
  data.push(
    Object.assign([...modelRow], {
      12: conflicting,
      21: conflicting,
      23: { ...conflicting, setModelAndReasoningEffort: setModel },
    }),
  );
  expect(findScopedDraftModelBinding(element, "client-new-thread:a")).toBeNull();
  data.pop();
  expect(findScopedDraftModelBinding(element, "client-new-thread:b")).toBeNull();
  row[12] = vi.fn();
  expect(findScopedDraftModelBinding(element, "client-new-thread:a")).toBeNull();
});
it("binds the Desktop 26.1106 model tuple without changing another draft or native defaults", () => {
  const original = { modelSettings: { model: "native" }, isManuallyChanged: false };
  let draft: Record<string, unknown> = original;
  const update = vi.fn((apply: (value: typeof draft) => typeof draft) => {
    draft = apply(draft);
  });
  const identity = Array<unknown>(14).fill(null);
  Object.assign(identity, {
    6: "client-new-thread:mac",
    7: "client-new-thread:mac",
    9: update,
    10: original,
    11: true,
    12: update,
    13: { draftSettings: original, isNewThreadDraft: true, updateDraftSettings: update },
  });
  const context = { usesAccountPreferences: false };
  const setModel = vi.fn();
  const model = Array<unknown>(25).fill(null);
  Object.assign(model, {
    11: true,
    13: context,
    14: update,
    15: setModel,
    21: setModel,
    22: context,
    24: { ...context, setModelAndReasoningEffort: setModel },
  });
  const element = {
    parentElement: null,
    __reactFiber$test: {
      updateQueue: { memoCache: { data: [identity, model] } },
      return: null,
    },
  };
  const binding = findScopedDraftModelBinding(element, "client-new-thread:mac");
  expect(binding).toMatchObject({ update, usesAccountPreferences: false });
  if (!binding) throw new Error("Missing current Desktop draft binding");
  const writer = createScopedDraftModelWriter();
  writer.apply("client-new-thread:mac", binding, "codexhost/claude-code-native");
  expect(draft.modelSettings).toMatchObject({ model: "codexhost/claude-code-native" });
  expect(draft.modelSettingsPersistAsDefault).toBe(false);
  expect(setModel).not.toHaveBeenCalled();
  writer.apply("client-new-thread:mac", binding, null);
  expect(draft.modelSettings).toBe(original.modelSettings);
  expect(findScopedDraftModelBinding(element, "client-new-thread:other")).toBeNull();
  model[14] = vi.fn();
  expect(findScopedDraftModelBinding(element, "client-new-thread:mac")).toBeNull();
  model[14] = update;
  model[21] = vi.fn();
  expect(findScopedDraftModelBinding(element, "client-new-thread:mac")).toBeNull();
});

it.each([52, 55])("uses a verified %i-slot mode to select the owning draft writer", (width) => {
  const draftId = "client-new-thread:current";
  const store = { get() {}, set() {} };
  const original = { modelSettings: { model: "native", reasoningEffort: "high" } };
  let draft = original as Record<string, unknown>;
  const update = (apply: (value: typeof draft) => typeof draft) => {
    draft = apply(draft);
  };
  const otherUpdate = () => {
    throw new Error("not the creation writer");
  };
  const modelCallback = () => {
    throw new Error("not a draft-only setter");
  };
  const settings = { model: "native", reasoning_effort: "high" };
  const activeMode = { mode: "default", settings };
  const tuple = (length: number, slots: Record<number, unknown>) =>
    Object.assign(Array<unknown>(length).fill(Symbol.for("react.memo_cache_sentinel")), slots);
  const context = { usesAccountPreferences: false, modelSettings: original.modelSettings };
  const projected = { ...original.modelSettings, profile: null, isLoading: false };
  const result = {
    ...context,
    modelSettings: projected,
    setModelAndReasoningEffort: modelCallback,
  };
  const identity = (setter: typeof update) =>
    tuple(14, {
      6: draftId,
      7: draftId,
      8: store,
      9: setter,
      10: original,
      11: true,
      12: setter,
      13: { draftSettings: original, isNewThreadDraft: true, updateDraftSettings: setter },
    });
  const model = (setter: typeof update) =>
    width === 55
      ? tuple(37, {
          16: null,
          21: true,
          24: setter,
          25: false,
          27: modelCallback,
          32: projected,
          33: modelCallback,
          34: context,
          36: result,
        })
      : tuple(24, {
          7: null,
          10: true,
          12: context,
          13: setter,
          14: modelCallback,
          20: modelCallback,
          21: context,
          23: result,
        });
  const creation =
    width === 55
      ? tuple(55, {
          42: "native",
          43: "high",
          44: settings,
          46: settings,
          47: activeMode,
          52: activeMode,
          54: { activeMode },
        })
      : tuple(52, {
          39: "native",
          40: "high",
          41: settings,
          44: activeMode,
          49: activeMode,
          51: { activeMode },
        });
  const data = [creation, model(update), identity(update)];
  if (width === 55) data.unshift(tuple(263, { 82: activeMode, 85: draftId }));
  const creationOwner = { updateQueue: { memoCache: { data } } };
  const element = {
    parentElement: null,
    __reactFiber$fixture: {
      updateQueue: { memoCache: { data: [model(otherUpdate), identity(otherUpdate)] } },
      return: creationOwner,
    },
  };
  const binding = findScopedDraftModelBinding(element, draftId);
  expect(binding?.creationModes).toEqual([activeMode]);
  if (!binding) throw new Error("Missing verified creation writer");
  const writer = createScopedDraftModelWriter();
  writer.apply(draftId, binding, "codexhost/pi-native");
  expect(draft.modelSettings).toMatchObject({ model: "codexhost/pi-native" });
  expect(draft.modelSettingsPersistAsDefault).toBe(false);
  writer.apply(draftId, binding, null);
  expect(draft.modelSettings).toBe(original.modelSettings);
  const size = data.length;
  data.push(creation, model(otherUpdate), identity(otherUpdate));
  expect(findScopedDraftModelBinding(element, draftId)).toBeNull();
  data.splice(size);
  if (width === 55) {
    const unrelated = { ...activeMode };
    data[1] = Object.assign([...creation], {
      47: unrelated,
      52: unrelated,
      54: { activeMode: unrelated },
    });
    expect(findScopedDraftModelBinding(element, draftId)).toBeNull();
    data[1] = creation;
  }
  Object.freeze(activeMode);
  expect(findScopedDraftModelBinding(element, draftId)).toBeNull();
});

it("keeps drafts independent and restores native settings without default persistence", () => {
  const writer = createScopedDraftModelWriter();
  const original = {
    modelSettings: { model: "gpt-5", profile: "work", reasoningEffort: "high" },
    isManuallyChanged: false,
  };
  let a: Record<string, unknown> = original;
  let b: Record<string, unknown> = original;
  const setA = (f: (value: typeof a) => typeof a) => {
    a = f(a);
  };
  const setB = (f: (value: typeof b) => typeof b) => {
    b = f(b);
  };
  writer.apply("a", { update: setA, usesAccountPreferences: false }, "codexhost/pi-native");
  expect(a.modelSettingsPersistAsDefault).toBe(false);
  expect(b).toBe(original);
  writer.apply("b", { update: setB, usesAccountPreferences: true }, "codexhost/claude-code-native");
  writer.apply("a", { update: setA, usesAccountPreferences: false }, null);
  expect(a.modelSettings).toBe(original.modelSettings);
  expect((b.modelSettings as { model: string }).model).toBe("codexhost/claude-code-native");
  writer.dispose();
  expect(b.modelSettings).toBe(original.modelSettings);
});

it.each(["restore", "dispose"])(
  "restores native settings when %s precedes queued draft updaters",
  (operation) => {
    const writer = createScopedDraftModelWriter();
    const original = { modelSettings: { model: "native-model" }, isManuallyChanged: false };
    let draft: Record<string, unknown> = original;
    const queued: ((current: typeof draft) => typeof draft)[] = [];
    const binding = {
      usesAccountPreferences: false,
      update: (updater: (current: typeof draft) => typeof draft) => {
        queued.push(updater);
      },
    };
    writer.apply("draft", binding, "codexhost/pi-native");
    writer.apply("draft", binding, "codexhost/claude-code-native");
    if (operation === "restore") writer.apply("draft", binding, null);
    else writer.dispose();
    for (const updater of queued) draft = updater(draft);
    expect(draft).toEqual(original);
    expect(writer.has("draft")).toBe(false);
    expect(writer.model("draft")).toBeNull();
  },
);

it("keeps the original native settings across queued external selections", () => {
  const writer = createScopedDraftModelWriter();
  const original = { modelSettings: { model: "native-model" }, isManuallyChanged: false };
  let draft: Record<string, unknown> = original;
  const queued: ((current: typeof draft) => typeof draft)[] = [];
  const binding = {
    usesAccountPreferences: false,
    update: (updater: (current: typeof draft) => typeof draft) => {
      queued.push(updater);
    },
  };
  writer.apply("draft", binding, "codexhost/pi-native");
  writer.apply("draft", binding, "codexhost/claude-code-native");
  for (const updater of queued.splice(0)) draft = updater(draft);
  expect(draft.modelSettings).toMatchObject({ model: "codexhost/claude-code-native" });
  writer.apply("draft", binding, null);
  for (const updater of queued) draft = updater(draft);
  expect(draft).toEqual(original);
  expect(writer.has("draft")).toBe(false);
});

it.each([false, true])(
  "updates the native settings mode even when the transport Model is unchanged (%s)",
  (usesAccountPreferences) => {
    const writer = createScopedDraftModelWriter();
    const original = { modelSettings: null, isManuallyChanged: false };
    let draft: Record<string, unknown> = original;
    const update = (f: (current: typeof draft) => typeof draft) => {
      draft = f(draft);
    };
    writer.apply(
      "draft",
      { update, usesAccountPreferences: !usesAccountPreferences },
      "codexhost/pi-native",
    );
    writer.apply("draft", { update, usesAccountPreferences }, "codexhost/pi-native");
    expect(draft.modelSettings).toMatchObject({
      model: "codexhost/pi-native",
      usesAccountPreferences,
    });
    writer.dispose();
    expect(draft.modelSettings).toBeNull();
  },
);
