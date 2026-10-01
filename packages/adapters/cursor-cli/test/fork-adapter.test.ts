import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";
import type { ForkSessionInput } from "@codexhost/harness-adapter";
import { CursorAdapter } from "../src/adapter.js";
import { CursorTransport, type CursorSessionInfo } from "../src/transport.js";
import { forkCursorSession } from "../src/fork.js";
import { cursorCheckpoint } from "../src/fork-support.js";
import type * as NativeHistory from "../src/native-history.js";
import type * as Fork from "../src/fork.js";
import type * as ForkSupport from "../src/fork-support.js";

const native = vi.hoisted(() => ({
  turns: [] as NativeHistory.CursorNativeTurn[],
  revision: "initial",
  target: undefined as NativeHistory.CursorNativeTurn[] | undefined,
}));
vi.mock("../src/native-history.js", async (original) => ({
  ...(await original<typeof NativeHistory>()),
  readCursorNativeHistory: (sessionId: string) => ({
    revision: native.revision,
    turns: structuredClone(sessionId === targetId ? (native.target ?? native.turns) : native.turns),
  }),
  readCursorNativeTurns: (sessionId: string) =>
    structuredClone(sessionId === targetId ? (native.target ?? native.turns) : native.turns),
}));
vi.mock("../src/fork.js", async (original) => ({
  ...(await original<typeof Fork>()),
  forkCursorSession: vi.fn(),
}));
vi.mock("../src/fork-support.js", async (original) => ({
  ...(await original<typeof ForkSupport>()),
  cursorForkAvailable: () => true,
}));

const sourceId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const targetId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const adapters: CursorAdapter[] = [];
function sessionInfo(sessionId: string) {
  return {
    sessionId,
    nativeModels: [{ value: "model", name: "Model", configOptions: [] }],
    configOptions: [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "model",
        options: [{ value: "model", name: "Model" }],
      },
      {
        id: "mode",
        name: "Mode",
        type: "select",
        currentValue: "agent",
        options: [{ value: "agent", name: "Agent" }],
      },
    ],
  } satisfies CursorSessionInfo;
}
function load(transport: CursorTransport, sessionId = sourceId) {
  transport.sessionId = sessionId;
  transport.replay = (sessionId === targetId ? (native.target ?? native.turns) : native.turns).map(
    (turn) => ({
      sessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: turn.text },
      },
    }),
  );
  return sessionInfo(sessionId);
}
beforeEach(() => {
  native.turns = [{ id: randomUUID(), text: "hello" }];
  native.target = undefined;
  native.revision = "initial";
  vi.spyOn(CursorTransport.prototype, "prepare").mockResolvedValue();
  vi.spyOn(CursorTransport.prototype, "open").mockImplementation(async function (
    this: CursorTransport,
    sessionId,
  ) {
    return load(this, sessionId);
  });
  vi.spyOn(CursorTransport.prototype, "close").mockResolvedValue();
  vi.spyOn(CursorTransport.prototype, "configure").mockImplementation(async function (
    this: CursorTransport,
    configId,
    value,
  ) {
    return {
      configOptions: sessionInfo(this.sessionId).configOptions.map((option) =>
        option.id === configId ? { ...option, currentValue: value } : option,
      ),
    };
  });
});
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  vi.restoreAllMocks();
  vi.mocked(forkCursorSession).mockReset();
});
async function fixture(executionPolicy?: "unattended-full-access") {
  const adapter = new CursorAdapter({ environment: {} });
  adapters.push(adapter);
  const opened = await adapter.open({
    kind: "create",
    cwd: process.cwd(),
    ...(executionPolicy ? { executionPolicy } : {}),
  });
  if (!opened.ok) throw new Error(opened.error.message);
  const source = opened.value;
  const sourceRef = source.initialState.nativeRef;
  const tail = native.turns.at(-1);
  if (!sourceRef || !tail) throw new Error("Missing fixture identity");
  const input: ForkSessionInput = {
    kind: "fork",
    cwd: process.cwd(),
    sourceRef,
    checkpoint: cursorCheckpoint(sourceId, tail.id),
  };
  const transaction = {
    sessionId: targetId,
    expected: structuredClone(native.turns),
    sourceTurns: structuredClone(native.turns),
    commit: vi.fn(),
    discard: vi.fn(async () => {}),
  };
  vi.mocked(forkCursorSession).mockResolvedValue(transaction);
  return { adapter, source, input, transaction };
}

