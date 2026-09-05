import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostTurnIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import type { HarnessSession } from "@codexhost/harness-adapter";

import { ClaudeCodeAdapter } from "../src/claude-code-adapter.js";
import { encodeClaudeModelRef } from "../src/model-catalog.js";
import { CLAUDE_DEFAULT_THINKING_OPTION_ID } from "../src/thinking-options.js";
import { CLAUDE_DEFAULT_PERMISSION_MODE_ID } from "../src/permission-modes.js";
import { ClaudePendingSessions } from "../src/pending-session.js";
import type {
  ClaudeAdapterDependencies,
  ClaudeTransportFactoryInput,
  ClaudeTurnTransport,
} from "../src/transport.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function messages(sessionId: string, text: string) {
  return [
    {
      type: "user",
      uuid: randomUUID() as string,
      session_id: sessionId,
      message: { role: "user", content: text },
    },
    {
      type: "assistant",
      uuid: randomUUID() as string,
      session_id: sessionId,
      message: { role: "assistant", content: [{ type: "text", text: `${text} response` }] },
    },
  ];
}

async function fixture(turns = 1) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-rollback-"));
  cleanups.push(() => rm(directory, { force: true, recursive: true }));
  const environment = { CLAUDE_CONFIG_DIR: directory };
  const sourceRef = nativeSessionRefSchema.parse({
    harnessId: "claude-code",
    nativeSessionId: randomUUID(),
    formatVersion: 1,
  });
  const histories = new Map([
    [
      sourceRef.nativeSessionId,
      Array.from({ length: turns }, (_, i) =>
        messages(sourceRef.nativeSessionId, `prompt ${i + 1}`),
      ).flat(),
    ],
  ]);
  const transports: Array<ClaudeTurnTransport & { input: ClaudeTransportFactoryInput }> = [];
  const dependencies: ClaudeAdapterDependencies = {
    randomUUID,
    inspectInstallation: () => undefined,
    createInspector: () => ({
      inspect: async () => ({
        models: [{ value: "default", displayName: "Default", description: "Default" }],
        canSelectModel: true,
        canSelectPermissionMode: true,
      }),
      close: async () => undefined,
    }),
    deleteSession: vi.fn(async ({ sessionId }) => {
      histories.delete(sessionId);
    }),
    forkSession: vi.fn(async ({ sourceSessionId, checkpointId }) => {
      const id = randomUUID();
      const source = histories.get(sourceSessionId) ?? [];
      const prefix = source.slice(0, source.findIndex((m) => m.uuid === checkpointId) + 1);
      histories.set(
        id,
        prefix.map((m) => ({
          ...structuredClone(m),
          uuid: randomUUID() as string,
          session_id: id,
        })),
      );
      return { sessionId: id };
    }),
    getSessionInfo: async ({ sessionId }) =>
      histories.has(sessionId) ? { cwd: directory } : undefined,
    readSessionMessages: vi.fn(async ({ sessionId }) =>
      structuredClone(histories.get(sessionId) ?? []),
    ),
    readSubagentMessages: async () => [],
    createTransport: vi.fn((input) => {
      let permissionMode = input.permissionMode;
      const transport = {
        input,
        sessionId: input.sessionId,
        start: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
        setAutonomousTurnHandler: () => undefined,
        setIdleTurnHandler: () => undefined,
        setIdleLive: () => undefined,
        getContextUsage: async () => null,
        getPermissionMode: () => permissionMode,
        setPermissionMode: async (mode) => {
          permissionMode = mode;
        },
        setModel: async () => undefined,
        setThinkingOption: async () => undefined,
        respondToInteraction: async () => undefined,
        compact: async () => ({ status: "succeeded" as const }),
        init: async () => ({ status: "succeeded" as const }),
        recap: async () => ({ status: "succeeded" as const }),
        runTurn: async (text, userMessageId, onEvent) => {
          const next = messages(input.sessionId, text);
          assert.ok(next[0]);
          assert.ok(next[1]);
          next[0].uuid = userMessageId;
          histories.set(input.sessionId, [...(histories.get(input.sessionId) ?? []), ...next]);
          onEvent({ type: "text.delta", messageId: next[1].uuid, delta: `${text} response` });
          onEvent({
            type: "message.completed",
            messageId: next[1].uuid,
            checkpointId: next[1].uuid,
          });
          return { status: "succeeded" };
        },
      } satisfies ClaudeTurnTransport & { input: ClaudeTransportFactoryInput };
      transports.push(transport);
      return transport;
    }),
  };
  const adapter = () => {
    const value = new ClaudeCodeAdapter({ environment, closeTimeoutMs: 50 }, dependencies);
    cleanups.push(() => value.close().catch(() => undefined));
    return value;
  };
  return { adapter, directory, environment, sourceRef, histories, dependencies, transports };
}

