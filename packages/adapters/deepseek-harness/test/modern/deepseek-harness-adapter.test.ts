import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import Schema from "@deepseek-ai/schemastery";

import { nativeCheckpointRefSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";

import {
  ModernDeepSeekHarnessAdapter,
  type ModernConnectionLike,
} from "../../src/modern/deepseek-harness-adapter.js";
import { ModernRemoteConnectionError } from "../../src/modern/remote-connection.js";
import type { ModernRemoteFailure, ModernRemoteResult } from "../../src/modern/wire.js";

class Feed implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  readonly #items: IteratorResult<unknown>[] = [];
  #pending: ((item: IteratorResult<unknown>) => void) | undefined;
  #done = false;
  #returned = false;
  returnCalls = 0;

  constructor(readonly onReturn: () => void = () => undefined) {}

  push(value: unknown): void {
    if (this.#done) return;
    this.#deliver({ done: false, value });
  }

  finish(): void {
    if (this.#done) return;
    this.#done = true;
    this.#deliver({ done: true, value: undefined });
  }

  next(): Promise<IteratorResult<unknown>> {
    const item = this.#items.shift();
    if (item) return Promise.resolve(item);
    if (this.#done) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => {
      this.#pending = resolve;
    });
  }

  return(): Promise<IteratorResult<unknown>> {
    if (this.#returned) return Promise.resolve({ done: true, value: undefined });
    this.#returned = true;
    this.returnCalls += 1;
    this.onReturn();
    this.finish();
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this;
  }

  #deliver(item: IteratorResult<unknown>): void {
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending) pending(item);
    else this.#items.push(item);
  }
}

interface CallRecord {
  readonly endpoint: string;
  readonly args: Readonly<Record<string, unknown>>;
}

class FakeConnection implements ModernConnectionLike {
  readonly calls: CallRecord[] = [];
  readonly streams: CallRecord[] = [];
  readonly timeline: string[] = [];
  readonly control = new Feed(() => this.timeline.push("control.return"));
  readonly events = new Feed(() => this.timeline.push("events.return"));
  readonly replacementEvents: Feed[] = [];
  readonly follows = new Map<string, Feed>();
  readonly journalSnapshots = new Map<string, Record<string, unknown>>();
  readonly journalSnapshotQueues = new Map<string, Record<string, unknown>[]>();
  readonly followFailureQueues = new Map<string, Array<Error | undefined>>();
  readonly modelSelections = new Map<string, Record<string, string> | null>();
  readonly permissionSelections = new Map<string, string>();
  readonly faultListeners = new Set<(error: ModernRemoteConnectionError) => void>();
  connectCalls = 0;
  closeCalls = 0;
  readonly openWebUi = vi.fn(() => Promise.resolve());
  stderrTail = "";
  autoOpenJournal = true;
  permissionModesEnabled = false;
  validUnattendedFacts = true;
  eventOpenCount = 0;
  forkResult: ModernRemoteResult<unknown> = {
    ok: true,
    value: { sessionId: "session-forked" },
  };
  sessionListResult: ModernRemoteResult<unknown> = { ok: true, value: { items: [] } };
  forkResponse: Promise<ModernRemoteResult<unknown>> | undefined;
  cancelResponse: Promise<ModernRemoteResult<unknown>> | undefined;
  closeError: Error | undefined;

  constructor() {
    this.control.push(controlBaseline());
    this.events.push({
      type: "ready",
      clientId: "client-1",
      host: { home: String.raw`C:\Users\fixture` },
    });
  }

  connect(): Promise<void> {
    this.connectCalls += 1;
    this.timeline.push("connect");
    return Promise.resolve();
  }

  onFault(listener: (error: ModernRemoteConnectionError) => void): () => void {
    this.faultListeners.add(listener);
    return () => this.faultListeners.delete(listener);
  }

  call<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<ModernRemoteResult<T>> {
    this.calls.push({ endpoint, args });
    this.timeline.push(endpoint);
    if (endpoint === "session/modelCatalog") {
      return Promise.resolve({ ok: true, value: catalogValue() } as ModernRemoteResult<T>);
    }
    if (endpoint === "session/list") {
      return Promise.resolve(this.sessionListResult as ModernRemoteResult<T>);
    }
    if (endpoint === "settings/describe") {
      return Promise.resolve({
        ok: true,
        value: settingsValue(this.permissionModesEnabled),
      } as ModernRemoteResult<T>);
    }
    if (endpoint === "session/create") {
      const request = args.request as { sessionId: string; agentPreset?: string };
      this.modelSelections.set(request.sessionId, null);
      if (this.permissionModesEnabled) {
        this.permissionSelections.set(request.sessionId, "workspace-write");
      }
      if (this.permissionModesEnabled) {
        this.control.push({
          type: "projection",
          sessionId: request.sessionId,
          key: "permissions",
          value: permissionProjection("workspace-write"),
          seq: 0,
        });
      }
      return Promise.resolve({
        ok: true,
        value: {
          sessionId: request.sessionId,
          ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
        },
      } as ModernRemoteResult<T>);
    }
    if (endpoint === "session/fork") {
      return (this.forkResponse ?? Promise.resolve(this.forkResult)) as Promise<
        ModernRemoteResult<T>
      >;
    }
    if (endpoint === "session/selectModel") {
      const request = args.request as {
        sessionId: string;
        provider: string;
        model: string;
        reasoningEffort?: string;
      };
      const selected = {
        provider: request.provider,
        model: request.model,
        ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
      };
      this.modelSelections.set(request.sessionId, selected);
      this.control.push({
        type: "projection",
        sessionId: request.sessionId,
        key: "modelSelection",
        value: { lastUsed: null, next: selected },
        seq: 1,
      });
      return Promise.resolve({ ok: true, value: { selected } } as ModernRemoteResult<T>);
    }
    if (endpoint === "commands/execute") {
      const request = args as { agentId: string; line: string };
      const permissionModeId = request.line.startsWith("/permission ")
        ? request.line.slice("/permission ".length)
        : undefined;
      if (!permissionModeId || !this.permissionModesEnabled) {
        return Promise.resolve({ ok: true, value: undefined } as ModernRemoteResult<T>);
      }
      this.permissionSelections.set(request.agentId, permissionModeId);
      this.control.push({
        type: "projection",
        sessionId: request.agentId,
        key: "permissions",
        value: permissionProjection(permissionModeId),
        seq: 1,
      });
      return Promise.resolve({
        ok: true,
        value: {
          commandId: `permission-${permissionModeId}`,
          result: { kind: "success", text: `preset ${permissionModeId}` },
        },
      } as ModernRemoteResult<T>);
    }
    if (endpoint === "session/cancel" && this.cancelResponse) {
      return this.cancelResponse as Promise<ModernRemoteResult<T>>;
    }
    if (endpoint === "session/prompt" || endpoint === "session/cancel") {
      return Promise.resolve({ ok: true, value: { accepted: true } } as ModernRemoteResult<T>);
    }
    if (endpoint === "$events/result") {
      return Promise.resolve({ ok: true, value: undefined } as ModernRemoteResult<T>);
    }
    return Promise.reject(new Error(`unexpected call: ${endpoint}`));
  }

  openStream<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): AsyncIterable<T> {
    this.streams.push({ endpoint, args });
    this.timeline.push(endpoint);
    if (endpoint === "session/control") return this.control as AsyncIterable<T>;
    if (endpoint === "$events") {
      const feed =
        this.eventOpenCount++ === 0 ? this.events : (this.replacementEvents.shift() ?? this.events);
      return feed as AsyncIterable<T>;
    }
    if (endpoint === "session/follow") {
      const request = args.request as {
        address: { sessionId: string };
      };
      const sessionId = request.address.sessionId;
      const failure = this.followFailureQueues.get(sessionId)?.shift();
      if (failure) throw failure;
      const feed = new Feed(() => {
        signal?.removeEventListener("abort", onAbort);
        this.timeline.push(`follow.return:${sessionId}`);
      });
      function onAbort(): void {
        void feed.return();
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      this.follows.set(sessionId, feed);
      if (this.autoOpenJournal) this.openJournal(sessionId, feed);
      return feed as AsyncIterable<T>;
    }
    throw new Error(`unexpected stream: ${endpoint}`);
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    this.timeline.push("connection.close");
    this.control.finish();
    this.events.finish();
    for (const feed of this.follows.values()) feed.finish();
    return this.closeError ? Promise.reject(this.closeError) : Promise.resolve();
  }

  openJournal(sessionId: string, feed = this.follows.get(sessionId)): void {
    if (!feed) throw new Error("missing follow feed");
    const follow = this.streams.findLast(({ endpoint, args }) => {
      if (endpoint !== "session/follow") return false;
      const request = args.request as { address: { sessionId: string } };
      return request.address.sessionId === sessionId;
    });
    const request = follow?.args.request as { address: { sessionId: string } } | undefined;
    if (!request) throw new Error("missing follow request");
    const cwd = this.expectedCwds.get(sessionId);
    const queued = this.journalSnapshotQueues.get(sessionId)?.shift();
    feed.push(
      queued ??
        this.journalSnapshots.get(sessionId) ??
        journalSnapshot(
          sessionId,
          cwd,
          this.modelSelections.get(sessionId) ?? null,
          this.permissionModesEnabled ? this.permissionSelections.get(sessionId) : undefined,
          this.validUnattendedFacts,
        ),
    );
  }

  readonly expectedCwds = new Map<string, string>();

  fault(error: ModernRemoteConnectionError): void {
    for (const listener of this.faultListeners) listener(error);
  }

  queueEventReplacement(clientId: string): Feed {
    const feed = new Feed(() => this.timeline.push("events.return"));
    feed.push({
      type: "ready",
      clientId,
      host: { home: String.raw`C:\Users\fixture` },
    });
    this.replacementEvents.push(feed);
    return feed;
  }
}

