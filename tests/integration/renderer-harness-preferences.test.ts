import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessPreferencesStore } from "@codexhost/harness-plugin-files";
import {
  harnessPreferencePatchSchema,
  harnessModelRefSchema,
  type HarnessPreferenceSnapshot,
} from "@codexhost/shared-contracts";
import type { RendererModelClient } from "../../packages/renderer-extension/src/renderer-model-client.js";
import {
  HARNESS_PREFERENCES_UPDATED_EVENT,
  installRendererHarnessPreferenceSync,
  rendererHarnessPreferences,
  rendererHarnessPreferenceStatus,
  writeRendererHarnessPreferences,
} from "../../packages/renderer-extension/src/renderer-harness-preferences.js";
import {
  IDLE_RELEASE_STORAGE_KEY,
  IDLE_RELEASE_STATUS_EVENT,
  installIdleReleasePreferenceSync,
  readIdleReleasePreference,
  writeIdleReleasePreference,
} from "../../packages/renderer-extension/src/renderer-idle-release-preference.js";
import {
  modelFavoritesPending,
  readModelFavorites,
  writeModelFavorites,
} from "../../packages/renderer-extension/src/renderer-model-favorites.js";
import {
  readNewThreadAgentPreference,
  rendererNewThreadPreferenceStorage,
  writeNewThreadAgentPreference,
  writeNewThreadExternalConfigurationPreference,
} from "../../packages/renderer-extension/src/renderer-new-thread-preference.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "renderer-preferences-"));
  const store = new HarnessPreferencesStore(directory);
  cleanup.push(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn(),
  };
  const owner = Object.assign(new EventTarget(), {
    localStorage: storage,
    setInterval,
    clearInterval,
  }) as unknown as Window;
  vi.stubGlobal("window", owner);
  const listeners = new Set<() => void>();
  const patch = vi.fn(async (input: Parameters<HarnessPreferencesStore["patch"]>[0]) => {
    const result = await store.patch(input);
    for (const listener of listeners) listener();
    return result;
  });
  const client = {
    getHarnessPreferences: () => store.get(),
    patchHarnessPreferences: patch,
    subscribeHarnessPreferences: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as RendererModelClient;
  const sync = installRendererHarnessPreferenceSync(owner);
  const idle = installIdleReleasePreferenceSync(owner);
  const statuses: string[] = [];
  owner.addEventListener(IDLE_RELEASE_STATUS_EVENT, (event) =>
    statuses.push((event as CustomEvent<string>).detail),
  );
  cleanup.push(() => {
    idle.dispose();
    sync.dispose();
  });
  return {
    store,
    values,
    storage,
    owner,
    client,
    sync,
    statuses,
    patch,
    notify: () => {
      for (const listener of listeners) listener();
    },
  };
}
const policy = { enabled: true, timeoutMinutes: 15 };