async function unwrap(result: ReturnType<ClaudeCodeAdapter["open"]>): Promise<HarnessSession> {
  const opened = await result;
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value;
}

const model = encodeClaudeModelRef("sonnet");

describe("Claude last-Turn rollback", () => {
  it("reserves empty history, restores it in another Adapter and uses the same ID for edited input", async () => {
    const f = await fixture();
    const source = structuredClone(f.histories.get(f.sourceRef.nativeSessionId));
    const first = f.adapter();
    const replacement = await unwrap(
      first.open({ kind: "rollbackLastTurn", cwd: f.directory, sourceRef: f.sourceRef, model }),
    );
    expect(replacement.capabilities.history).toMatchObject({
      rollbackLastTurn: true,
      replacementFence: true,
    });
    const ref = nativeSessionRefSchema.parse(replacement.initialState.nativeRef);
    expect(ref.nativeSessionId).not.toBe(f.sourceRef.nativeSessionId);
    expect(await replacement.readSnapshot()).toMatchObject({
      ok: true,
      value: { turns: [], state: { nativeRef: ref, effectiveModel: model } },
    });
    await first.close();
    const second = f.adapter();
    const resumed = await unwrap(
      second.open({ kind: "resume", cwd: f.directory, nativeRef: ref, knownTurnRefs: [] }),
    );
    expect(await resumed.readSnapshot()).toMatchObject({ ok: true, value: { turns: [] } });
    expect(f.transports).toHaveLength(0);
    expect(
      await resumed.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse(randomUUID()),
        input: [{ type: "text", text: "edited" }],
      }),
    ).toMatchObject({ ok: true });
    await vi.waitFor(async () =>
      expect(await resumed.readSnapshot()).toMatchObject({
        ok: true,
        value: { turns: [{ input: [{ text: "edited" }] }] },
      }),
    );
    expect(f.transports[0]?.input).toMatchObject({
      openMode: "create",
      sessionId: ref.nativeSessionId,
      model: "sonnet",
    });
    await second.close();
    const third = f.adapter();
    const cold = await unwrap(third.open({ kind: "resume", cwd: f.directory, nativeRef: ref }));
    expect(await cold.readSnapshot()).toMatchObject({
      ok: true,
      value: { turns: [{ input: [{ text: "edited" }] }] },
    });
    expect(f.histories.get(f.sourceRef.nativeSessionId)).toEqual(source);
    f.histories.delete(ref.nativeSessionId);
    expect(await cold.readSnapshot()).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
  });

  it("keeps the full prior Turn through native Fork and preserves source history", async () => {
    const f = await fixture(2);
    const before = structuredClone(f.histories.get(f.sourceRef.nativeSessionId));
    const replacement = await unwrap(
      f
        .adapter()
        .open({ kind: "rollbackLastTurn", cwd: f.directory, sourceRef: f.sourceRef, model }),
    );
    expect(await replacement.readSnapshot()).toMatchObject({
      ok: true,
      value: {
        turns: [
          { input: [{ text: "prompt 1" }], items: [{ item: { text: "prompt 1 response" } }] },
        ],
      },
    });
    expect(f.histories.get(f.sourceRef.nativeSessionId)).toEqual(before);
    expect(f.dependencies.forkSession).toHaveBeenCalledOnce();
  });

  it("persists configuration changes made before the first resend", async () => {
    const f = await fixture();
    const first = f.adapter();
    const session = await unwrap(
      first.open({ kind: "rollbackLastTurn", cwd: f.directory, sourceRef: f.sourceRef }),
    );
    await session.execute({ type: "model.select", model });
    await session.close();
    const resumed = await unwrap(
      f.adapter().open({
        kind: "resume",
        cwd: f.directory,
        nativeRef: nativeSessionRefSchema.parse(session.initialState.nativeRef),
      }),
    );
    expect(await resumed.readSnapshot()).toMatchObject({
      ok: true,
      value: {
        state: {
          effectiveModel: model,
          effectiveThinkingOptionId: CLAUDE_DEFAULT_THINKING_OPTION_ID,
          effectivePermissionModeId: CLAUDE_DEFAULT_PERMISSION_MODE_ID,
        },
      },
    });
  });

  it("does not pretend a claimed but missing transcript is an empty Session", async () => {
    const f = await fixture();
    const store = new ClaudePendingSessions(f.environment);
    const ref = await store.create(f.directory, {});
    await store.claim(ref, f.directory);
    const session = await unwrap(
      f.adapter().open({ kind: "resume", cwd: f.directory, nativeRef: ref }),
    );
    expect(await session.readSnapshot()).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
    await expect(store.claim(ref, f.directory)).rejects.toMatchObject({ code: "EEXIST" });
    await expect(store.read(ref, path.join(f.directory, "other"))).rejects.toThrow();
  });

  it("propagates a failed Transport close to the history replacement caller", async () => {
    const f = await fixture(2);
    const session = await unwrap(
      f.adapter().open({ kind: "resume", cwd: f.directory, nativeRef: f.sourceRef }),
    );
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse(randomUUID()),
      input: [{ type: "text", text: "next" }],
    });
    assert.ok(f.transports[0]);
    vi.mocked(f.transports[0].close).mockRejectedValue(new Error("process still alive"));
    await expect(session.close()).rejects.toThrow("could not stop safely");
    await expect(session.close()).rejects.toThrow();
  });

  it("waits for the completed native message before deriving an immediate edit", async () => {
    const f = await fixture();
    const adapter = f.adapter();
    const session = await unwrap(
      adapter.open({ kind: "resume", cwd: f.directory, nativeRef: f.sourceRef }),
    );
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse(randomUUID()),
      input: [{ type: "text", text: "not flushed yet" }],
    });
    await vi.waitFor(() => expect(f.histories.get(f.sourceRef.nativeSessionId)).toHaveLength(4));
    const saved = f.histories.get(f.sourceRef.nativeSessionId);
    assert.ok(saved);
    f.histories.set(f.sourceRef.nativeSessionId, saved.slice(0, 2));
    const rollback = adapter.open({
      kind: "rollbackLastTurn",
      cwd: f.directory,
      sourceRef: f.sourceRef,
    });
    setTimeout(() => f.histories.set(f.sourceRef.nativeSessionId, saved), 10);
    const replacement = await unwrap(rollback);
    expect(await replacement.readSnapshot()).toMatchObject({
      ok: true,
      value: { turns: [{ input: [{ text: "prompt 1" }] }] },
    });
    expect(f.dependencies.forkSession).toHaveBeenCalledOnce();
  });

  it("allows only one competing wrapper to create the reserved native Session", async () => {
    const f = await fixture();
    const ref = await new ClaudePendingSessions(f.environment).create(f.directory, {});
    const sessions = await Promise.all(
      [f.adapter(), f.adapter()].map((adapter) =>
        unwrap(adapter.open({ kind: "resume", cwd: f.directory, nativeRef: ref })),
      ),
    );
    const results = await Promise.all(
      sessions.map((session) =>
        session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse(randomUUID()),
          input: [{ type: "text", text: "one owner" }],
        }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(f.transports).toHaveLength(1);
  });

  it("releases an unused reservation after startup fails and close succeeds", async () => {
    const f = await fixture();
    const store = new ClaudePendingSessions(f.environment);
    const ref = await store.create(f.directory, {});
    vi.mocked(f.dependencies.createTransport).mockImplementationOnce(() => {
      throw new Error("cannot spawn");
    });
    const session = await unwrap(
      f.adapter().open({ kind: "resume", cwd: f.directory, nativeRef: ref }),
    );
    expect(
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse(randomUUID()),
        input: [{ type: "text", text: "retry" }],
      }),
    ).toMatchObject({ ok: false });
    expect(await store.read(ref, f.directory)).toMatchObject({ started: false });
    expect(
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse(randomUUID()),
        input: [{ type: "text", text: "retry" }],
      }),
    ).toMatchObject({ ok: true });
    expect(f.transports).toHaveLength(1);
  });

  it("keeps an interrupted preceding Turn without an assistant checkpoint", async () => {
    const f = await fixture(2);
    const source = f.histories.get(f.sourceRef.nativeSessionId);
    assert.ok(source?.[0]);
    f.histories.set(f.sourceRef.nativeSessionId, [source[0], ...source.slice(2)]);
    const replacement = await unwrap(
      f.adapter().open({ kind: "rollbackLastTurn", cwd: f.directory, sourceRef: f.sourceRef }),
    );
    expect(await replacement.readSnapshot()).toMatchObject({
      ok: true,
      value: { turns: [{ input: [{ text: "prompt 1" }], items: [] }] },
    });
  });

  it("rejects missing recovery metadata instead of silently recreating it", async () => {
    const f = await fixture();
    const store = new ClaudePendingSessions(f.environment);
    const ref = await store.create(f.directory, {});
    await store.discard(ref, f.directory);
    expect(
      await f.adapter().open({ kind: "resume", cwd: f.directory, nativeRef: ref }),
    ).toMatchObject({ ok: false, error: { code: "sessionNotFound" } });
    expect(f.transports).toHaveLength(0);
  });
});