describe("Cursor snapshot and configuration reuse", () => {
  it("reuses loaded history and refreshes once when the native root changes without new turn IDs", async () => {
    const f = await fixture();
    const opened = await f.adapter.open({
      kind: "resume",
      cwd: f.input.cwd,
      nativeRef: f.input.sourceRef,
    });
    if (!opened.ok) throw new Error(opened.error.message);
    vi.mocked(CursorTransport.prototype.open).mockClear();
    const first = await opened.value.readSnapshot();
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);
    first.value.turns.length = 0;
    expect(await opened.value.readSnapshot()).toMatchObject({
      ok: true,
      value: { turns: [{ input: [{ type: "text", text: "hello" }] }] },
    });
    expect(CursorTransport.prototype.open).not.toHaveBeenCalled();
    native.revision = "new-assistant-root";
    vi.mocked(CursorTransport.prototype.open).mockImplementationOnce(async function (
      this: CursorTransport,
      id,
    ) {
      const info = load(this, id);
      this.replay.push({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "updated native answer" },
        },
      });
      return info;
    });
    const refreshed = await opened.value.readSnapshot();
    expect(refreshed).toMatchObject({ ok: true });
    if (!refreshed.ok) throw new Error(refreshed.error.message);
    expect(
      refreshed.value.turns[0]?.items.some(
        ({ item }) => item.type === "agentMessage" && item.text === "updated native answer",
      ),
    ).toBe(true);
    expect(CursorTransport.prototype.open).toHaveBeenCalledOnce();
    expect(await opened.value.readSnapshot()).toMatchObject({ ok: true });
    expect(CursorTransport.prototype.open).toHaveBeenCalledOnce();
  });
  it("does not reuse a replay if the root changed while ACP was loading", async () => {
    const f = await fixture();
    vi.mocked(CursorTransport.prototype.open).mockImplementationOnce(async function (
      this: CursorTransport,
      id,
    ) {
      native.revision = "changed-during-load";
      return load(this, id);
    });
    const opened = await f.adapter.open({
      kind: "resume",
      cwd: f.input.cwd,
      nativeRef: f.input.sourceRef,
    });
    if (!opened.ok) throw new Error(opened.error.message);
    vi.mocked(CursorTransport.prototype.open).mockClear();
    expect(await opened.value.readSnapshot()).toMatchObject({ ok: true });
    expect(CursorTransport.prototype.open).toHaveBeenCalledOnce();
  });
  it("rejects a changing root during replay and retries instead of caching inconsistent history", async () => {
    const f = await fixture();
    vi.mocked(CursorTransport.prototype.open).mockImplementationOnce(async function (
      this: CursorTransport,
      id,
    ) {
      const info = load(this, id);
      native.revision = "changed-during-replay";
      return info;
    });
    expect(await f.source.readSnapshot()).toMatchObject({
      error: { message: "Cursor native history changed during snapshot read" },
    });
    vi.mocked(CursorTransport.prototype.open).mockClear();
    expect(await f.source.readSnapshot()).toMatchObject({ ok: true });
    expect(CursorTransport.prototype.open).toHaveBeenCalledOnce();
    expect(await f.source.readSnapshot()).toMatchObject({ ok: true });
    expect(CursorTransport.prototype.open).toHaveBeenCalledOnce();
  });
  it("skips identical settings when Adapter and Host restore them repeatedly", async () => {
    const f = await fixture();
    const model = f.source.initialState.effectiveModel;
    const mode = f.source.initialState.effectivePermissionModeId;
    if (!model || !mode) throw new Error("Missing settings");
    for (let i = 0; i < 2; i++) {
      expect(await f.source.execute({ type: "model.select", model })).toMatchObject({ ok: true });
      expect(
        await f.source.execute({ type: "permissionMode.select", permissionModeId: mode }),
      ).toMatchObject({ ok: true });
    }
    expect(CursorTransport.prototype.configure).not.toHaveBeenCalled();
  });
});