describe("confirmed shared Renderer preferences", () => {
  it("migrates legacy values without replacing existing file values or writing localStorage", async () => {
    const f = await fixture();
    await f.store.patch(
      harnessPreferencePatchSchema.parse({ operations: [{ kind: "idleRelease", value: policy }] }),
    );
    f.values.set(IDLE_RELEASE_STORAGE_KEY, JSON.stringify({ enabled: false, timeoutMinutes: 30 }));
    f.values.set("codexhost.model-favorites.v1:pi", JSON.stringify(["model-a"]));
    f.values.set(
      "codexhost.new-thread-preference.v1",
      JSON.stringify({
        version: 1,
        lastAgent: "pi",
        externalByAgent: { pi: { model: { id: "model-a" } } },
      }),
    );
    f.sync.connect("local", f.client);
    await vi.waitFor(() => expect(readModelFavorites("pi").has("model-a")).toBe(true));
    expect(readIdleReleasePreference(f.owner)).toEqual(policy);
    expect(readNewThreadAgentPreference()).toBe("pi");
    expect(f.patch.mock.calls.every(([input]) => input.initializeOnly)).toBe(true);
    expect(f.storage.setItem).not.toHaveBeenCalled();
  });
  it("saves confirmed policy and favorites, receives Web changes and keeps remote Host state isolated", async () => {
    const f = await fixture();
    f.sync.connect("local", f.client);
    await vi.waitFor(() => expect(rendererHarnessPreferenceStatus()).toBe("applied"));
    expect(writeIdleReleasePreference(f.owner, policy)).toBe(true);
    await vi.waitFor(() => expect(readIdleReleasePreference(f.owner)).toEqual(policy));
    for (const timeoutMinutes of [4, 1441, 30.5, NaN])
      expect(writeIdleReleasePreference(f.owner, { enabled: true, timeoutMinutes })).toBe(false);
    writeModelFavorites("pi", new Set(["gui-model"]));
    await vi.waitFor(() => expect(readModelFavorites("pi")).toEqual(new Set(["gui-model"])));
    await f.store.patch(
      harnessPreferencePatchSchema.parse({
        operations: [
          { kind: "favorite", harnessId: "pi", modelId: "web-model", enabled: true },
          {
            kind: "newThread",
            lastHarness: "pi",
            harnessId: "pi",
            configuration: { model: { id: "web-model" } },
          },
        ],
      }),
    );
    f.notify();
    await vi.waitFor(() => expect(readModelFavorites("pi").has("web-model")).toBe(true));
    const remoteSnapshot = {
      scope: "external",
      revision: 0,
      values: { favorites: {} },
    } satisfies HarnessPreferenceSnapshot;
    f.sync.connect("remote", {
      ...f.client,
      getHarnessPreferences: async () => remoteSnapshot,
      patchHarnessPreferences: async () => {
        throw new Error("Remote offline");
      },
    });
    await vi.waitFor(() => expect(rendererHarnessPreferences("remote")).toEqual(remoteSnapshot));
    writeNewThreadAgentPreference("grok", rendererNewThreadPreferenceStorage("remote"));
    await vi.waitFor(() => expect(rendererHarnessPreferenceStatus("remote")).toBe("failed"));
    expect(readNewThreadAgentPreference()).toBe("pi");
    writeNewThreadAgentPreference("grok");
    writeNewThreadExternalConfigurationPreference(
      "grok",
      harnessModelRefSchema.parse({ id: "grok-model" }),
    );
    await vi.waitFor(() =>
      expect(rendererHarnessPreferences()?.values.newThread?.byHarness.grok?.model?.id).toBe(
        "grok-model",
      ),
    );
    expect(readNewThreadAgentPreference()).toBe("grok");
    expect(f.storage.setItem).not.toHaveBeenCalled();
  });
  it("recovers after failures and reconnects without a stalled old write blocking or replacing new state", async () => {
    const f = await fixture();
    f.sync.connect("local", f.client);
    await vi.waitFor(() => expect(rendererHarnessPreferenceStatus()).toBe("applied"));
    f.patch.mockRejectedValueOnce(new Error("Disk full"));
    await expect(
      writeRendererHarnessPreferences(f.owner, "local", [{ kind: "idleRelease", value: policy }]),
    ).rejects.toThrow("Disk full");
    expect(rendererHarnessPreferenceStatus()).toBe("failed");
    expect(readIdleReleasePreference(f.owner).enabled).toBe(false);
    f.notify();
    await vi.waitFor(() => expect(f.statuses.at(-1)).toBe("applied"));
    const stalled = Promise.withResolvers<HarnessPreferenceSnapshot>();
    f.patch.mockImplementationOnce(() => stalled.promise);
    const old = writeRendererHarnessPreferences(f.owner, "local", [
      { kind: "idleRelease", value: policy },
    ]);
    await vi.waitFor(() => expect(f.patch).toHaveBeenCalledTimes(2));
    f.sync.connect("local", { ...f.client });
    await vi.waitFor(() => expect(rendererHarnessPreferenceStatus()).toBe("applied"));
    await writeRendererHarnessPreferences(f.owner, "local", [
      { kind: "idleRelease", value: { enabled: false, timeoutMinutes: 60 } },
    ]);
    stalled.resolve({
      scope: "external",
      revision: 999,
      values: { favorites: {}, idleRelease: policy },
    });
    await old;
    expect(readIdleReleasePreference(f.owner)).toEqual({ enabled: false, timeoutMinutes: 60 });
    expect(f.storage.setItem).not.toHaveBeenCalled();
  });
  it("disables persistence when the Host does not support preference RPCs", async () => {
    const f = await fixture();
    f.sync.connect("local", {
      ...f.client,
      getHarnessPreferences: async () => {
        throw new Error("Unsupported");
      },
    });
    await vi.waitFor(() => expect(f.statuses.at(-1)).toBe("unavailable"));
    expect(writeIdleReleasePreference(f.owner, policy)).toBe(false);
    expect(f.patch).not.toHaveBeenCalled();
  });
  it.each(["resolve", "reject"] as const)(
    "retires a stalled favorite lock on reconnect; old %s cannot release a new operation",
    async (completion) => {
      const f = await fixture();
      f.sync.connect("local", f.client);
      await vi.waitFor(() => expect(rendererHarnessPreferenceStatus()).toBe("applied"));
      const accepted = Promise.withResolvers<HarnessPreferenceSnapshot>();
      const oldReply = Promise.withResolvers<HarnessPreferenceSnapshot>();
      f.patch.mockImplementationOnce(async (input) => {
        accepted.resolve(await f.store.patch(input));
        return oldReply.promise;
      });
      const old = writeModelFavorites("pi", new Set(["model-a"])).catch((error) => error);
      const saved = await accepted.promise;
      expect(modelFavoritesPending("pi")).toBe(true);
      const nextReply = Promise.withResolvers<HarnessPreferenceSnapshot>();
      const nextAccepted = Promise.withResolvers<HarnessPreferenceSnapshot>();
      const nextPatch = vi.fn(async (input: Parameters<HarnessPreferencesStore["patch"]>[0]) => {
        nextAccepted.resolve(await f.store.patch(input));
        return nextReply.promise;
      });
      f.sync.connect("local", { ...f.client, patchHarnessPreferences: nextPatch });
      await vi.waitFor(() => expect(rendererHarnessPreferenceStatus()).toBe("applied"));
      expect(readModelFavorites("pi")).toEqual(new Set(["model-a"]));
      expect(modelFavoritesPending("pi")).toBe(false);
      const cancel = writeModelFavorites("pi", new Set());
      const removed = await nextAccepted.promise;
      expect(nextPatch).toHaveBeenCalledOnce();
      if (completion === "resolve") oldReply.resolve(saved);
      else oldReply.reject(new Error("Retired connection"));
      await old;
      expect(modelFavoritesPending("pi")).toBe(true);
      expect(rendererHarnessPreferenceStatus()).toBe("pending");
      nextReply.resolve(removed);
      await cancel;
      expect(modelFavoritesPending("pi")).toBe(false);
      expect(readModelFavorites("pi").size).toBe(0);
    },
  );
  it("keeps connect idempotent when a preference notification resolves the same route synchronously", async () => {
    const f = await fixture();
    const get = vi.fn(() => f.store.get());
    let current: RendererModelClient | null = { ...f.client, getHarnessPreferences: get };
    let notifications = 0;
    f.owner.addEventListener(HARNESS_PREFERENCES_UPDATED_EVENT, () => {
      notifications++;
      f.sync.connect("local", current);
    });
    f.sync.connect("local", current);
    await vi.waitFor(() => expect(rendererHarnessPreferenceStatus()).toBe("applied"));
    expect(get).toHaveBeenCalledOnce();
    expect(notifications).toBe(2);
    current = null;
    f.sync.connect("local", current);
    f.sync.connect("local", current);
    expect(rendererHarnessPreferenceStatus()).toBe("unavailable");
    expect(notifications).toBe(3);
  });
  it("does not poll while idle and reconciles on focus or becoming visible", async () => {
    const f = await fixture();
    const get = vi.fn(() => f.store.get());
    const interval = vi.fn(f.owner.setInterval);
    f.owner.setInterval = interval;
    const document = Object.assign(new EventTarget(), { visibilityState: "hidden" });
    Object.defineProperty(f.owner, "document", { value: document });
    f.sync.connect("local", { ...f.client, getHarnessPreferences: get });
    await vi.waitFor(() => expect(rendererHarnessPreferenceStatus()).toBe("applied"));
    expect(get).toHaveBeenCalledOnce();
    expect(interval).not.toHaveBeenCalled();
    await f.store.patch(
      harnessPreferencePatchSchema.parse({ operations: [{ kind: "idleRelease", value: policy }] }),
    );
    document.dispatchEvent(new Event("visibilitychange"));
    expect(get).toHaveBeenCalledOnce();
    f.owner.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(readIdleReleasePreference(f.owner)).toEqual(policy));
    expect(get).toHaveBeenCalledTimes(2);
    await f.store.patch(
      harnessPreferencePatchSchema.parse({
        operations: [{ kind: "idleRelease", value: { enabled: false, timeoutMinutes: 40 } }],
      }),
    );
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(readIdleReleasePreference(f.owner).timeoutMinutes).toBe(40));
    expect(get).toHaveBeenCalledTimes(3);
    f.sync.dispose();
    f.owner.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(get).toHaveBeenCalledTimes(3);
  });
});
