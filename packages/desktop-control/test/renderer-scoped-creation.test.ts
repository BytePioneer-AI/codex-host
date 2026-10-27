import { describe, expect, it, vi } from "vitest";
import { isolateRendererPrewarmConsumption } from "../src/renderer-prewarm-consumption.js";
import {
  createScopedDraftModelWriter,
  findScopedDraftUpdater,
} from "../src/renderer-scoped-draft-model.js";

const mode = (model: string) => ({ collaborationMode: { settings: { model } } });
const warmed = (id: string, model: string) => ({ response: { thread: { id }, model } });
function fixture() {
  const consume = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  const deleted = vi.fn();
  const discarded = vi.fn();
  const pool = {
    hasPrewarmedThread: () => true,
    consumePrewarmedThread: consume,
    deletePrewarmedThread: deleted,
  };
  const creation = {
    params: { prewarmedThreadManager: pool },
    async createConversation(_input: unknown, ready: Promise<void> = Promise.resolve()) {
      await ready;
      return this.params.prewarmedThreadManager.consumePrewarmedThread("/same-cwd");
    },
  };
  const restore = isolateRendererPrewarmConsumption({ threadCreation: creation }, discarded);
  return { creation, consume, discarded, deleted, restore };
}

describe("native prewarm consumption isolation", () => {
  it("creates a fresh empty scheduled chat without consuming a matching ordinary draft", async () => {
    const consume = vi.fn();
    const pool = {
      hasPrewarmedThread: () => true,
      consumePrewarmedThread: consume,
      deletePrewarmedThread: vi.fn(),
    };
    const creation = {
      params: { prewarmedThreadManager: pool },
      createConversation(input: unknown) {
        if (this.params.prewarmedThreadManager.hasPrewarmedThread())
          return this.params.prewarmedThreadManager.consumePrewarmedThread();
        return input;
      },
    };
    const manager = {
      threadCreation: creation,
      startConversation: vi.fn(async (input) => creation.createConversation(input)),
    };
    const control = isolateRendererPrewarmConsumption(manager, vi.fn());
    if (!control) throw new Error("Fixture binding unavailable");
    await expect(
      control.createScheduledConversation(
        { ...mode("codexhost/pi-native"), input: ["must not run"] },
        vi.fn(),
      ),
    ).resolves.toMatchObject({ input: [] });
    expect(consume).not.toHaveBeenCalled();
    creation.createConversation(mode("codexhost/pi-native"));
    expect(consume).toHaveBeenCalledOnce();
    control.dispose();
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
  const element = {
    parentElement: null,
    __reactFiber$test: { updateQueue: { memoCache: { data: [row] } } },
  };
  expect(findScopedDraftUpdater(element, "client-new-thread:a")).toBe(update);
  expect(findScopedDraftUpdater(element, "client-new-thread:b")).toBeNull();
  row[12] = vi.fn();
  expect(findScopedDraftUpdater(element, "client-new-thread:a")).toBeNull();
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
  writer.apply("a", setA, "codexhost/pi-native");
  expect(a.modelSettingsPersistAsDefault).toBe(false);
  expect(b).toBe(original);
  writer.apply("b", setB, "codexhost/claude-code-native");
  writer.apply("a", setA, null);
  expect(a.modelSettings).toBe(original.modelSettings);
  expect((b.modelSettings as { model: string }).model).toBe("codexhost/claude-code-native");
  writer.dispose();
  expect(b.modelSettings).toBe(original.modelSettings);
});
