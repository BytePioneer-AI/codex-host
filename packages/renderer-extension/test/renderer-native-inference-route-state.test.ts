import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRendererModelClient,
  type RendererModelClient,
} from "../src/renderer-model-client.js";
import {
  createRendererNativeDraftWorkspaceStore,
  createRendererNativeInferenceRoute,
  type RendererNativeDraftScope,
} from "../src/renderer-native-inference-route.js";
import { hostThreadIdSchema, type HostThreadId } from "@codexhost/shared-contracts";

function deferred() {
  let resolve!: (value: boolean) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<boolean>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const verify = vi.fn(async () => true);
  const client = { usesIndependentNativeInference: verify } as unknown as RendererModelClient;
  let eligible = true;
  let targetClient: RendererModelClient | null = client;
  let threadId: HostThreadId | null = hostThreadIdSchema.parse("native-thread");
  let draft: RendererNativeDraftScope | null = null;
  const values: boolean[] = [];
  const render = vi.fn(() => {
    values.push(route.update(targetClient, threadId, eligible, draft));
  });
  const route = createRendererNativeInferenceRoute(render);
  return {
    client,
    verify,
    render,
    route,
    values,
    setEligible(value: boolean) {
      eligible = value;
      render();
    },
    setClient(value: RendererModelClient | null) {
      targetClient = value;
      render();
    },
    setDraft(value: RendererNativeDraftScope | null) {
      draft = value;
      render();
    },
    setThread(value: string | null) {
      threadId = value === null ? null : hostThreadIdSchema.parse(value);
      render();
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Native inference route revalidation lifecycle", () => {
  it("does not pulse the gate closed during successful same-target refreshes", async () => {
    const f = fixture();
    f.render();
    expect(f.values).toEqual([false]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.values.at(-1)).toBe(true);
    const check = deferred();
    f.verify.mockReturnValueOnce(check.promise);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.verify).toHaveBeenCalledTimes(2);
    expect(f.values.at(-1)).toBe(true);
    f.render();
    expect(f.values.at(-1)).toBe(true);
    check.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(16000);
    expect(f.values.slice(1).every(Boolean)).toBe(true);
    f.route.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("automatically revokes the proof if idle config becomes official", async () => {
    const f = fixture();
    f.render();
    await vi.advanceTimersByTimeAsync(0);
    f.verify.mockResolvedValueOnce(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.values.at(-1)).toBe(false);
    expect(f.verify).toHaveBeenLastCalledWith({ threadId: "native-thread" });
    f.route.dispose();
  });

  it("fails closed on RPC errors without logging request data", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture();
    f.render();
    await vi.advanceTimersByTimeAsync(0);
    f.verify.mockRejectedValueOnce(new Error("private payload"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.values.at(-1)).toBe(false);
    expect(warn.mock.calls[0]?.[1]).toBe("Error");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private payload");
    f.route.dispose();
  });

  it("bounds pending revalidation and ignores its late result during the next check", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture();
    f.render();
    await vi.advanceTimersByTimeAsync(0);
    const late = deferred();
    const next = deferred();
    f.verify.mockReturnValueOnce(late.promise).mockReturnValueOnce(next.promise);
    await vi.advanceTimersByTimeAsync(9999);
    expect(f.values.at(-1)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.values.at(-1)).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    late.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    f.render();
    expect(f.values.at(-1)).toBe(false);
    next.resolve(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.values.at(-1)).toBe(false);
    f.route.dispose();
  });

  it("invalidates immediately on Host or Thread changes and ignores stale completion", async () => {
    const f = fixture();
    const old = deferred();
    f.verify.mockReturnValueOnce(old.promise).mockResolvedValue(false);
    f.render();
    f.setThread("official-thread");
    expect(f.values.at(-1)).toBe(false);
    old.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.values.at(-1)).toBe(false);
    const other = {
      usesIndependentNativeInference: vi.fn(async () => false),
    } as unknown as RendererModelClient;
    f.setClient(other);
    expect(f.values.at(-1)).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.values.at(-1)).toBe(false);
    f.route.dispose();
  });

  it("clears proof and timers while switching, unmounted or missing its client", async () => {
    const f = fixture();
    f.render();
    await vi.advanceTimersByTimeAsync(0);
    f.setEligible(false);
    expect(f.values.at(-1)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(15000);
    expect(f.verify).toHaveBeenCalledTimes(1);
    f.setEligible(true);
    expect(f.values.at(-1)).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    f.setClient(null);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.values.at(-1)).toBe(false);
    f.route.dispose();
  });

  it("does not retain a pending result or timer after disposal", async () => {
    const f = fixture();
    const pending = deferred();
    f.verify.mockReturnValueOnce(pending.promise);
    f.setThread(null);
    expect(f.verify).not.toHaveBeenCalled();
    f.setDraft({ draftId: "client-new-thread:1", cwd: "/work/draft" });
    expect(f.verify).toHaveBeenCalledExactlyOnceWith({ cwd: "/work/draft" });
    f.route.dispose();
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve(true);
    await vi.advanceTimersByTimeAsync(15000);
    expect(f.render).toHaveBeenCalledTimes(2);
    expect(
      f.route.update(f.client, null, true, { draftId: "client-new-thread:1", cwd: "/work/draft" }),
    ).toBe(false);
  });

  it("fails closed until draft identity and workspace are confirmed, revokes on draft change, and ignores draft for existing Threads", async () => {
    const f = fixture();
    f.setThread(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.values.at(-1)).toBe(false);
    expect(f.verify).not.toHaveBeenCalled();

    f.setDraft({ draftId: "client-new-thread:1", cwd: "/work/custom" });
    expect(f.values.at(-1)).toBe(false);
    expect(f.verify).toHaveBeenLastCalledWith({ cwd: "/work/custom" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.values.at(-1)).toBe(true);

    // Switching to another draft identity invalidates the previous proof even before config resolves.
    const nextCheck = deferred();
    f.verify.mockReturnValueOnce(nextCheck.promise);
    f.setDraft({ draftId: "client-new-thread:2", cwd: "/work/custom" });
    expect(f.values.at(-1)).toBe(false);
    nextCheck.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.values.at(-1)).toBe(true);

    // Losing the confirmed workspace immediately revokes the bypass without querying global config.
    const callsBeforeClear = f.verify.mock.calls.length;
    f.setDraft(null);
    expect(f.values.at(-1)).toBe(false);
    expect(f.verify).toHaveBeenCalledTimes(callsBeforeClear);

    // Existing Threads verify by threadId and ignore draft workspace changes.
    f.setThread("native-thread");
    expect(f.verify).toHaveBeenLastCalledWith({ threadId: "native-thread" });
    const calls = f.verify.mock.calls.length;
    await vi.advanceTimersByTimeAsync(0);
    f.setDraft({ draftId: "client-new-thread:3", cwd: "/work/other" });
    expect(f.verify).toHaveBeenCalledTimes(calls);
    f.route.dispose();
  });
});