function settingsValue(withPermissions = false): Record<string, unknown> {
  if (!withPermissions) return { writable: true, hasDocument: true, namespaces: [] };
  const choices = ["workspace-write", "danger-full-access"].map((id) => Schema.const(id));
  return {
    writable: true,
    hasDocument: true,
    namespaces: [
      {
        ns: "permission",
        schema: JSON.parse(
          JSON.stringify(
            Schema.object({ defaultPreset: Schema.union(choices).required() }).toJSON(),
          ),
        ),
        value: { defaultPreset: "workspace-write" },
        base: { defaultPreset: "workspace-write" },
        user: {},
        applies: "live",
        secrets: [],
        revision: 0,
      },
    ],
  };
}

function permissionProjection(currentValue: string): Record<string, unknown> {
  return {
    options: ["workspace-write", "danger-full-access"].map((value) => ({
      value,
      name: value,
    })),
    currentValue,
  };
}

function catalogValue(): Record<string, unknown> {
  return {
    default: { provider: "provider", model: "model", reasoningEffort: "high" },
    routableProviders: ["provider"],
    groups: [
      {
        id: "provider",
        name: "Provider",
        models: [
          {
            id: "model",
            name: "Model",
            reasoning: {
              efforts: [{ id: "high", name: "High" }],
              defaultEffort: "high",
            },
          },
        ],
      },
    ],
    failures: [],
  };
}

function controlBaseline(): Record<string, unknown> {
  return {
    type: "baseline",
    value: { queues: {}, jobs: {}, projections: {} },
  };
}

function journalSnapshot(
  sessionId: string,
  cwd: string | undefined,
  selection: Record<string, string> | null,
  permissionModeId: string | undefined,
  validUnattendedFacts: boolean,
): Record<string, unknown> {
  const events: Array<{ type: string; seq: number; time: number; data: Record<string, unknown> }> =
    [{ type: "agent-preset/selected", seq: 0, time: 1, data: { agentPreset: "standard" } }];
  if (permissionModeId) {
    events.push(
      {
        type: "permission/preset",
        seq: events.length,
        time: events.length + 1,
        data: { preset: permissionModeId },
      },
      {
        type: "sandbox/mode",
        seq: events.length + 1,
        time: events.length + 2,
        data: { mode: permissionModeId },
      },
      {
        type: "approval/policy",
        seq: events.length + 2,
        time: events.length + 3,
        data: {
          policy:
            permissionModeId === "danger-full-access" && validUnattendedFacts ? "never" : "ask",
        },
      },
    );
  }
  if (selection) {
    events.push({
      type: "model/selection",
      seq: events.length,
      time: events.length + 1,
      data: selection,
    });
  }
  const cursor = events.length - 1;
  return {
    type: "snapshot",
    header: {
      version: 0,
      id: sessionId,
      createdAt: 1,
      ...(cwd === undefined ? {} : { cwd }),
    },
    cursor,
    records: events.map((event) => ({ type: "event", event })),
    hasMore: false,
    projections: {
      asOfSeq: cursor,
      values: {
        modelSelection: { lastUsed: null, next: selection },
        ...(permissionModeId ? { permissions: permissionProjection(permissionModeId) } : {}),
      },
    },
  };
}

function exactJournalSnapshot(input: {
  readonly sessionId: string;
  readonly cwd: string;
  readonly events: readonly Record<string, unknown>[];
  readonly parentSession?: string;
  readonly seedLength?: number;
  readonly headerAgentPreset?: string;
  readonly agentPreset?: string | null;
}): Record<string, unknown> {
  const cursor = input.events.length - 1;
  return {
    type: "snapshot",
    header: {
      version: 0,
      id: input.sessionId,
      createdAt: 1,
      cwd: input.cwd,
      ...(input.parentSession ? { parentSession: input.parentSession } : {}),
      ...(input.seedLength === undefined ? {} : { seedLength: input.seedLength }),
      ...(input.headerAgentPreset === undefined ? {} : { agentPreset: input.headerAgentPreset }),
    },
    cursor,
    records: input.events.map((event) => ({ type: "event", event })),
    hasMore: false,
    projections: {
      asOfSeq: cursor,
      values: {
        modelSelection: { lastUsed: null, next: null },
        ...(input.agentPreset === undefined ? {} : { agentPreset: input.agentPreset }),
      },
    },
  };
}

function exactJournalEvent(
  seq: number,
  type: string,
  data: Readonly<Record<string, unknown>>,
  surface = false,
): Record<string, unknown> {
  return {
    type,
    seq,
    time: seq + 10,
    data,
    ...(surface ? { surfaceOp: "append" } : {}),
  };
}

function forkRefs(sourceSessionId: string, seq: number) {
  return {
    sourceRef: nativeSessionRefSchema.parse({
      harnessId: "deepseek-harness",
      nativeSessionId: sourceSessionId,
      formatVersion: 1,
    }),
    checkpoint: nativeCheckpointRefSchema.parse({
      harnessId: "deepseek-harness",
      nativeSessionId: sourceSessionId,
      checkpointId: `turn-end:${seq}`,
      formatVersion: 1,
    }),
  };
}