describe("Cursor Adapter fork adoption", () => {
  it.each(["fork", "rollbackLastTurn"] as const)("adopts the exact prefix for %s", async (kind) => {
    native.turns.push({ id: randomUUID(), text: "last", rewindRoot: "a".repeat(64) });
    const f = await fixture();
    native.target = native.turns.slice(0, 1);
    f.transaction.expected = structuredClone(native.target);
    const result = await f.adapter.open(
      kind === "fork"
        ? {
            ...f.input,
            checkpoint: cursorCheckpoint(sourceId, native.turns[0]?.id ?? "missing"),
          }
        : { kind, cwd: f.input.cwd, sourceRef: f.input.sourceRef },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(await result.value.readSnapshot()).toMatchObject({
      ok: true,
      value: { turns: [{ input: [{ type: "text", text: "hello" }] }] },
    });
    expect(f.transaction.commit).toHaveBeenCalledOnce();
  });
  it("supports single-turn revision and preserves explicitly selected settings", async () => {
    native.turns = [{ id: randomUUID(), text: "hello", rewindRoot: "a".repeat(64) }];
    const f = await fixture();
    native.target = [];
    f.transaction.expected = [];
    const { effectiveModel: model, effectivePermissionModeId: permissionModeId } =
      f.source.initialState;
    if (!model || !permissionModeId) throw new Error("Missing source settings");
    const result = await f.adapter.open({
      kind: "rollbackLastTurn",
      cwd: f.input.cwd,
      sourceRef: f.input.sourceRef,
      permissionModeId,
      model,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(await result.value.readSnapshot()).toMatchObject({ ok: true, value: { turns: [] } });
    expect(result.value.initialState.effectiveModel).toEqual(model);
    expect(result.value.initialState.effectivePermissionModeId).toBe(permissionModeId);
    expect(CursorTransport.prototype.configure).not.toHaveBeenCalled();
  });
  it("rejects rollback with no history without launching the CLI", async () => {
    const f = await fixture();
    native.turns = [];
    expect(
      await f.adapter.open({
        kind: "rollbackLastTurn",
        sourceRef: f.input.sourceRef,
        cwd: f.input.cwd,
      }),
    ).toMatchObject({ error: { code: "checkpointNotFound" } });
    expect(forkCursorSession).not.toHaveBeenCalled();
  });
  it("commits the new session only after ACP load and restores source availability", async () => {
    const f = await fixture();
    const result = await f.adapter.open(f.input);
    expect(result).toMatchObject({
      ok: true,
      value: { initialState: { nativeRef: { nativeSessionId: targetId } } },
    });
    expect(f.transaction.commit).toHaveBeenCalledOnce();
    expect(f.transaction.discard).not.toHaveBeenCalled();
    expect(CursorTransport.prototype.open).toHaveBeenCalledWith(targetId);
    expect(await f.source.readSnapshot()).toMatchObject({ ok: true });
  });

  it("inherits unattended full access into a forked session", async () => {
    const f = await fixture("unattended-full-access");
    expect(f.input.sourceRef.locator).toEqual({ executionPolicy: "unattended-full-access" });
    const result = await f.adapter.open(f.input);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.initialState.nativeRef).toMatchObject({
      nativeSessionId: targetId,
      locator: { executionPolicy: "unattended-full-access" },
    });
    const transport = vi.mocked(CursorTransport.prototype.prepare).mock.contexts[0];
    if (!(transport instanceof CursorTransport)) throw new Error("Missing derived transport");
    expect(transport.options.executionPolicy).toBe("unattended-full-access");
  });

  it("inherits unattended full access into a rollback session", async () => {
    native.turns = [{ id: randomUUID(), text: "hello", rewindRoot: "a".repeat(64) }];
    const f = await fixture("unattended-full-access");
    native.target = [];
    f.transaction.expected = [];
    const result = await f.adapter.open({
      kind: "rollbackLastTurn",
      sourceRef: f.input.sourceRef,
      cwd: f.input.cwd,
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.initialState.nativeRef).toMatchObject({
      nativeSessionId: targetId,
      locator: { executionPolicy: "unattended-full-access" },
    });
    const transport = vi.mocked(CursorTransport.prototype.prepare).mock.contexts[0];
    if (!(transport instanceof CursorTransport)) throw new Error("Missing derived transport");
    expect(transport.options.executionPolicy).toBe("unattended-full-access");
  });

  it("discards a target if ACP load changed its retained history", async () => {
    const f = await fixture();
    native.target = [{ id: randomUUID(), text: "unexpected" }];
    expect(await f.adapter.open(f.input)).toMatchObject({
      error: { message: "Cursor derived history changed during ACP adoption" },
    });
    expect(f.transaction.discard).toHaveBeenCalledOnce();
    expect(f.transaction.commit).not.toHaveBeenCalled();
    expect(await f.source.readSnapshot()).toMatchObject({ ok: true });
  });

  it("discards the target and releases the source lock when ACP adoption fails", async () => {
    const f = await fixture();
    vi.mocked(CursorTransport.prototype.open).mockRejectedValueOnce(new Error("load failed"));
    expect(await f.adapter.open(f.input)).toMatchObject({
      ok: false,
      error: { message: "load failed" },
    });
    expect(f.transaction.commit).not.toHaveBeenCalled();
    expect(f.transaction.discard).toHaveBeenCalledOnce();
    expect(await f.source.readSnapshot()).toMatchObject({ ok: true });
  });

  it("holds the source lock during staging and releases it after failure", async () => {
    const f = await fixture();
    const staging = Promise.withResolvers<typeof f.transaction>();
    vi.mocked(forkCursorSession).mockReturnValueOnce(staging.promise);
    const pending = f.adapter.open(f.input);
    expect(await f.source.readSnapshot()).toMatchObject({ error: { code: "sessionBusy" } });
    expect(await f.adapter.open(f.input)).toMatchObject({ error: { code: "sessionBusy" } });
    expect(forkCursorSession).toHaveBeenCalledOnce();
    staging.reject(new Error("native fork failed"));
    expect(await pending).toMatchObject({ ok: false });
    expect(await f.source.readSnapshot()).toMatchObject({ ok: true });
    expect(await f.adapter.open(f.input)).toMatchObject({ ok: true });
  });

  it("rejects a busy source before starting native Fork", async () => {
    const f = await fixture();
    const configuring = Promise.withResolvers<{
      configOptions: NonNullable<CursorSessionInfo["configOptions"]>;
    }>();
    vi.mocked(CursorTransport.prototype.configure).mockReturnValueOnce(configuring.promise);
    const permissionModeId = harnessPermissionModeIdSchema.parse("plan");
    const selection = f.source.execute({
      type: "permissionMode.select",
      permissionModeId,
    });
    expect(await f.adapter.open(f.input)).toMatchObject({ error: { code: "sessionBusy" } });
    expect(forkCursorSession).not.toHaveBeenCalled();
    configuring.resolve({
      configOptions: sessionInfo(sourceId).configOptions.map((option) =>
        option.id === "mode" ? { ...option, currentValue: "plan" } : option,
      ),
    });
    expect(await selection).toMatchObject({ ok: true });
    expect(await f.adapter.open(f.input)).toMatchObject({ ok: true });
  });

  it("rejects boundaries without native anchors or missing identities before staging and releases the lock", async () => {
    const earlierId = randomUUID();
    native.turns.unshift({ id: earlierId, text: "earlier" });
    const f = await fixture();
    expect(
      await f.adapter.open({
        ...f.input,
        checkpoint: cursorCheckpoint(sourceId, earlierId),
      }),
    ).toMatchObject({ error: { code: "unsupported" } });
    expect(
      await f.adapter.open({
        ...f.input,
        checkpoint: cursorCheckpoint(sourceId, randomUUID()),
      }),
    ).toMatchObject({ error: { code: "checkpointNotFound" } });
    expect(forkCursorSession).not.toHaveBeenCalled();
    expect(await f.adapter.open(f.input)).toMatchObject({ ok: true });
  });

  it("cancels staging on Adapter close and discards a target returned after cancellation", async () => {
    const f = await fixture();
    const staging = Promise.withResolvers<typeof f.transaction>();
    vi.mocked(forkCursorSession).mockReturnValueOnce(staging.promise);
    const pending = f.adapter.open(f.input);
    const call = vi.mocked(forkCursorSession).mock.calls[0];
    if (!call) throw new Error("Native Fork did not start");
    const signal = call[3];
    const closing = f.adapter.close();
    expect(signal.aborted).toBe(true);
    staging.resolve(f.transaction);
    expect(await pending).toMatchObject({ ok: false });
    await closing;
    expect(f.transaction.discard).toHaveBeenCalledOnce();
    expect(f.transaction.commit).not.toHaveBeenCalled();
    expect(CursorTransport.prototype.open).not.toHaveBeenCalledWith(targetId);
    expect(await f.source.readSnapshot()).toMatchObject({ error: { code: "invalidState" } });
  });

  it("closes the pending ACP target and discards it when Adapter closes during adoption", async () => {
    const f = await fixture();
    const adoption = Promise.withResolvers<CursorSessionInfo>();
    const entered = Promise.withResolvers<undefined>();
    vi.mocked(CursorTransport.prototype.open).mockImplementationOnce(async function (
      this: CursorTransport,
      sessionId,
    ) {
      load(this, sessionId);
      entered.resolve(undefined);
      return adoption.promise;
    });
    const pending = f.adapter.open(f.input);
    await entered.promise;
    const closing = f.adapter.close();
    adoption.resolve(sessionInfo(targetId));
    expect(await pending).toMatchObject({ ok: false });
    await closing;
    expect(f.transaction.discard).toHaveBeenCalledOnce();
    expect(f.transaction.commit).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(CursorTransport.prototype.close)
        .mock.contexts.map((transport) =>
          transport instanceof CursorTransport ? transport.sessionId : undefined,
        ),
    ).toEqual(expect.arrayContaining([sourceId, targetId]));
  });
});

describe("Cursor parallel derivation startup", () => {
  it("starts authentication during staging, then adopts the prepared process and source catalog", async () => {
    const f = await fixture();
    const staging = Promise.withResolvers<typeof f.transaction>();
    const preparing = Promise.withResolvers<undefined>();
    vi.mocked(forkCursorSession).mockReturnValueOnce(staging.promise);
    vi.mocked(CursorTransport.prototype.prepare).mockReturnValueOnce(preparing.promise);
    const pending = f.adapter.open(f.input);
    expect(CursorTransport.prototype.prepare).toHaveBeenCalledOnce();
    expect(forkCursorSession).toHaveBeenCalledOnce();
    expect(CursorTransport.prototype.open).not.toHaveBeenCalledWith(targetId);
    const transport = vi.mocked(CursorTransport.prototype.prepare).mock.contexts[0];
    expect(transport).toBeInstanceOf(CursorTransport);
    if (!(transport instanceof CursorTransport)) throw new Error("Missing prepared transport");
    expect(transport.cachedModels).toEqual(sessionInfo(sourceId).nativeModels);
    staging.resolve(f.transaction);
    preparing.resolve(undefined);
    expect(await pending).toMatchObject({ ok: true });
    expect(vi.mocked(CursorTransport.prototype.open).mock.contexts.at(-1)).toBe(transport);
  });

  it("does not inherit the source catalog when the environment changes", async () => {
    const f = await fixture();
    expect(
      await f.adapter.open({ ...f.input, environment: { CURSOR_CONFIG_DIR: "/another-config" } }),
    ).toMatchObject({ ok: true });
    const transport = vi.mocked(CursorTransport.prototype.prepare).mock.contexts[0];
    if (!(transport instanceof CursorTransport)) throw new Error("Missing prepared transport");
    expect(transport.cachedModels).toBeUndefined();
  });

  it("cancels staging and discards any late target if authentication fails", async () => {
    const f = await fixture();
    const staging = Promise.withResolvers<typeof f.transaction>();
    vi.mocked(forkCursorSession).mockReturnValueOnce(staging.promise);
    vi.mocked(CursorTransport.prototype.prepare).mockRejectedValueOnce(
      new Error("authentication failed"),
    );
    const pending = f.adapter.open(f.input);
    await vi.waitFor(() =>
      expect(vi.mocked(forkCursorSession).mock.calls[0]?.[3].aborted).toBe(true),
    );
    staging.resolve(f.transaction);
    expect(await pending).toMatchObject({ ok: false });
    expect(f.transaction.discard).toHaveBeenCalledOnce();
    expect(f.transaction.commit).not.toHaveBeenCalled();
  });
});