describe("Confirmed draft workspace binding for native quota isolation", () => {
  it("binds only to the single mounted draft on that Host and invalidates on draft, Host, or multi-draft ambiguity", () => {
    const store = createRendererNativeDraftWorkspaceStore();
    const composerA = {};
    const composerB = {};

    // Publishing before any draft mounts must not carry over to a later draft.
    store.publish({ hostId: "local", cwd: "/work/stale-custom" }, []);
    expect(
      store.resolve({ composer: composerA, hostId: "local", draftId: "client-new-thread:a" }),
    ).toBeNull();

    // Unambiguous single mounted draft on that Host binds its workspace.
    store.publish({ hostId: "local", cwd: "/work/custom" }, [
      { composer: composerA, hostId: "local", draftId: "client-new-thread:a" },
    ]);
    expect(
      store.resolve({ composer: composerA, hostId: "local", draftId: "client-new-thread:a" }),
    ).toEqual({ draftId: "client-new-thread:a", cwd: "/work/custom" });

    // Switching draftId or hostId on the same Composer invalidates the stale binding.
    expect(
      store.resolve({ composer: composerA, hostId: "local", draftId: "client-new-thread:b" }),
    ).toBeNull();
    expect(
      store.resolve({ composer: composerA, hostId: "local", draftId: "client-new-thread:a" }),
    ).toBeNull();

    store.publish({ hostId: "local", cwd: "/work/custom" }, [
      { composer: composerA, hostId: "local", draftId: "client-new-thread:a" },
    ]);
    expect(
      store.resolve({ composer: composerA, hostId: "ssh-host", draftId: "client-new-thread:a" }),
    ).toBeNull();

    // Multiple drafts on the same Host make a Host-level event ambiguous and fail closed.
    store.publish({ hostId: "local", cwd: "/work/custom" }, [
      { composer: composerA, hostId: "local", draftId: "client-new-thread:a" },
    ]);
    store.publish({ hostId: "local", cwd: "/work/official" }, [
      { composer: composerA, hostId: "local", draftId: "client-new-thread:a" },
      { composer: composerB, hostId: "local", draftId: "client-new-thread:b" },
    ]);
    expect(
      store.resolve({ composer: composerA, hostId: "local", draftId: "client-new-thread:a" }),
    ).toBeNull();
    expect(
      store.resolve({ composer: composerB, hostId: "local", draftId: "client-new-thread:b" }),
    ).toBeNull();

    // Explicit draftId still binds the matching draft without affecting siblings.
    store.publish({ hostId: "local", cwd: "/work/custom", draftId: "client-new-thread:a" }, [
      { composer: composerA, hostId: "local", draftId: "client-new-thread:a" },
      { composer: composerB, hostId: "local", draftId: "client-new-thread:b" },
    ]);
    expect(
      store.resolve({ composer: composerA, hostId: "local", draftId: "client-new-thread:a" }),
    ).toEqual({ draftId: "client-new-thread:a", cwd: "/work/custom" });
    expect(
      store.resolve({ composer: composerB, hostId: "local", draftId: "client-new-thread:b" }),
    ).toBeNull();
  });

  it("keeps official project drafts quota-gated when global config uses a custom provider", async () => {
    const customConfig = {
      model_provider: "custom",
      model_providers: {
        custom: {
          base_url: "http://127.0.0.1:15721/v1",
          experimental_bearer_token: "PROXY_MANAGED",
          requires_openai_auth: true,
        },
      },
    };
    const sendRequest = vi.fn(async (method: string, params: unknown) => {
      if (method !== "config/read") throw new Error(`Unexpected method: ${method}`);
      const cwd =
        typeof params === "object" && params !== null && "cwd" in params
          ? (params as { cwd?: unknown }).cwd
          : undefined;
      if (cwd === "/work/official") {
        return { config: { ...customConfig, model_provider: "openai" } };
      }
      return { config: customConfig };
    });
    const client = createRendererModelClient([{ sendRequest }]);
    if (!client) throw new Error("Missing client");

    const store = createRendererNativeDraftWorkspaceStore();
    const composer = {};
    let draftId = "client-new-thread:official";
    const results: boolean[] = [];
    const render = (): boolean => {
      const value = route.update(
        client,
        null,
        true,
        store.resolve({ composer, hostId: "local", draftId }),
      );
      results.push(value);
      return value;
    };
    const route = createRendererNativeInferenceRoute(render);

    // 1. Before workspace confirmation, never fall back to global custom config.
    expect(render()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendRequest).not.toHaveBeenCalled();

    // 2. Project-level official override stays quota-gated.
    store.publish({ hostId: "local", cwd: "/work/official" }, [
      { composer, hostId: "local", draftId },
    ]);
    expect(render()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(results.at(-1)).toBe(false);

    // 3. Confirmed custom-provider workspace unlocks quota isolation.
    store.publish({ hostId: "local", cwd: "/work/custom" }, [
      { composer, hostId: "local", draftId },
    ]);
    expect(render()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(results.at(-1)).toBe(true);

    // 4. Switching to a new unconfirmed draft revokes isolation instead of inheriting /work/custom.
    draftId = "client-new-thread:next-official";
    expect(render()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(results.at(-1)).toBe(false);

    route.dispose();
  });
});