function forkSourceEvents(): Record<string, unknown>[] {
  return [
    exactJournalEvent(0, "turn/start", { turn: 1 }),
    exactJournalEvent(
      1,
      "user/message",
      {
        id: "source-user-1",
        role: "user",
        content: [{ type: "text", text: "first" }],
        source: { kind: "user" },
      },
      true,
    ),
    exactJournalEvent(2, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    exactJournalEvent(3, "model/selection", {
      provider: "provider",
      model: "model",
      reasoningEffort: "high",
    }),
    exactJournalEvent(4, "permission/preset", { preset: "workspace-write" }),
    exactJournalEvent(5, "turn/start", { turn: 2 }),
    exactJournalEvent(
      6,
      "user/message",
      {
        id: "source-user-2",
        role: "user",
        content: [{ type: "text", text: "still running" }],
        source: { kind: "user" },
      },
      true,
    ),
  ];
}

function liveEvent(
  seq: number,
  type: string,
  data: Readonly<Record<string, unknown>>,
  surface = false,
): Record<string, unknown> {
  return {
    type: "event",
    event: { type, seq, time: seq + 10, data, ...(surface ? { surfaceOp: "append" } : {}) },
  };
}

function setup(
  uuids = ["created"],
  adapterOptions: Partial<ConstructorParameters<typeof ModernDeepSeekHarnessAdapter>[0]> = {},
): {
  readonly adapter: ModernDeepSeekHarnessAdapter;
  readonly connection: FakeConnection;
} {
  const connection = new FakeConnection();
  const values = [...uuids];
  const adapter = new ModernDeepSeekHarnessAdapter(
    { command: "dsh", ...adapterOptions },
    {
      randomUUID: () => values.shift() ?? "fallback",
      now: () => 1_000,
      createConnection: () => connection,
    },
  );
  return { adapter, connection };
}

describe("Modern DeepSeek Harness Adapter", () => {
  it("lists exact Modern Session candidates through the managed connection", async () => {
    const { adapter, connection } = setup();
    const sessionCwd = path.resolve("fixture-session-import");
    connection.sessionListResult = {
      ok: true,
      value: {
        items: [
          {
            sessionId: "native-session",
            updatedAt: 42,
            running: false,
            blank: false,
            cwd: sessionCwd,
          },
        ],
      },
    };

    await expect(adapter.sessionImport.listCandidates()).resolves.toEqual({
      ok: true,
      value: [
        {
          nativeSessionId: "native-session",
          title: null,
          updatedAt: 42,
          cwd: sessionCwd,
          running: false,
        },
      ],
    });
    expect(connection.calls).toContainEqual({ endpoint: "session/list", args: { _request: {} } });
    await adapter.close();
    await expect(adapter.sessionImport.listCandidates()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
  });

  it("advertises and opens Web only when the Host provides a local handoff", async () => {
    const enabled = setup([], { openWebUi: () => Promise.resolve() });
    await expect(enabled.adapter.inspect()).resolves.toMatchObject({
      status: "ready",
      webUi: { open: true },
    });
    await expect(enabled.adapter.webUi?.open()).resolves.toEqual({ ok: true, value: undefined });
    expect(enabled.connection.openWebUi).toHaveBeenCalledOnce();
    await enabled.adapter.close();
    await expect(enabled.adapter.webUi?.open()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    expect(enabled.connection.openWebUi).toHaveBeenCalledOnce();

    const disabled = setup();
    await expect(disabled.adapter.inspect()).resolves.not.toHaveProperty("webUi");
    expect(disabled.adapter.webUi).toBeUndefined();
    await disabled.adapter.close();
  });

  it("passes the accepted prompt correlation timeout to each Session", async () => {
    vi.useFakeTimers();
    const { adapter, connection } = setup(["created", "request-timeout"], {
      promptCorrelationGraceMs: 500,
      acceptedCorrelationTimeoutMs: 50,
    });
    try {
      const cwd = path.resolve("fixture-prompt-correlation-timeout");
      connection.expectedCwds.set("session-created", cwd);
      const opened = await adapter.open({ kind: "create", cwd });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const outputs = opened.value.outputs[Symbol.asyncIterator]();

      await expect(
        opened.value.execute({
          type: "turn.start",
          turnId: "host-turn-correlation-timeout" as never,
          input: [{ type: "text", text: "queued" }],
        }),
      ).resolves.toMatchObject({ ok: true });
      await vi.advanceTimersByTimeAsync(49);
      await expect(
        opened.value.execute({
          type: "turn.start",
          turnId: "host-turn-still-pending" as never,
          input: [{ type: "text", text: "still pending" }],
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });

      await vi.advanceTimersByTimeAsync(1);
      await expect(outputs.next()).resolves.toMatchObject({
        value: {
          kind: "event",
          event: {
            type: "turn.completed",
            turnId: "host-turn-correlation-timeout",
            outcome: { status: "failed", error: { code: "protocolError" } },
          },
        },
      });
      await expect(outputs.next()).resolves.toMatchObject({
        value: { kind: "event", event: { type: "session.faulted" } },
      });
    } finally {
      await adapter.close();
      vi.useRealTimers();
    }
  });

  it("queues an early approval for its materialized Host Turn and settles it once", async () => {
    const { adapter, connection } = setup(["created", "request-1", "interaction-1"]);
    const cwd = path.resolve("fixture-interaction");
    connection.expectedCwds.set("session-created", cwd);
    const opened = await adapter.open({ kind: "create", cwd });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const outputs = opened.value.outputs[Symbol.asyncIterator]();

    await expect(
      opened.value.execute({
        type: "turn.start",
        turnId: "host-turn-1" as never,
        input: [{ type: "text", text: "write" }],
      }),
    ).resolves.toEqual({ ok: true, value: { turnId: "host-turn-1" } });
    connection.events.push({
      type: "waterfall",
      event: "approval/request",
      eventId: "approval-1",
      agentId: "session-created",
      request: { toolName: "shell", callId: "call-1", reason: "write workspace" },
    });
    await Promise.resolve();
    const follow = connection.follows.get("session-created");
    if (!follow) throw new Error("missing follow feed");
    follow.push(liveEvent(1, "turn/start", { turn: 1 }));
    follow.push(
      liveEvent(
        2,
        "user/message",
        {
          id: "user-1",
          role: "user",
          content: [{ type: "text", text: "write" }],
          source: { kind: "user", rpcId: "request-1" },
        },
        true,
      ),
    );

    await expect(outputs.next()).resolves.toMatchObject({
      value: { kind: "event", event: { type: "turn.started", turnId: "host-turn-1" } },
    });
    const requested = await outputs.next();
    expect(requested.value).toMatchObject({
      kind: "interaction",
      interaction: {
        type: "approval",
        interactionId: "interaction-1",
        turnId: "host-turn-1",
        title: "write workspace",
      },
    });
    await expect(
      opened.value.execute({
        type: "interaction.respond",
        interactionId: "interaction-1" as never,
        response: { type: "approval", actionId: "allow-once" },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(connection.calls).toContainEqual({
      endpoint: "$events/result",
      args: {
        clientId: "client-1",
        eventId: "approval-1",
        outcome: { kind: "result", value: "allowed-once" },
      },
    });
    await expect(outputs.next()).resolves.toMatchObject({
      value: {
        kind: "event",
        event: { type: "interaction.closed", interactionId: "interaction-1", reason: "responded" },
      },
    });
    await opened.value.close();
    await adapter.close();
  });

  it("sends next before Session close retires a pending interaction and Turn", async () => {
    const { adapter, connection } = setup(["created", "request-close", "interaction-close"]);
    const cwd = path.resolve("fixture-interaction-close");
    connection.expectedCwds.set("session-created", cwd);
    const opened = await adapter.open({ kind: "create", cwd });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const outputs = opened.value.outputs[Symbol.asyncIterator]();
    await opened.value.execute({
      type: "turn.start",
      turnId: "host-turn-close" as never,
      input: [{ type: "text", text: "write" }],
    });
    const follow = connection.follows.get("session-created");
    if (!follow) throw new Error("missing follow feed");
    follow.push(liveEvent(1, "turn/start", { turn: 1 }));
    follow.push(
      liveEvent(
        2,
        "user/message",
        {
          id: "user-close",
          role: "user",
          content: [{ type: "text", text: "write" }],
          source: { kind: "user", rpcId: "request-close" },
        },
        true,
      ),
    );
    await outputs.next();
    connection.events.push({
      type: "waterfall",
      event: "approval/request",
      eventId: "approval-close",
      agentId: "session-created",
      request: { toolName: "shell" },
    });
    await expect(outputs.next()).resolves.toMatchObject({
      value: {
        kind: "interaction",
        interaction: { interactionId: "interaction-close", turnId: "host-turn-close" },
      },
    });

    await opened.value.close();
    expect(connection.calls).toContainEqual({
      endpoint: "$events/result",
      args: {
        clientId: "client-1",
        eventId: "approval-close",
        outcome: { kind: "next" },
      },
    });
    await expect(outputs.next()).resolves.toMatchObject({
      value: {
        kind: "event",
        event: {
          type: "interaction.closed",
          interactionId: "interaction-close",
          reason: "cancelled",
        },
      },
    });
    await expect(outputs.next()).resolves.toMatchObject({
      value: {
        kind: "event",
        event: { type: "turn.completed", turnId: "host-turn-close" },
      },
    });
    await adapter.close();
  });

  it("rebinds a pending interaction to one replacement event generation without republishing", async () => {
    const { adapter, connection } = setup(["created", "request-replace", "interaction-replace"]);
    const replacement = connection.queueEventReplacement("client-2");
    const cwd = path.resolve("fixture-interaction-replace");
    connection.expectedCwds.set("session-created", cwd);
    const opened = await adapter.open({ kind: "create", cwd });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const outputs = opened.value.outputs[Symbol.asyncIterator]();
    await opened.value.execute({
      type: "turn.start",
      turnId: "host-turn-replace" as never,
      input: [{ type: "text", text: "write" }],
    });
    const follow = connection.follows.get("session-created");
    if (!follow) throw new Error("missing follow feed");
    follow.push(liveEvent(1, "turn/start", { turn: 1 }));
    follow.push(
      liveEvent(
        2,
        "user/message",
        {
          id: "user-replace",
          role: "user",
          content: [{ type: "text", text: "write" }],
          source: { kind: "user", rpcId: "request-replace" },
        },
        true,
      ),
    );
    await outputs.next();
    const frame = {
      type: "waterfall",
      event: "approval/request",
      eventId: "approval-replace",
      agentId: "session-created",
      request: { toolName: "shell" },
    };
    connection.events.push(frame);
    await expect(outputs.next()).resolves.toMatchObject({
      value: {
        kind: "interaction",
        interaction: { interactionId: "interaction-replace" },
      },
    });

    connection.events.finish();
    await vi.waitFor(() =>
      expect(connection.streams.filter(({ endpoint }) => endpoint === "$events")).toHaveLength(2),
    );
    replacement.push(frame);
    await expect(
      opened.value.execute({
        type: "interaction.respond",
        interactionId: "interaction-replace" as never,
        response: { type: "approval", actionId: "allow-once" },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(connection.calls).toContainEqual({
      endpoint: "$events/result",
      args: {
        clientId: "client-2",
        eventId: "approval-replace",
        outcome: { kind: "result", value: "allowed-once" },
      },
    });
    await expect(outputs.next()).resolves.toMatchObject({
      value: {
        kind: "event",
        event: { type: "interaction.closed", interactionId: "interaction-replace" },
      },
    });
    await opened.value.close();
    await adapter.close();
  });

  it("creates a Session, then attaches and starts the Adapter event gateway", async () => {
    const { adapter, connection } = setup(["created"]);
    const cwd = path.resolve("fixture-create");
    connection.expectedCwds.set("session-created", cwd);

    const opened = await adapter.open({ kind: "create", cwd });

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.initialState.nativeRef).toEqual({
      harnessId: "deepseek-harness",
      nativeSessionId: "session-created",
      formatVersion: 1,
    });
    expect(connection.calls.slice(0, 3)).toEqual([
      { endpoint: "session/modelCatalog", args: {} },
      { endpoint: "settings/describe", args: {} },
      {
        endpoint: "session/create",
        args: { request: { sessionId: "session-created", cwd } },
      },
    ]);
    expect(connection.streams.map(({ endpoint }) => endpoint)).toEqual([
      "session/control",
      "session/follow",
      "$events",
    ]);
    expect(connection.timeline).toEqual([
      "connect",
      "session/modelCatalog",
      "settings/describe",
      "session/control",
      "session/create",
      "session/follow",
      "$events",
    ]);
    await opened.value.close();
    await adapter.close();
  });

  it("bounds the first Session follow when its opening snapshot never arrives", async () => {
    const { adapter, connection } = setup(["created"], { recoveryOpenTimeoutMs: 10 });
    const cwd = path.resolve("fixture-first-follow-timeout");
    connection.expectedCwds.set("session-created", cwd);
    connection.autoOpenJournal = false;

    await expect(adapter.open({ kind: "create", cwd })).resolves.toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    expect(connection.follows.get("session-created")?.returnCalls).toBe(1);
    await adapter.close();
  });

  it("repairs one ended follow from an exact raw prefix, applies its suffix, and switches live", async () => {
    const { adapter, connection } = setup(["created", "repair-request", "repair-turn-2"]);
    const sessionId = "session-created";
    const cwd = path.resolve("fixture-follow-repair");
    connection.permissionModesEnabled = true;
    connection.expectedCwds.set(sessionId, cwd);
    const initial = journalSnapshot(sessionId, cwd, null, "workspace-write", true);
    const initialEvents = (initial.records as Record<string, unknown>[]).map((record) =>
      structuredClone(record.event as Record<string, unknown>),
    );
    const permissionSeq = initialEvents.length;
    const turnStartSeq = permissionSeq + 1;
    const stepStartSeq = turnStartSeq + 1;
    const userSeq = stepStartSeq + 1;
    const stepEndSeq = userSeq + 1;
    const turnEndSeq = stepEndSeq + 1;
    const replacement = exactJournalSnapshot({
      sessionId,
      cwd,
      events: [
        ...initialEvents,
        exactJournalEvent(permissionSeq, "permission/preset", { preset: "danger-full-access" }),
        exactJournalEvent(turnStartSeq, "turn/start", { turn: 1 }),
        exactJournalEvent(stepStartSeq, "step/start", { turn: 1, step: 1 }),
        exactJournalEvent(
          userSeq,
          "user/message",
          {
            id: "repair-user-1",
            role: "user",
            content: [{ type: "text", text: "repaired" }],
            source: { kind: "user", rpcId: "repair-request" },
          },
          true,
        ),
        exactJournalEvent(stepEndSeq, "step/end", { turn: 1, step: 1 }),
        exactJournalEvent(turnEndSeq, "turn/end", {
          turn: 1,
          reason: { kind: "completed" },
        }),
      ],
    });
    (replacement.projections as Record<string, unknown>).values = {
      modelSelection: { lastUsed: null, next: null },
      permissions: permissionProjection("danger-full-access"),
    };
    connection.journalSnapshotQueues.set(sessionId, [initial, replacement]);

    const opened = await adapter.open({ kind: "create", cwd });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const outputs = opened.value.outputs[Symbol.asyncIterator]();
    await expect(
      opened.value.execute({
        type: "turn.start",
        turnId: "repair-host-turn" as never,
        input: [{ type: "text", text: "repair this" }],
      }),
    ).resolves.toEqual({ ok: true, value: { turnId: "repair-host-turn" } });
    const first = connection.follows.get(sessionId);
    if (!first) throw new Error("missing initial follow");
    first.push(liveEvent(permissionSeq, "permission/preset", { preset: "danger-full-access" }));
    first.push(liveEvent(turnStartSeq, "turn/start", { turn: 1 }));
    first.push(liveEvent(stepStartSeq, "step/start", { turn: 1, step: 1 }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    first.finish();

    await vi.waitFor(() =>
      expect(
        connection.streams.filter(({ endpoint }) => endpoint === "session/follow"),
      ).toHaveLength(2),
    );
    await vi.waitFor(async () => {
      const snapshot = await opened.value.readSnapshot();
      expect(snapshot).toMatchObject({
        ok: true,
        value: {
          turns: [
            {
              input: [{ type: "text", text: "repaired" }],
              checkpoint: { checkpointId: `turn-end:${String(turnEndSeq)}` },
            },
          ],
          state: { effectivePermissionModeId: "danger-full-access" },
        },
      });
    });

    const repairedEvents: Record<string, unknown>[] = [];
    for (;;) {
      const next = await outputs.next();
      expect(next.done).toBe(false);
      if (next.value?.kind !== "event") continue;
      repairedEvents.push(next.value.event as unknown as Record<string, unknown>);
      if (next.value.event.type === "turn.completed") break;
    }
    expect(repairedEvents).toContainEqual(
      expect.objectContaining({ type: "turn.started", turnId: "repair-host-turn" }),
    );
    expect(repairedEvents.some(({ type }) => type === "turn.autonomous.started")).toBe(false);

    const repaired = connection.follows.get(sessionId);
    if (!repaired || repaired === first) throw new Error("missing replacement follow");
    const nextSeq = turnEndSeq + 1;
    repaired.push(liveEvent(nextSeq, "turn/start", { turn: 2 }));
    repaired.push(
      liveEvent(
        nextSeq + 1,
        "user/message",
        {
          id: "repair-user-2",
          role: "user",
          content: [{ type: "text", text: "after repair" }],
          source: { kind: "user" },
        },
        true,
      ),
    );
    repaired.push(liveEvent(nextSeq + 2, "turn/end", { turn: 2, reason: { kind: "completed" } }));
    await vi.waitFor(async () => {
      const snapshot = await opened.value.readSnapshot();
      expect(snapshot).toMatchObject({
        ok: true,
        value: {
          turns: [{ input: [{ text: "repaired" }] }, { input: [{ text: "after repair" }] }],
        },
      });
    });
    expect(first.returnCalls).toBe(1);
    await opened.value.close();
    await adapter.close();
  });

  it.each(["header", "prefix", "behind", "gap"] as const)(
    "faults when a replacement follow has a conflicting %s",
    async (kind) => {
      const { adapter, connection } = setup();
      const sessionId = "session-created";
      const cwd = path.resolve(`fixture-follow-${kind}`);
      connection.expectedCwds.set(sessionId, cwd);
      const initial = journalSnapshot(sessionId, cwd, null, undefined, true);
      const initialEvent = structuredClone(
        ((initial.records as Record<string, unknown>[])[0] as Record<string, unknown>)
          .event as Record<string, unknown>,
      );
      let replacement = exactJournalSnapshot({ sessionId, cwd, events: [initialEvent] });
      if (kind === "header") {
        (replacement.header as Record<string, unknown>).createdAt = 2;
      } else if (kind === "prefix") {
        (initialEvent.data as Record<string, unknown>).agentPreset = "changed";
      } else if (kind === "behind") {
        replacement = exactJournalSnapshot({ sessionId, cwd, events: [] });
      } else {
        replacement = exactJournalSnapshot({
          sessionId,
          cwd,
          events: [
            initialEvent,
            exactJournalEvent(2, "model/selection", { provider: "provider", model: "model" }),
          ],
        });
      }
      connection.journalSnapshotQueues.set(sessionId, [initial, replacement]);

      const opened = await adapter.open({ kind: "create", cwd });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const outputs = opened.value.outputs[Symbol.asyncIterator]();
      const first = connection.follows.get(sessionId);
      if (!first) throw new Error("missing initial follow");
      first.finish();

      await expect(outputs.next()).resolves.toMatchObject({
        value: {
          kind: "event",
          event: { type: "session.faulted", error: { code: "protocolError" } },
        },
      });
      expect(
        connection.streams.filter(({ endpoint }) => endpoint === "session/follow"),
      ).toHaveLength(2);
      await adapter.close();
    },
  );

  it("faults after a second normally-ended follow without opening a third generation", async () => {
    const { adapter, connection } = setup();
    const sessionId = "session-created";
    const cwd = path.resolve("fixture-follow-second-loss");
    connection.expectedCwds.set(sessionId, cwd);
    const initial = journalSnapshot(sessionId, cwd, null, undefined, true);
    connection.journalSnapshotQueues.set(sessionId, [initial, structuredClone(initial)]);
    const opened = await adapter.open({ kind: "create", cwd });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const outputs = opened.value.outputs[Symbol.asyncIterator]();
    const first = connection.follows.get(sessionId);
    if (!first) throw new Error("missing initial follow");
    first.finish();
    await vi.waitFor(() =>
      expect(
        connection.streams.filter(({ endpoint }) => endpoint === "session/follow"),
      ).toHaveLength(2),
    );
    const second = connection.follows.get(sessionId);
    if (!second || second === first) throw new Error("missing replacement follow");
    second.finish();

    await expect(outputs.next()).resolves.toMatchObject({
      value: {
        kind: "event",
        event: { type: "session.faulted", error: { code: "unavailable" } },
      },
    });
    expect(connection.streams.filter(({ endpoint }) => endpoint === "session/follow")).toHaveLength(
      2,
    );
    await adapter.close();
  });

  it("aborts and closes a replacement follow that is still waiting for its snapshot", async () => {
    const { adapter, connection } = setup();
    const sessionId = "session-created";
    const cwd = path.resolve("fixture-follow-close-race");
    connection.expectedCwds.set(sessionId, cwd);
    const opened = await adapter.open({ kind: "create", cwd });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const outputs = opened.value.outputs[Symbol.asyncIterator]();
    const first = connection.follows.get(sessionId);
    if (!first) throw new Error("missing initial follow");
    connection.autoOpenJournal = false;
    first.finish();
    await vi.waitFor(() =>
      expect(
        connection.streams.filter(({ endpoint }) => endpoint === "session/follow"),
      ).toHaveLength(2),
    );
    const replacement = connection.follows.get(sessionId);
    if (!replacement || replacement === first) throw new Error("missing replacement follow");

    await expect(opened.value.close()).resolves.toBeUndefined();
    await expect(outputs.next()).resolves.toEqual({ done: true, value: undefined });
    expect(replacement.returnCalls).toBe(1);
    await adapter.close();
  });

  it("faults when a replacement follow never emits its opening snapshot", async () => {
    const { adapter, connection } = setup(["created"], { recoveryOpenTimeoutMs: 10 });
    const sessionId = "session-created";
    const cwd = path.resolve("fixture-follow-recovery-timeout");
    connection.expectedCwds.set(sessionId, cwd);
    const opened = await adapter.open({ kind: "create", cwd });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const outputs = opened.value.outputs[Symbol.asyncIterator]();
    const first = connection.follows.get(sessionId);
    if (!first) throw new Error("missing initial follow");
    connection.autoOpenJournal = false;
    first.finish();
    await vi.waitFor(() =>
      expect(
        connection.streams.filter(({ endpoint }) => endpoint === "session/follow"),
      ).toHaveLength(2),
    );

    await expect(outputs.next()).resolves.toMatchObject({
      value: {
        kind: "event",
        event: { type: "session.faulted", error: { code: "unavailable" } },
      },
    });
    await adapter.close();
  });

  it("forks one exact completed prefix and verifies the child journal", async () => {
    const { adapter, connection } = setup();
    const cwd = path.resolve("fixture-fork");
    const sourceSessionId = "session-source";
    const sourceEvents = forkSourceEvents();
    const inherited = sourceEvents.slice(0, 5);
    const childEvents = [
      ...inherited,
      exactJournalEvent(5, "session/end-seed", {}),
      exactJournalEvent(6, "sandbox/mode", { mode: "workspace-write" }),
    ];
    const sourceSnapshot = exactJournalSnapshot({
      sessionId: sourceSessionId,
      cwd,
      events: sourceEvents,
    });
    connection.journalSnapshots.set(sourceSessionId, sourceSnapshot);
    connection.journalSnapshots.set(
      "session-forked",
      exactJournalSnapshot({
        sessionId: "session-forked",
        cwd,
        parentSession: sourceSessionId,
        seedLength: inherited.length,
        events: childEvents,
      }),
    );

    const opened = await adapter.open({
      kind: "fork",
      ...forkRefs(sourceSessionId, 2),
      cwd,
    });

    expect(opened.ok).toBe(true);
    expect(connection.calls).toContainEqual({
      endpoint: "session/fork",
      args: { request: { sessionId: sourceSessionId, atSeq: 2 } },
    });
    expect(connection.calls.filter(({ endpoint }) => endpoint === "session/fork")).toHaveLength(1);
    expect(connection.journalSnapshots.get(sourceSessionId)).toBe(sourceSnapshot);
    expect(connection.follows.get(sourceSessionId)?.returnCalls).toBe(1);
    if (opened.ok) {
      expect(opened.value.capabilities.history).toEqual({
        fork: true,
        forkAcrossCwd: false,
        rollbackLastTurn: true,
      });
      expect(opened.value.initialState.nativeRef?.nativeSessionId).toBe("session-forked");
      const snapshot = await opened.value.readSnapshot();
      expect(snapshot).toMatchObject({
        ok: true,
        value: {
          turns: [
            {
              nativeTurnRef: {
                nativeSessionId: "session-forked",
                nativeTurnKey: "turn:1",
              },
              checkpoint: {
                nativeSessionId: "session-forked",
                checkpointId: "turn-end:2",
              },
              input: [{ type: "text", text: "first" }],
            },
          ],
        },
      });
      await opened.value.close();
    }
    await adapter.close();
  });

  it("rolls back a multi-Turn Session through the penultimate native checkpoint", async () => {
    const { adapter, connection } = setup();
    const cwd = path.resolve("fixture-rollback-fork");
    const sourceSessionId = "session-rollback-source";
    const sourceEvents = [
      ...forkSourceEvents(),
      exactJournalEvent(7, "turn/end", { turn: 2, reason: { kind: "completed" } }),
    ];
    const inherited = sourceEvents.slice(0, 5);
    const sourceSnapshot = exactJournalSnapshot({
      sessionId: sourceSessionId,
      cwd,
      headerAgentPreset: "minimal",
      agentPreset: "minimal",
      events: sourceEvents,
    });
    connection.journalSnapshots.set(sourceSessionId, sourceSnapshot);
    connection.journalSnapshots.set(
      "session-forked",
      exactJournalSnapshot({
        sessionId: "session-forked",
        cwd,
        parentSession: sourceSessionId,
        seedLength: inherited.length,
        headerAgentPreset: "minimal",
        agentPreset: "minimal",
        events: [...inherited, exactJournalEvent(5, "session/end-seed", {})],
      }),
    );

    const opened = await adapter.open({
      kind: "rollbackLastTurn",
      sourceRef: forkRefs(sourceSessionId, 2).sourceRef,
      cwd,
    });

    expect(opened.ok).toBe(true);
    expect(connection.calls).toContainEqual({
      endpoint: "session/fork",
      args: { request: { sessionId: sourceSessionId, atSeq: 2 } },
    });
    expect(connection.calls.some(({ endpoint }) => endpoint === "session/create")).toBe(false);
    expect(connection.journalSnapshots.get(sourceSessionId)).toBe(sourceSnapshot);
    if (opened.ok) {
      await expect(opened.value.readSnapshot()).resolves.toMatchObject({
        ok: true,
        value: {
          turns: [{ nativeTurnRef: { nativeSessionId: "session-forked" } }],
        },
      });
      await opened.value.close();
    }
    await adapter.close();
  });

  it("rolls back a single-Turn Session by creating an empty Session with its current Agent Preset", async () => {
    const { adapter, connection } = setup(["rollback-empty"]);
    const cwd = path.resolve("fixture-rollback-create");
    const sourceSessionId = "session-single-turn";
    const sourceSnapshot = exactJournalSnapshot({
      sessionId: sourceSessionId,
      cwd,
      headerAgentPreset: "standard",
      agentPreset: "minimal",
      events: [
        exactJournalEvent(0, "agent-preset/selected", { agentPreset: "minimal" }),
        exactJournalEvent(1, "turn/start", { turn: 1 }),
        exactJournalEvent(2, "turn/end", { turn: 1, reason: { kind: "completed" } }),
      ],
    });
    connection.journalSnapshots.set(sourceSessionId, sourceSnapshot);
    connection.journalSnapshots.set(
      "session-rollback-empty",
      exactJournalSnapshot({
        sessionId: "session-rollback-empty",
        cwd,
        headerAgentPreset: "minimal",
        agentPreset: "minimal",
        events: [],
      }),
    );

    const opened = await adapter.open({
      kind: "rollbackLastTurn",
      sourceRef: forkRefs(sourceSessionId, 2).sourceRef,
      cwd,
    });

    expect(opened.ok).toBe(true);
    expect(connection.calls).toContainEqual({
      endpoint: "session/create",
      args: {
        request: {
          sessionId: "session-rollback-empty",
          cwd,
          agentPreset: "minimal",
        },
      },
    });
    expect(connection.calls.some(({ endpoint }) => endpoint === "session/fork")).toBe(false);
    expect(connection.journalSnapshots.get(sourceSessionId)).toBe(sourceSnapshot);
    if (opened.ok) {
      expect(opened.value.initialState.nativeRef?.nativeSessionId).toBe("session-rollback-empty");
      await expect(opened.value.readSnapshot()).resolves.toMatchObject({
        ok: true,
        value: { turns: [] },
      });
      await opened.value.close();
    }
    await adapter.close();
  });

  it("fails closed when a multi-Turn Fork changes the current Agent Preset", async () => {
    const { adapter, connection } = setup();
    const cwd = path.resolve("fixture-rollback-fork-preset");
    const sourceSessionId = "session-rollback-preset-source";
    const sourceEvents = [
      ...forkSourceEvents(),
      exactJournalEvent(7, "turn/end", { turn: 2, reason: { kind: "completed" } }),
    ];
    const inherited = sourceEvents.slice(0, 5);
    connection.journalSnapshots.set(
      sourceSessionId,
      exactJournalSnapshot({
        sessionId: sourceSessionId,
        cwd,
        headerAgentPreset: "minimal",
        agentPreset: "minimal",
        events: sourceEvents,
      }),
    );
    connection.journalSnapshots.set(
      "session-forked",
      exactJournalSnapshot({
        sessionId: "session-forked",
        cwd,
        parentSession: sourceSessionId,
        seedLength: inherited.length,
        headerAgentPreset: "standard",
        agentPreset: "standard",
        events: [...inherited, exactJournalEvent(5, "session/end-seed", {})],
      }),
    );

    await expect(
      adapter.open({
        kind: "rollbackLastTurn",
        sourceRef: forkRefs(sourceSessionId, 2).sourceRef,
        cwd,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "protocolError" } });
    await adapter.close();
  });

  it("fails closed when a single-Turn replacement is not empty", async () => {
    const { adapter, connection } = setup(["rollback-not-empty"]);
    const cwd = path.resolve("fixture-rollback-not-empty");
    const sourceSessionId = "session-single-turn-nonempty-child";
    const completedTurn = [
      exactJournalEvent(0, "turn/start", { turn: 1 }),
      exactJournalEvent(1, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ];
    connection.journalSnapshots.set(
      sourceSessionId,
      exactJournalSnapshot({
        sessionId: sourceSessionId,
        cwd,
        agentPreset: "standard",
        events: completedTurn,
      }),
    );
    connection.journalSnapshots.set(
      "session-rollback-not-empty",
      exactJournalSnapshot({
        sessionId: "session-rollback-not-empty",
        cwd,
        agentPreset: "standard",
        events: completedTurn,
      }),
    );

    await expect(
      adapter.open({
        kind: "rollbackLastTurn",
        sourceRef: forkRefs(sourceSessionId, 1).sourceRef,
        cwd,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "protocolError" } });
    await adapter.close();
  });

  it("rejects a single-Turn rollback when the generated Session ID matches the source", async () => {
    const { adapter, connection } = setup(["rollback-collision"]);
    const cwd = path.resolve("fixture-rollback-collision");
    const sourceSessionId = "session-rollback-collision";
    connection.journalSnapshots.set(
      sourceSessionId,
      exactJournalSnapshot({
        sessionId: sourceSessionId,
        cwd,
        agentPreset: "standard",
        events: [
          exactJournalEvent(0, "turn/start", { turn: 1 }),
          exactJournalEvent(1, "turn/end", { turn: 1, reason: { kind: "completed" } }),
        ],
      }),
    );

    await expect(
      adapter.open({
        kind: "rollbackLastTurn",
        sourceRef: forkRefs(sourceSessionId, 1).sourceRef,
        cwd,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(connection.calls.some(({ endpoint }) => endpoint === "session/create")).toBe(false);
    await adapter.close();
  });

  it("rejects empty, active, missing-preset, and malformed-preset rollback sources before mutation", async () => {
    const cwd = path.resolve("fixture-rollback-rejected");
    const cases: Array<{
      readonly name: string;
      readonly events: readonly Record<string, unknown>[];
      readonly agentPreset?: unknown;
      readonly code: string;
    }> = [
      { name: "empty", events: [], code: "invalidState" },
      {
        name: "active",
        events: [exactJournalEvent(0, "turn/start", { turn: 1 })],
        code: "sessionBusy",
      },
      {
        name: "missing preset",
        events: [
          exactJournalEvent(0, "turn/start", { turn: 1 }),
          exactJournalEvent(1, "turn/end", { turn: 1, reason: { kind: "completed" } }),
        ],
        code: "protocolError",
      },
      {
        name: "malformed preset",
        events: [
          exactJournalEvent(0, "turn/start", { turn: 1 }),
          exactJournalEvent(1, "turn/end", { turn: 1, reason: { kind: "completed" } }),
        ],
        agentPreset: 42,
        code: "protocolError",
      },
    ];

    for (const testCase of cases) {
      const { adapter, connection } = setup();
      const sourceSessionId = `session-${testCase.name.replace(" ", "-")}`;
      const snapshot = exactJournalSnapshot({
        sessionId: sourceSessionId,
        cwd,
        events: testCase.events,
      });
      if (testCase.agentPreset !== undefined) {
        const projections = snapshot.projections as { values: Record<string, unknown> };
        projections.values.agentPreset = testCase.agentPreset;
      }
      connection.journalSnapshots.set(sourceSessionId, snapshot);

      const opened = await adapter.open({
        kind: "rollbackLastTurn",
        sourceRef: forkRefs(sourceSessionId, 0).sourceRef,
        cwd,
      });

      expect(opened, testCase.name).toMatchObject({
        ok: false,
        error: { code: testCase.code },
      });
      expect(
        connection.calls.some(
          ({ endpoint }) => endpoint === "session/create" || endpoint === "session/fork",
        ),
        testCase.name,
      ).toBe(false);
      await adapter.close();
    }
  });

  it("uses child seedLength when cold promotion and concurrent configuration extend the source", async () => {
    const { adapter, connection } = setup();
    const cwd = path.resolve("fixture-fork-growing-source");
    const sourceSessionId = "session-cold-source";
    const initial = forkSourceEvents().slice(0, 3);
    const inherited = [
      ...initial,
      exactJournalEvent(3, "session/end-seed", {}),
      exactJournalEvent(4, "model/selection", {
        provider: "provider",
        model: "model",
        reasoningEffort: "high",
      }),
    ];
    const sourceAfterFork = [
      ...inherited,
      exactJournalEvent(5, "permission/preset", { preset: "workspace-write" }),
      exactJournalEvent(6, "turn/start", { turn: 2 }),
    ];
    connection.journalSnapshotQueues.set(sourceSessionId, [
      exactJournalSnapshot({ sessionId: sourceSessionId, cwd, events: initial }),
      exactJournalSnapshot({ sessionId: sourceSessionId, cwd, events: sourceAfterFork }),
    ]);
    connection.journalSnapshots.set(
      "session-forked",
      exactJournalSnapshot({
        sessionId: "session-forked",
        cwd,
        parentSession: sourceSessionId,
        seedLength: inherited.length,
        events: [...inherited, exactJournalEvent(5, "session/end-seed", {})],
      }),
    );

    const opened = await adapter.open({
      kind: "fork",
      ...forkRefs(sourceSessionId, 2),
      cwd,
    });

    expect(opened).toMatchObject({
      ok: true,
      value: { initialState: { nativeRef: { nativeSessionId: "session-forked" } } },
    });
    expect(
      connection.streams.filter(({ endpoint, args }) => {
        if (endpoint !== "session/follow") return false;
        const request = args.request as { address: { sessionId: string } };
        return request.address.sessionId === sourceSessionId;
      }),
    ).toHaveLength(2);
    if (opened.ok) await opened.value.close();
    await adapter.close();
  });

  it("drains one deferred non-idempotent Fork when Adapter close wins the race", async () => {
    const { adapter, connection } = setup();
    const cwd = path.resolve("fixture-fork-close-race");
    const sourceSessionId = "session-source-close-race";
    connection.journalSnapshots.set(
      sourceSessionId,
      exactJournalSnapshot({ sessionId: sourceSessionId, cwd, events: forkSourceEvents() }),
    );
    let settleFork!: (result: ModernRemoteResult<unknown>) => void;
    connection.forkResponse = new Promise((resolve) => {
      settleFork = resolve;
    });

    const opening = adapter.open({
      kind: "fork",
      ...forkRefs(sourceSessionId, 2),
      cwd,
    });
    await vi.waitFor(() =>
      expect(connection.calls.filter(({ endpoint }) => endpoint === "session/fork")).toHaveLength(
        1,
      ),
    );
    let closeSettled = false;
    const closing = adapter.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    settleFork({ ok: true, value: { sessionId: "session-forked-after-close" } });
    await expect(opening).resolves.toMatchObject({
      ok: false,
      error: {
        message:
          "DeepSeek Harness created the Fork child, but codexhost did not adopt it because post-Fork verification failed",
        retryable: false,
      },
    });
    await closing;

    expect(connection.calls.filter(({ endpoint }) => endpoint === "session/fork")).toHaveLength(1);
    expect(connection.closeCalls).toBe(1);
    expect(closeSettled).toBe(true);
  });

  it("rejects invalid and tail checkpoints before the non-idempotent Fork call", async () => {
    const sourceSessionId = "session-source-invalid";
    const cwd = path.resolve("fixture-fork-invalid");

    for (const checkpointId of ["turn-end:02", "turn-end:4"]) {
      const { adapter, connection } = setup();
      connection.journalSnapshots.set(
        sourceSessionId,
        exactJournalSnapshot({ sessionId: sourceSessionId, cwd, events: forkSourceEvents() }),
      );
      const refs = forkRefs(sourceSessionId, 2);
      const opened = await adapter.open({
        kind: "fork",
        sourceRef: refs.sourceRef,
        checkpoint: { ...refs.checkpoint, checkpointId },
        cwd,
      });

      expect(opened).toMatchObject({
        ok: false,
        error: { code: "checkpointNotFound", retryable: false },
      });
      expect(connection.calls.filter(({ endpoint }) => endpoint === "session/fork")).toEqual([]);
      expect(connection.follows.get(sourceSessionId)?.returnCalls).toBe(1);
      await adapter.close();
    }

    const { adapter, connection } = setup();
    const refs = forkRefs(sourceSessionId, 2);
    const opened = await adapter.open({
      kind: "fork",
      sourceRef: { ...refs.sourceRef, harnessId: "other" as never },
      checkpoint: refs.checkpoint,
      cwd,
    });
    expect(opened).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(connection.connectCalls).toBe(0);
    expect(connection.calls).toEqual([]);
    expect(connection.streams).toEqual([]);
    await adapter.close();
  });

  it("fails closed without retry when the native result or child postconditions are wrong", async () => {
    const sourceSessionId = "session-source-failure";
    const cwd = path.resolve("fixture-fork-failure");
    const sourceEvents = forkSourceEvents();
    const inherited = sourceEvents.slice(0, 5);
    const validChild = () =>
      exactJournalSnapshot({
        sessionId: "session-forked",
        cwd,
        parentSession: sourceSessionId,
        seedLength: inherited.length,
        events: [...inherited, exactJournalEvent(5, "session/end-seed", {})],
      });
    const cases: Array<{
      readonly name: string;
      readonly configure: (connection: FakeConnection) => void;
      readonly code: string;
      readonly message?: string;
      readonly forbidden?: readonly string[];
      readonly orphanSafe?: boolean;
    }> = [
      {
        name: "native boundary rejection",
        configure: (connection) => {
          connection.forkResult = {
            ok: false,
            error: { code: "session/fork-unavailable", message: "unavailable", details: {} },
          };
        },
        code: "checkpointNotFound",
      },
      {
        name: "workspace attachment failed after native creation",
        configure: (connection) => {
          connection.forkResult = {
            ok: false,
            error: {
              code: "session/workspace-attach-failed",
              message:
                "forked C:\\private\\fork-secret.txt but failed https://host/?token=fork-token-secret",
              details: {
                sessionId: "session-forked-secret",
                workspaceId: "workspace-secret",
              },
            },
          };
        },
        code: "nativeFailure",
        message:
          "DeepSeek Harness created the Fork child, but codexhost did not adopt it after workspace attachment failed",
        forbidden: [
          "private",
          "fork-secret",
          "fork-token-secret",
          "session-forked-secret",
          "workspace-secret",
        ],
      },
      {
        name: "source identity returned",
        configure: (connection) => {
          connection.forkResult = { ok: true, value: { sessionId: sourceSessionId } };
        },
        code: "protocolError",
      },
      {
        name: "child follow failure after native creation",
        configure: (connection) => {
          connection.followFailureQueues.set("session-forked", [
            new ModernRemoteConnectionError(
              "unavailable",
              "child follow C:\\private-child\\content.txt https://host/?token=child-token",
            ),
          ]);
        },
        code: "unavailable",
        message:
          "DeepSeek Harness created the Fork child, but codexhost did not adopt it because post-Fork verification failed",
        forbidden: ["private-child", "content.txt", "child-token"],
        orphanSafe: true,
      },
      {
        name: "source post-read failure after native creation",
        configure: (connection) => {
          connection.followFailureQueues.set(sourceSessionId, [
            undefined,
            new ModernRemoteConnectionError(
              "unavailable",
              "source reread C:\\private-source\\journal.jsonl https://host/?token=source-token",
            ),
          ]);
        },
        code: "unavailable",
        message:
          "DeepSeek Harness created the Fork child, but codexhost did not adopt it because post-Fork verification failed",
        forbidden: ["private-source", "journal.jsonl", "source-token"],
        orphanSafe: true,
      },
      {
        name: "wrong parent",
        configure: (connection) => {
          const snapshot = validChild();
          (snapshot.header as Record<string, unknown>).parentSession = "other-source";
          connection.journalSnapshots.set("session-forked", snapshot);
        },
        code: "protocolError",
      },
      {
        name: "wrong cwd",
        configure: (connection) => {
          connection.journalSnapshots.set(
            "session-forked",
            exactJournalSnapshot({
              sessionId: "session-forked",
              cwd: path.resolve("other-fork-cwd"),
              parentSession: sourceSessionId,
              seedLength: inherited.length,
              events: [...inherited, exactJournalEvent(5, "session/end-seed", {})],
            }),
          );
        },
        code: "protocolError",
      },
      {
        name: "wrong seed length",
        configure: (connection) => {
          const snapshot = validChild();
          (snapshot.header as Record<string, unknown>).seedLength = inherited.length - 1;
          connection.journalSnapshots.set("session-forked", snapshot);
        },
        code: "protocolError",
      },
      {
        name: "changed inherited event",
        configure: (connection) => {
          const changed = [...inherited];
          changed[1] = exactJournalEvent(
            1,
            "user/message",
            {
              id: "source-user-1",
              role: "user",
              content: [{ type: "text", text: "changed" }],
              source: { kind: "user" },
            },
            true,
          );
          connection.journalSnapshots.set(
            "session-forked",
            exactJournalSnapshot({
              sessionId: "session-forked",
              cwd,
              parentSession: sourceSessionId,
              seedLength: inherited.length,
              events: [...changed, exactJournalEvent(5, "session/end-seed", {})],
            }),
          );
        },
        code: "protocolError",
      },
      {
        name: "missing seed marker",
        configure: (connection) => {
          connection.journalSnapshots.set(
            "session-forked",
            exactJournalSnapshot({
              sessionId: "session-forked",
              cwd,
              parentSession: sourceSessionId,
              seedLength: inherited.length,
              events: inherited,
            }),
          );
        },
        code: "protocolError",
      },
      {
        name: "later Turn leaked",
        configure: (connection) => {
          const snapshot = validChild();
          (snapshot.records as Record<string, unknown>[]).push({
            type: "event",
            event: exactJournalEvent(6, "turn/start", { turn: 2 }),
          });
          snapshot.cursor = 6;
          (snapshot.projections as Record<string, unknown>).asOfSeq = 6;
          connection.journalSnapshots.set("session-forked", snapshot);
        },
        code: "protocolError",
      },
    ];

    for (const testCase of cases) {
      const { adapter, connection } = setup();
      connection.journalSnapshots.set(
        sourceSessionId,
        exactJournalSnapshot({ sessionId: sourceSessionId, cwd, events: sourceEvents }),
      );
      connection.journalSnapshots.set("session-forked", validChild());
      testCase.configure(connection);

      const opened = await adapter.open({
        kind: "fork",
        ...forkRefs(sourceSessionId, 2),
        cwd,
      });

      expect(opened, testCase.name).toMatchObject({
        ok: false,
        error: {
          code: testCase.code,
          retryable: false,
          ...(testCase.message ? { message: testCase.message } : {}),
        },
      });
      for (const secret of testCase.forbidden ?? []) {
        expect(JSON.stringify(opened), testCase.name).not.toContain(secret);
      }
      if (testCase.orphanSafe) {
        expect(opened, testCase.name).toEqual({
          ok: false,
          error: {
            code: testCase.code,
            message: testCase.message,
            retryable: false,
          },
        });
      }
      expect(
        connection.calls.filter(({ endpoint }) => endpoint === "session/fork"),
        testCase.name,
      ).toHaveLength(1);
      expect(connection.follows.get(sourceSessionId)?.returnCalls, testCase.name).toBe(1);
      const childFollow = connection.follows.get("session-forked");
      if (childFollow) expect(childFollow.returnCalls, testCase.name).toBe(1);
      await adapter.close();
    }
  });

  it("reserves a generated Session identity before concurrent create RPCs", async () => {
    const { adapter, connection } = setup(["collision", "collision"]);
    const cwd = path.resolve("fixture-create-collision");
    connection.expectedCwds.set("session-collision", cwd);

    const opened = await Promise.all([
      adapter.open({ kind: "create", cwd }),
      adapter.open({ kind: "create", cwd }),
    ]);

    expect(connection.calls.filter(({ endpoint }) => endpoint === "session/create")).toHaveLength(
      1,
    );
    expect(opened.filter(({ ok }) => ok)).toHaveLength(1);
    expect(opened.filter(({ ok }) => !ok)).toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "sessionBusy" }),
      }),
    ]);
    for (const result of opened) if (result.ok) await result.value.close();
    await adapter.close();
  });

  it("does not create over a loaded resumed Session identity", async () => {
    const { adapter, connection } = setup(["collision"]);
    const cwd = path.resolve("fixture-loaded-collision");
    const nativeRef = nativeSessionRefSchema.parse({
      harnessId: "deepseek-harness",
      nativeSessionId: "session-collision",
      formatVersion: 1,
    });
    connection.expectedCwds.set("session-collision", cwd);
    const resumed = await adapter.open({ kind: "resume", nativeRef, cwd });
    expect(resumed.ok).toBe(true);

    await expect(adapter.open({ kind: "create", cwd })).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    expect(connection.calls.filter(({ endpoint }) => endpoint === "session/create")).toEqual([]);
    if (resumed.ok) await resumed.value.close();
    await adapter.close();
  });

  it("releases a create reservation after the Native RPC fails", async () => {
    const { adapter, connection } = setup(["retry", "retry"]);
    const cwd = path.resolve("fixture-create-retry");
    connection.expectedCwds.set("session-retry", cwd);
    const call = connection.call.bind(connection);
    let createAttempts = 0;
    connection.call = <T>(
      endpoint: string,
      args: Readonly<Record<string, unknown>>,
    ): Promise<ModernRemoteResult<T>> => {
      if (endpoint !== "session/create" || createAttempts++ > 0) return call(endpoint, args);
      connection.calls.push({ endpoint, args });
      return Promise.resolve({
        ok: false,
        error: { code: "session/agent-busy", message: "busy", details: {} },
      });
    };

    await expect(adapter.open({ kind: "create", cwd })).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    const retried = await adapter.open({ kind: "create", cwd });
    expect(retried.ok).toBe(true);
    expect(connection.calls.filter(({ endpoint }) => endpoint === "session/create")).toHaveLength(
      2,
    );
    if (retried.ok) await retried.value.close();
    await adapter.close();
  });

  it("resumes only the exact Native ref and authoritative cwd without a resume RPC", async () => {
    const { adapter, connection } = setup();
    const cwd = path.resolve("fixture-resume");
    const nativeRef = nativeSessionRefSchema.parse({
      harnessId: "deepseek-harness",
      nativeSessionId: "persisted",
      formatVersion: 1,
    });
    connection.expectedCwds.set("persisted", cwd);

    const opened = await adapter.open({ kind: "resume", nativeRef, cwd });

    expect(opened.ok).toBe(true);
    expect(connection.calls.map(({ endpoint }) => endpoint)).toEqual([
      "session/modelCatalog",
      "settings/describe",
    ]);
    if (opened.ok) await opened.value.close();
    await adapter.close();
  });

  it("rehydrates a persisted Session after an Adapter restart", async () => {
    const cwd = path.resolve("fixture-restart-resume");
    const first = setup();
    first.connection.expectedCwds.set("session-created", cwd);
    const created = await first.adapter.open({ kind: "create", cwd });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const nativeRef = created.value.initialState.nativeRef;
    if (!nativeRef) throw new Error("created Session omitted its Native ref");
    await created.value.close();
    await first.adapter.close();

    const second = setup();
    second.connection.expectedCwds.set("session-created", cwd);
    second.connection.journalSnapshots.set(
      "session-created",
      journalSnapshot("session-created", cwd, null, undefined, true),
    );
    const resumed = await second.adapter.open({ kind: "resume", nativeRef, cwd });
    expect(resumed).toMatchObject({
      ok: true,
      value: { initialState: { nativeRef } },
    });
    expect(second.connection.calls.some(({ endpoint }) => endpoint === "session/create")).toBe(
      false,
    );
    if (resumed.ok) await resumed.value.close();
    await second.adapter.close();
  });

  it("rejects an invalid resume ref before connection or catalog side effects", async () => {
    const { adapter, connection } = setup();
    const nativeRef = nativeSessionRefSchema.parse({
      harnessId: "other-harness",
      nativeSessionId: "persisted",
      formatVersion: 1,
    });

    await expect(
      adapter.open({ kind: "resume", nativeRef, cwd: "fixture" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
    expect(connection.connectCalls).toBe(0);
    expect(connection.calls).toEqual([]);
    expect(connection.streams).toEqual([]);
    await adapter.close();
  });

  it("inspect reads both configuration catalogs and starts no long-lived stream", async () => {
    const { adapter, connection } = setup();
    await expect(adapter.inspect()).resolves.toMatchObject({ status: "ready" });
    expect(connection.streams).toEqual([]);
    await adapter.close();
  });

  it("inspect advertises the dynamic Permission catalog and live selector", async () => {
    const { adapter, connection } = setup();
    connection.permissionModesEnabled = true;

    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "ready",
      permissionModes: {
        modes: [{ id: "workspace-write" }, { id: "danger-full-access" }],
        defaultModeId: "workspace-write",
      },
      capabilities: {
        configuration: { selectPermissionMode: true },
        history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
      },
    });
    await adapter.close();
  });

  it("clears a rejected catalog load without creating an unhandled rejection", async () => {
    const { adapter, connection } = setup();
    connection.call = <T>(): Promise<ModernRemoteResult<T>> =>
      Promise.reject(new Error("catalog failed"));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await expect(adapter.inspect()).resolves.toMatchObject({
        status: "unavailable",
        error: { code: "unavailable" },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      await adapter.close();
    }
  });

  it.each([
    ["unavailable", true],
    ["protocolError", false],
    ["authenticationRequired", false],
    ["processExited", true],
  ] as const)("preserves inspect transport error %s", async (code, retryable) => {
    const { adapter, connection } = setup();
    connection.call = <T>(): Promise<ModernRemoteResult<T>> =>
      Promise.reject(new ModernRemoteConnectionError(code, `typed ${code}`));

    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "unavailable",
      error: { code, retryable },
    });
    await adapter.close();
  });

  it("applies and rehydrates an explicit create Permission Mode", async () => {
    const { adapter, connection } = setup();
    connection.permissionModesEnabled = true;
    const cwd = path.resolve("fixture-permission");
    connection.expectedCwds.set("session-created", cwd);

    const opened = await adapter.open({
      kind: "create",
      cwd,
      permissionModeId: "danger-full-access" as never,
    });

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(connection.calls).toContainEqual({
      endpoint: "commands/execute",
      args: {
        agentId: "session-created",
        line: "/permission danger-full-access",
        images: [],
      },
    });
    expect(opened.value.initialState.effectivePermissionModeId).toBe("danger-full-access");
    expect(opened.value.capabilities.configuration.selectPermissionMode).toBe(true);
    await opened.value.close();
    await adapter.close();
  });

  it("accepts unattended only after the Modern permission facts agree", async () => {
    const good = setup();
    good.connection.permissionModesEnabled = true;
    const cwd = path.resolve("fixture-unattended");
    good.connection.expectedCwds.set("session-created", cwd);
    const opened = await good.adapter.open({
      kind: "create",
      cwd,
      executionPolicy: "unattended-full-access",
    });
    expect(opened.ok).toBe(true);
    if (opened.ok) await opened.value.close();
    await good.adapter.close();

    const bad = setup();
    bad.connection.permissionModesEnabled = true;
    bad.connection.validUnattendedFacts = false;
    bad.connection.expectedCwds.set("session-created", cwd);
    await expect(
      bad.adapter.open({
        kind: "create",
        cwd,
        executionPolicy: "unattended-full-access",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "nativeFailure" } });
    await bad.adapter.close();
  });

  it("rejects combining explicit Permission Mode with unattended before startup", async () => {
    const { adapter, connection } = setup();
    await expect(
      adapter.open({
        kind: "create",
        cwd: "fixture",
        permissionModeId: "workspace-write" as never,
        executionPolicy: "unattended-full-access",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(connection.connectCalls).toBe(0);
    await adapter.close();
  });

  it("rejects an unknown open kind before startup", async () => {
    const { adapter, connection } = setup();

    await expect(adapter.open({ kind: "future", cwd: "fixture" } as never)).resolves.toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
    expect(connection.connectCalls).toBe(0);
    await adapter.close();
  });

  it("rejects an invalid explicit Model before creating a Native Session", async () => {
    const { adapter, connection } = setup();
    const opened = await adapter.open({
      kind: "create",
      cwd: "fixture",
      model: { id: "model" as never },
    });
    expect(opened).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(connection.calls.some(({ endpoint }) => endpoint === "session/create")).toBe(false);
    await adapter.close();
  });

  it("configures a fresh Session when control omits its initial Model projection", async () => {
    const { adapter, connection } = setup();
    connection.permissionModesEnabled = true;
    const cwd = path.resolve("fixture-thinking");
    connection.expectedCwds.set("session-created", cwd);
    const inspection = await adapter.inspect();
    expect(inspection.status).toBe("ready");
    if (inspection.status !== "ready") return;
    const defaultModel = inspection.catalog.defaultModel;
    const defaultThinkingOptionId = inspection.catalog.defaultThinkingOptionId;
    if (!defaultModel || !defaultThinkingOptionId) {
      throw new Error("fixture catalog omitted its default Model or Thinking option");
    }
    const opened = await adapter.open({
      kind: "create",
      cwd,
      model: defaultModel,
      thinkingOptionId: defaultThinkingOptionId,
      permissionModeId: "danger-full-access" as never,
    });
    expect(opened.ok).toBe(true);
    expect(connection.calls).toContainEqual({
      endpoint: "session/selectModel",
      args: {
        request: {
          sessionId: "session-created",
          provider: "provider",
          model: "model",
          reasoningEffort: "high",
        },
      },
    });
    expect(connection.calls).toContainEqual({
      endpoint: "commands/execute",
      args: {
        agentId: "session-created",
        line: "/permission danger-full-access",
        images: [],
      },
    });
    if (opened.ok) {
      expect(opened.value.initialState).toMatchObject({
        effectiveModel: defaultModel,
        effectiveThinkingOptionId: "high",
        effectivePermissionModeId: "danger-full-access",
      });
      await opened.value.close();
    }
    await adapter.close();
  });

  it.each([
    { permissionModeId: "allow" as never },
    { executionPolicy: "unattended-full-access" as const },
  ])("rejects create Permission configuration when no catalog exists", async (extra) => {
    const { adapter, connection } = setup();
    const opened = await adapter.open({ kind: "create", cwd: "fixture", ...extra });
    expect(opened).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(connection.calls.some(({ endpoint }) => endpoint === "session/create")).toBe(false);
    await adapter.close();
  });

  it("maps a Native create failure without retaining secret details", async () => {
    const { adapter, connection } = setup();
    const secret = "adapter-secret-canary";
    connection.call = <T>(
      endpoint: string,
      args: Readonly<Record<string, unknown>>,
    ): Promise<ModernRemoteResult<T>> => {
      connection.calls.push({ endpoint, args });
      if (endpoint === "session/modelCatalog") {
        return Promise.resolve({ ok: true, value: catalogValue() } as ModernRemoteResult<T>);
      }
      if (endpoint === "settings/describe") {
        return Promise.resolve({ ok: true, value: settingsValue() } as ModernRemoteResult<T>);
      }
      const failure: ModernRemoteFailure = {
        code: "session/agent-busy",
        message: `Bearer ${secret}`,
        details: { token: secret },
      };
      return Promise.resolve({ ok: false, error: failure });
    };
    const result = await adapter.open({ kind: "create", cwd: "fixture" });
    expect(result).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(JSON.stringify(result)).not.toContain(secret);
    await adapter.close();
  });

  it("seals and drains an in-flight open before close resolves", async () => {
    const { adapter, connection } = setup();
    const cwd = path.resolve("fixture-closing");
    connection.expectedCwds.set("session-created", cwd);
    connection.autoOpenJournal = false;
    const opening = adapter.open({ kind: "create", cwd });
    await vi.waitFor(() => expect(connection.follows.has("session-created")).toBe(true));

    const closing = adapter.close();
    await expect(opening).resolves.toMatchObject({ ok: false });
    await expect(closing).resolves.toBeUndefined();
    await expect(adapter.open({ kind: "create", cwd })).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
  });

  it("stops accepting before a global event protocol fault can create another Session", async () => {
    const { adapter, connection } = setup(["created", "second"]);
    const cwd = path.resolve("fixture-event-fault");
    connection.expectedCwds.set("session-created", cwd);
    const opened = await adapter.open({ kind: "create", cwd });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const outputs = opened.value.outputs[Symbol.asyncIterator]();

    connection.events.push({ invalid: true });
    await expect(outputs.next()).resolves.toMatchObject({
      value: {
        kind: "event",
        event: { type: "session.faulted", error: { code: "protocolError" } },
      },
    });
    const creates = connection.calls.filter(({ endpoint }) => endpoint === "session/create");
    await expect(adapter.open({ kind: "create", cwd })).resolves.toMatchObject({
      ok: false,
      error: { code: "protocolError" },
    });
    expect(connection.calls.filter(({ endpoint }) => endpoint === "session/create")).toHaveLength(
      creates.length,
    );
    await adapter.close();
  });

  it("seals admission while global event failure waits for native cancellation", async () => {
    const { adapter, connection } = setup(["created", "orphan"]);
    const cwd = path.resolve("fixture-event-failure-window");
    connection.expectedCwds.set("session-created", cwd);
    const opened = await adapter.open({ kind: "create", cwd });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const cancellation = Promise.withResolvers<ModernRemoteResult<unknown>>();
    connection.cancelResponse = cancellation.promise;

    connection.events.push({ invalid: true });
    await vi.waitFor(() =>
      expect(connection.calls.some(({ endpoint }) => endpoint === "session/cancel")).toBe(true),
    );
    const createsBefore = connection.calls.filter(
      ({ endpoint }) => endpoint === "session/create",
    ).length;
    await expect(adapter.open({ kind: "create", cwd })).resolves.toMatchObject({
      ok: false,
      error: { code: "protocolError" },
    });
    expect(connection.calls.filter(({ endpoint }) => endpoint === "session/create")).toHaveLength(
      createsBefore,
    );

    let closed = false;
    const closing = adapter.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    cancellation.resolve({ ok: true, value: { accepted: true } });
    await closing;
    expect(closed).toBe(true);
  });

  it("faults only the loaded Session targeted by a malformed claimed request", async () => {
    const { adapter, connection } = setup(["broken", "healthy"]);
    const brokenCwd = path.resolve("fixture-broken-event");
    const healthyCwd = path.resolve("fixture-healthy-event");
    connection.expectedCwds.set("session-broken", brokenCwd);
    connection.expectedCwds.set("session-healthy", healthyCwd);
    const broken = await adapter.open({ kind: "create", cwd: brokenCwd });
    const healthy = await adapter.open({ kind: "create", cwd: healthyCwd });
    expect(broken.ok).toBe(true);
    expect(healthy.ok).toBe(true);
    if (!broken.ok || !healthy.ok) return;
    const brokenOutputs = broken.value.outputs[Symbol.asyncIterator]();

    connection.events.push({
      type: "waterfall",
      event: "user-questions/request",
      eventId: "malformed-question",
      agentId: "session-broken",
      request: { questions: [] },
    });
    await expect(brokenOutputs.next()).resolves.toMatchObject({
      value: {
        kind: "event",
        event: { type: "session.faulted", error: { code: "protocolError" } },
      },
    });
    await expect(healthy.value.readSnapshot()).resolves.toMatchObject({ ok: true });
    await expect(adapter.inspect()).resolves.toMatchObject({ status: "ready" });
    await healthy.value.close();
    await adapter.close();
  });

  it("closes Session events and control before the owned connection", async () => {
    const { adapter, connection } = setup(["created"]);
    const cwd = path.resolve("fixture-close-order");
    connection.expectedCwds.set("session-created", cwd);
    const opened = await adapter.open({ kind: "create", cwd });
    expect(opened.ok).toBe(true);

    await adapter.close();
    const follow = connection.timeline.indexOf("follow.return:session-created");
    const events = connection.timeline.indexOf("events.return");
    const control = connection.timeline.indexOf("control.return");
    const connectionClose = connection.timeline.indexOf("connection.close");
    expect(follow).toBeGreaterThan(-1);
    expect(events).toBeGreaterThan(follow);
    expect(control).toBeGreaterThan(events);
    expect(connectionClose).toBeGreaterThan(control);
  });

  it("propagates an owned connection cleanup failure", async () => {
    const { adapter, connection } = setup();
    connection.closeError = new Error("process tree survived");

    await expect(adapter.close()).rejects.toThrow("process tree survived");
    expect(connection.closeCalls).toBe(1);
  });
});
