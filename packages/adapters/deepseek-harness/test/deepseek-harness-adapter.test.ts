import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import Schema from "@deepseek-ai/schemastery";
import type {
  HistoryEntry,
  ModelSelection,
  MuxFrame,
  SessionModels,
} from "@deepseek-ai/dsh-host-apiproxy/api";
import { RpcId } from "@deepseek-ai/dsh-host-apiproxy/api";
import type { SessionId } from "@deepseek-ai/dsh-session/types";

import type { HarnessOutput } from "@codexhost/harness-adapter";
import {
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";

import {
  DeepSeekHarnessAdapter,
  type DeepSeekHarnessAdapterDependencies,
  type DeepSeekHostConnectionLike,
} from "../src/deepseek-harness-adapter.js";
import type {
  DeepSeekCommandExecution,
  DeepSeekHostClient,
  DeepSeekHostSubscriber,
  DeepSeekMuxEnvelope,
} from "../src/host-client.js";
import { encodeDeepSeekHarnessModelRef } from "../src/model-catalog.js";
import { projectToolResult } from "../src/projection.js";

const SESSION_ID = "session-native-1" as SessionId;
const CURRENT_MODEL: ModelSelection = {
  provider: "deepseek-official",
  model: "deepseek-v4-flash",
};
const MODEL_GROUPS = [
  {
    id: "deepseek-official",
    name: "DeepSeek",
    models: [
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        reasoning: {
          efforts: [
            { id: "off", name: "Off" },
            { id: "low", name: "Low" },
            { id: "high", name: "High" },
          ],
          defaultEffort: "high",
        },
      },
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        reasoning: {
          efforts: [
            { id: "off", name: "Off" },
            { id: "low", name: "Low" },
            { id: "high", name: "High" },
            { id: "max", name: "Max" },
          ],
          defaultEffort: "high",
        },
      },
    ],
  },
];

interface FakePermissionOption {
  value: string;
  name: string;
  description?: string;
}

const PERMISSION_OPTIONS: FakePermissionOption[] = [
  { value: "team-safe", name: "Team safe", description: "Ask before broad access." },
  { value: "trusted-run", name: "Trusted run", description: "Use the trusted runtime policy." },
];

function permissionSettingsSchema(options: readonly FakePermissionOption[]): unknown {
  return JSON.parse(
    JSON.stringify(
      Schema.object({
        defaultPreset: Schema.union(
          options.map(({ value, name }) => Schema.const(value).description(name)),
        ).required(),
      }).toJSON(),
    ),
  );
}

function success<T>(value: T) {
  return { rpcId: RpcId("response"), result: { ok: true as const, value } };
}

function commandSuccess<T>(value: T) {
  return { ok: true as const, value };
}

function event(seq: number, type: string, data: Record<string, unknown>): HistoryEntry {
  return {
    event: { type, seq, time: seq, data } as HistoryEntry["event"],
  };
}

function sessionRef(sessionId: string) {
  return nativeSessionRefSchema.parse({
    harnessId: "deepseek-harness",
    nativeSessionId: sessionId,
    formatVersion: 1,
  });
}

function checkpointRef(sessionId: string, seq: number) {
  return nativeCheckpointRefSchema.parse({
    harnessId: "deepseek-harness",
    nativeSessionId: sessionId,
    checkpointId: `turn-end:${seq}`,
    formatVersion: 1,
  });
}

function completedTurn(
  startSeq: number,
  turn: number,
  text: string,
  reason: Record<string, unknown> = { kind: "completed" },
): HistoryEntry[] {
  return [
    event(startSeq, "turn/start", { turn }),
    event(startSeq + 1, "user/message", {
      source: { kind: "user" },
      content: [{ type: "text", text }],
    }),
    event(startSeq + 2, "turn/end", { turn, reason }),
  ];
}

class FakeConnection implements DeepSeekHostConnectionLike {
  readonly subscribers = new Map<string, DeepSeekHostSubscriber>();
  readonly history = new Map<string, HistoryEntry[]>();
  readonly cwd = new Map<string, string>();
  readonly modelsBySession = new Map<string, ModelSelection>();
  readonly permissionState = new Map<string, { currentValue: string; seq: number }>();
  permissionOptions: FakePermissionOption[] | null = null;
  permissionDefaultModeId: string | null = null;
  readonly calls = {
    list: vi.fn(),
    create: vi.fn(),
    fork: vi.fn(),
    history: vi.fn(),
    models: vi.fn(),
    selectModel: vi.fn(),
    prompt: vi.fn(),
    commandList: vi.fn(),
    commandExecute: vi.fn(),
    settingsDescribe: vi.fn(),
    cancel: vi.fn(),
    respond: vi.fn(),
  };
  connected = false;
  closed = false;
  currentModel: ModelSelection = CURRENT_MODEL;
  forkChildId = "session-forked-1" as SessionId;
  forkFailure: "fork-unavailable" | "workspace-attach-failed" | undefined;
  forkHistoryTransform: ((entries: HistoryEntry[]) => HistoryEntry[]) | undefined;
  forkedModel: ModelSelection | undefined;
  readonly client: DeepSeekHostClient;

  constructor() {
    const sessions = {
      list: this.calls.list,
      create: this.calls.create,
      fork: this.calls.fork,
      history: this.calls.history,
      models: this.calls.models,
      selectModel: this.calls.selectModel,
      prompt: this.calls.prompt,
      cancel: this.calls.cancel,
    };
    this.calls.list.mockImplementation(() =>
      Promise.resolve(
        success({
          items: [...this.cwd].map(([sessionId, cwd]) => ({
            sessionId: sessionId as SessionId,
            updatedAt: 0,
            running: false,
            blank: (this.history.get(sessionId) ?? []).every(
              (entry) => entry.event.type !== "turn/start",
            ),
            cwd,
          })),
        }),
      ),
    );
    this.calls.create.mockImplementation(
      ({ sessionId, cwd }: { sessionId?: SessionId; cwd?: string }) => {
        const created = sessionId ?? SESSION_ID;
        if (cwd) this.cwd.set(created, cwd);
        if (this.permissionDefaultModeId) {
          this.permissionState.set(created, {
            currentValue: this.permissionDefaultModeId,
            seq: -1,
          });
        }
        return Promise.resolve(success({ sessionId: created, agentPreset: "standard" }));
      },
    );
    this.calls.history.mockImplementation(
      ({ sessionId, beforeSeq }: { sessionId: SessionId; beforeSeq?: number }) => {
        const state = this.permissionState.get(sessionId);
        return Promise.resolve(
          success({
            events: this.history.get(sessionId) ?? [],
            hasMore: false,
            ...(beforeSeq === undefined && state && this.permissionOptions
              ? {
                  projections: {
                    asOfSeq: state.seq,
                    values: {
                      permissions: {
                        options: this.permissionOptions,
                        currentValue: state.currentValue,
                      },
                    },
                  },
                }
              : {}),
          }),
        );
      },
    );
    this.calls.models.mockImplementation(({ sessionId }: { sessionId: SessionId }) =>
      Promise.resolve(
        success<SessionModels>({
          current: this.modelsBySession.get(sessionId) ?? this.currentModel,
          routable: true,
          groups: MODEL_GROUPS,
          failures: [],
        }),
      ),
    );
    this.calls.selectModel.mockImplementation(
      ({
        sessionId,
        provider,
        model,
        reasoningEffort,
      }: {
        sessionId: SessionId;
        provider: string;
        model: string;
        reasoningEffort?: string;
      }) => {
        const defaultEffort = MODEL_GROUPS.find((group) => group.id === provider)?.models.find(
          (candidate) => candidate.id === model,
        )?.reasoning?.defaultEffort;
        const effectiveEffort = reasoningEffort ?? defaultEffort;
        this.currentModel = {
          provider,
          model,
          ...(effectiveEffort ? { reasoningEffort: effectiveEffort } : {}),
        };
        this.modelsBySession.set(sessionId, this.currentModel);
        return Promise.resolve(success({ selected: this.currentModel }));
      },
    );
    this.calls.fork.mockImplementation(
      ({ sessionId, atSeq }: { sessionId: SessionId; atSeq?: number }) => {
        if (this.forkFailure === "fork-unavailable") {
          return Promise.resolve({
            rpcId: RpcId("response"),
            result: {
              ok: false as const,
              error: {
                code: "fork-unavailable" as const,
                message: "checkpoint unavailable",
                details: { sessionId },
              },
            },
          });
        }
        const source = this.history.get(sessionId) ?? [];
        const boundary = source.findIndex(
          (entry) => entry.event.type === "turn/end" && entry.event.seq >= (atSeq ?? Infinity),
        );
        const fallback = source.findLastIndex((entry) => entry.event.type === "turn/end");
        const boundaryIndex = boundary >= 0 ? boundary : fallback;
        let cut = boundaryIndex + 1;
        while (cut < source.length && source[cut]?.event.type !== "turn/start") cut += 1;
        let child = structuredClone(source.slice(0, cut));
        if (child.at(-1)?.event.type !== "session/end-seed") {
          const seq = (child.at(-1)?.event.seq ?? -1) + 1;
          child.push(event(seq, "session/end-seed", {}));
        }
        child = this.forkHistoryTransform?.(child) ?? child;
        this.history.set(this.forkChildId, child);
        const sourceCwd = this.cwd.get(sessionId);
        if (sourceCwd) this.cwd.set(this.forkChildId, sourceCwd);
        this.modelsBySession.set(
          this.forkChildId,
          this.forkedModel ?? this.modelsBySession.get(sessionId) ?? this.currentModel,
        );
        if (this.forkFailure === "workspace-attach-failed") {
          return Promise.resolve({
            rpcId: RpcId("response"),
            result: {
              ok: false as const,
              error: {
                code: "workspace-attach-failed" as const,
                message: "workspace unavailable",
                details: { sessionId: this.forkChildId, workspaceId: "workspace-1" },
              },
            },
          });
        }
        return Promise.resolve(success({ sessionId: this.forkChildId }));
      },
    );
    this.calls.prompt.mockResolvedValue(success({ accepted: true }));
    this.calls.commandList.mockImplementation(() =>
      Promise.resolve(
        commandSuccess([
          { name: "compact", description: "Compact older conversation history" },
          ...(this.permissionOptions
            ? [
                {
                  name: "permission",
                  description: "Switch the permission preset",
                  input: { hint: "<preset>" },
                },
              ]
            : []),
        ]),
      ),
    );
    this.calls.commandExecute.mockImplementation((agentId: string, line: string) => {
      const permissionModeId = line.startsWith("/permission ")
        ? line.slice("/permission ".length)
        : null;
      if (permissionModeId && this.permissionOptions) {
        if (!this.permissionOptions.some(({ value }) => value === permissionModeId)) {
          return Promise.resolve(
            commandSuccess({
              commandId: "command-1",
              result: { kind: "error" as const, text: `unknown preset ${permissionModeId}` },
            }),
          );
        }
        this.setPermissionMode(agentId, permissionModeId);
        return Promise.resolve(
          commandSuccess({
            commandId: "command-1",
            result: { kind: "success" as const, text: `preset ${permissionModeId}` },
          }),
        );
      }
      if (line === "/permission danger-full-access") {
        const history = this.history.get(agentId) ?? [];
        const seq = history.length;
        this.history.set(agentId, [
          ...history,
          event(seq, "permission/preset", { preset: "danger-full-access" }),
          event(seq + 1, "sandbox/mode", { mode: "danger-full-access" }),
          event(seq + 2, "approval/policy", { policy: "never" }),
        ]);
        return Promise.resolve(
          commandSuccess({
            commandId: "command-1",
            result: { kind: "success" as const, text: "preset danger-full-access" },
          }),
        );
      }
      return Promise.resolve(commandSuccess(undefined));
    });
    this.calls.cancel.mockResolvedValue(success({ accepted: true }));
    this.calls.respond.mockResolvedValue({ accepted: true });
    this.calls.settingsDescribe.mockImplementation(() =>
      Promise.resolve(
        success({
          writable: true,
          hasDocument: false,
          namespaces:
            this.permissionOptions && this.permissionDefaultModeId
              ? [
                  {
                    ns: "permission",
                    schema: permissionSettingsSchema(this.permissionOptions),
                    value: { defaultPreset: this.permissionDefaultModeId },
                    applies: "live" as const,
                    secrets: [],
                    revision: 0,
                  },
                ]
              : [],
        }),
      ),
    );
    const commands = {
      list: this.calls.commandList,
      execute: this.calls.commandExecute,
    };
    this.client = {
      sessions,
      commands,
      host: {
        describe: vi.fn().mockResolvedValue(
          success({
            version: "0.0.1",
            cwd: "/workspace",
            provider: CURRENT_MODEL.provider,
            model: CURRENT_MODEL.model,
            attachedSessions: 0,
            canOpenPath: false,
          }),
        ),
      },
      llm: {
        models: vi.fn().mockResolvedValue(success({ groups: MODEL_GROUPS, failures: [] })),
      },
      settings: { describe: this.calls.settingsDescribe },
      respond: this.calls.respond,
    } as unknown as DeepSeekHostClient;
  }

  enablePermissionModes(
    options: readonly FakePermissionOption[] = PERMISSION_OPTIONS,
    defaultModeId = options[0]?.value,
  ): void {
    if (!defaultModeId) throw new Error("Fake permission catalog has no default");
    this.permissionOptions = [...options];
    this.permissionDefaultModeId = defaultModeId;
  }

  setPermissionMode(sessionId: string, currentValue: string, seq?: number): void {
    const current = this.permissionState.get(sessionId);
    this.permissionState.set(sessionId, {
      currentValue,
      seq: seq ?? (current?.seq ?? -1) + 1,
    });
  }

  permissionProjection(currentValue: string): {
    options: FakePermissionOption[];
    currentValue: string;
  } {
    if (!this.permissionOptions) throw new Error("Fake permission catalog is disabled");
    return { options: this.permissionOptions, currentValue };
  }

  connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }

  subscribe(sessionId: string, subscriber: DeepSeekHostSubscriber): () => void {
    this.subscribers.set(sessionId, subscriber);
    return () => this.subscribers.delete(sessionId);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  mux(sessionId: string, payload: MuxFrame, rpcId = "frame"): void {
    this.subscribers.get(sessionId)?.onMux({
      rpcId: RpcId(rpcId),
      payload,
    } as DeepSeekMuxEnvelope);
  }

  sessionEvent(sessionId: string, seq: number, type: string, data: Record<string, unknown>): void {
    this.mux(sessionId, {
      type: "session/event",
      sessionId: sessionId as SessionId,
      event: { type, seq, time: seq, data } as never,
    });
  }
}

function fixture(): {
  adapter: DeepSeekHarnessAdapter;
  connection: FakeConnection;
} {
  const connection = new FakeConnection();
  const dependencies: DeepSeekHarnessAdapterDependencies = {
    randomUUID: () => "native-1",
    createConnection: () => connection,
  };
  return { adapter: new DeepSeekHarnessAdapter({}, dependencies), connection };
}

async function collectUntilTurn(session: Awaited<ReturnType<typeof openCreated>>) {
  return collectUntilTurnFrom(session.outputs[Symbol.asyncIterator]());
}

async function collectUntilTurnFrom(iterator: AsyncIterator<HarnessOutput>) {
  const outputs = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    outputs.push(next.value);
    if (next.value.kind === "event" && next.value.event.type === "turn.completed") return outputs;
  }
  throw new Error("Output stream ended before Turn completion");
}

async function nextEvent(iterator: AsyncIterator<HarnessOutput>) {
  const next = await iterator.next();
  if (next.done || next.value.kind !== "event") throw new Error("Expected a Harness event");
  return next.value.event;
}

async function openCreated(adapter: DeepSeekHarnessAdapter) {
  const opened = await adapter.open({ kind: "create", cwd: "/workspace" });
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value;
}

describe("DeepSeekHarnessAdapter local Host", () => {
  it("inspects the local Host model catalog", async () => {
    const { adapter, connection } = fixture();

    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "ready",
      catalog: {
        models: [
          { label: "DeepSeek / DeepSeek V4 Flash" },
          { label: "DeepSeek / DeepSeek V4 Pro" },
        ],
      },
    });
    expect(connection.connected).toBe(true);
    expect(connection.calls.list).not.toHaveBeenCalled();
    await adapter.close();
  });

  it("publishes stable live and historical Checkpoints for every native Turn outcome", async () => {
    const { adapter, connection } = fixture();
    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "ready",
      capabilities: {
        history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: false },
      },
    });
    const session = await openCreated(adapter);
    expect(session.capabilities.history).toEqual({
      fork: true,
      forkAcrossCwd: false,
      rollbackLastTurn: false,
    });
    const sessionId = session.initialState.nativeRef?.nativeSessionId as string;
    const reasons = [
      { kind: "completed" },
      { kind: "error", error: { message: "model failed", code: "MODEL_FAILED" } },
      { kind: "aborted", reason: { kind: "user" } },
    ];
    const history: HistoryEntry[] = [];
    const liveCheckpoints: string[] = [];
    const iterator = session.outputs[Symbol.asyncIterator]();

    for (const [index, reason] of reasons.entries()) {
      const turn = index + 1;
      const startSeq = index * 3;
      const turnId = hostTurnIdSchema.parse(`host-turn-checkpoint-${turn}`);
      const collecting = collectUntilTurnFrom(iterator);
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: `prompt ${turn}` }],
      });
      connection.sessionEvent(sessionId, startSeq, "turn/start", { turn });
      connection.sessionEvent(sessionId, startSeq + 1, "user/message", {
        source: { kind: "user" },
        content: [{ type: "text", text: `prompt ${turn}` }],
      });
      connection.sessionEvent(sessionId, startSeq + 2, "turn/end", { turn, reason });
      const outputs = await collecting;
      const completed = outputs.find(
        (output) => output.kind === "event" && output.event.type === "turn.completed",
      );
      if (!completed || completed.kind !== "event" || completed.event.type !== "turn.completed") {
        throw new Error("Missing terminal event");
      }
      liveCheckpoints.push(completed.event.outcome.checkpoint?.checkpointId ?? "");
      history.push(...completedTurn(startSeq, turn, `prompt ${turn}`, reason));
    }

    connection.history.set(sessionId, history);
    const snapshot = await session.readSnapshot();
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    expect(liveCheckpoints).toEqual(["turn-end:2", "turn-end:5", "turn-end:8"]);
    expect(snapshot.value.turns.map((turn) => turn.checkpoint?.checkpointId)).toEqual(
      liveCheckpoints,
    );
    expect(snapshot.value.turns.map((turn) => turn.outcome.status)).toEqual([
      "succeeded",
      "failed",
      "cancelled",
    ]);
    await adapter.close();
  });

  it("Forks the exact completed prefix while a later source Turn is active", async () => {
    const { adapter, connection } = fixture();
    const sourceId = "session-source-active";
    const sourceHistory = [
      ...completedTurn(0, 1, "first"),
      event(3, "session/title", { title: "Between turns" }),
      ...completedTurn(4, 2, "second"),
      event(7, "turn/start", { turn: 3 }),
      event(8, "user/message", {
        source: { kind: "user" },
        content: [{ type: "text", text: "still running" }],
      }),
    ];
    connection.history.set(sourceId, sourceHistory);
    connection.cwd.set(sourceId, path.resolve("/workspace"));
    connection.forkedModel = {
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
      reasoningEffort: "low",
    };
    connection.forkHistoryTransform = (entries) => [
      ...entries,
      event((entries.at(-1)?.event.seq ?? -1) + 1, "sandbox/mode", {
        mode: "danger-full-access",
      }),
    ];

    const opened = await adapter.open({
      kind: "fork",
      sourceRef: sessionRef(sourceId),
      checkpoint: checkpointRef(sourceId, 2),
      cwd: "/workspace",
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    expect(connection.calls.fork).toHaveBeenCalledWith({
      sessionId: sourceId,
      atSeq: 2,
    });
    expect(session.initialState).toMatchObject({
      nativeRef: { nativeSessionId: "session-forked-1" },
      effectiveModel: encodeDeepSeekHarnessModelRef({
        provider: "deepseek-official",
        model: "deepseek-v4-pro",
      }),
      effectiveThinkingOptionId: "low",
    });
    const snapshot = await session.readSnapshot();
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    expect(snapshot.value.turns).toHaveLength(1);
    expect(snapshot.value.turns[0]).toMatchObject({
      nativeTurnRef: { nativeSessionId: "session-forked-1", nativeTurnKey: "turn:1" },
      checkpoint: { nativeSessionId: "session-forked-1", checkpointId: "turn-end:2" },
      input: [{ type: "text", text: "first" }],
    });
    expect(connection.history.get("session-forked-1")?.map((entry) => entry.event.type)).toEqual([
      "turn/start",
      "user/message",
      "turn/end",
      "session/title",
      "session/end-seed",
      "sandbox/mode",
    ]);
    expect(connection.history.get(sourceId)).toEqual(sourceHistory);

    const settledSourceHistory = [
      ...sourceHistory,
      event(9, "turn/end", { turn: 3, reason: { kind: "completed" } }),
    ];
    connection.history.set(sourceId, settledSourceHistory);
    const resumedSource = await adapter.open({
      kind: "resume",
      nativeRef: sessionRef(sourceId),
      cwd: "/workspace",
    });
    if (!resumedSource.ok) throw new Error(resumedSource.error.message);
    const sourceSession = resumedSource.value;
    const childTurnId = hostTurnIdSchema.parse("host-turn-fork-child");
    const sourceTurnId = hostTurnIdSchema.parse("host-turn-fork-source");
    const childCollecting = collectUntilTurn(session);
    const sourceCollecting = collectUntilTurn(sourceSession);
    await session.execute({
      type: "turn.start",
      turnId: childTurnId,
      input: [{ type: "text", text: "continue child" }],
    });
    await sourceSession.execute({
      type: "turn.start",
      turnId: sourceTurnId,
      input: [{ type: "text", text: "continue source" }],
    });
    expect(connection.calls.prompt).toHaveBeenCalledWith({
      sessionId: "session-forked-1",
      mode: "queue",
      content: [{ type: "text", text: "continue child" }],
    });
    expect(connection.calls.prompt).toHaveBeenCalledWith({
      sessionId: sourceId,
      mode: "queue",
      content: [{ type: "text", text: "continue source" }],
    });

    connection.sessionEvent("session-forked-1", 6, "turn/start", { turn: 2 });
    connection.sessionEvent("session-forked-1", 7, "user/message", {
      source: { kind: "user" },
      content: [{ type: "text", text: "continue child" }],
    });
    connection.sessionEvent("session-forked-1", 8, "turn/end", {
      turn: 2,
      reason: { kind: "completed" },
    });
    connection.sessionEvent(sourceId, 10, "turn/start", { turn: 4 });
    connection.sessionEvent(sourceId, 11, "user/message", {
      source: { kind: "user" },
      content: [{ type: "text", text: "continue source" }],
    });
    connection.sessionEvent(sourceId, 12, "turn/end", {
      turn: 4,
      reason: { kind: "completed" },
    });
    const [childOutputs, sourceOutputs] = await Promise.all([childCollecting, sourceCollecting]);
    expect(childOutputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "turn.completed",
            nativeTurnRef: expect.objectContaining({ nativeSessionId: "session-forked-1" }),
            outcome: expect.objectContaining({
              checkpoint: expect.objectContaining({ checkpointId: "turn-end:8" }),
            }),
          }),
        }),
      ]),
    );
    expect(sourceOutputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "turn.completed",
            nativeTurnRef: expect.objectContaining({ nativeSessionId: sourceId }),
            outcome: expect.objectContaining({
              checkpoint: expect.objectContaining({ checkpointId: "turn-end:12" }),
            }),
          }),
        }),
      ]),
    );

    connection.history.set("session-forked-1", [
      ...(connection.history.get("session-forked-1") ?? []),
      ...completedTurn(6, 2, "continue child"),
    ]);
    connection.history.set(sourceId, [
      ...settledSourceHistory,
      ...completedTurn(10, 4, "continue source"),
    ]);
    expect(JSON.stringify(connection.history.get("session-forked-1"))).toContain("continue child");
    expect(JSON.stringify(connection.history.get("session-forked-1"))).not.toContain(
      "continue source",
    );
    expect(JSON.stringify(connection.history.get(sourceId))).toContain("continue source");
    expect(JSON.stringify(connection.history.get(sourceId))).not.toContain("continue child");

    await sourceSession.close();
    await session.close();
    expect(connection.subscribers.size).toBe(0);
    await adapter.close();
  });

  it("adopts a verified child reported by workspace-attach-failed", async () => {
    const { adapter, connection } = fixture();
    const sourceId = "session-source-partial";
    connection.history.set(sourceId, completedTurn(0, 1, "first"));
    connection.cwd.set(sourceId, path.resolve("/workspace"));
    connection.forkFailure = "workspace-attach-failed";

    const opened = await adapter.open({
      kind: "fork",
      sourceRef: sessionRef(sourceId),
      checkpoint: checkpointRef(sourceId, 2),
      cwd: "/workspace",
    });
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.value.initialState.nativeRef?.nativeSessionId).toBe("session-forked-1");
      await opened.value.close();
    }
    expect(connection.subscribers.size).toBe(0);
    await adapter.close();
  });

  it("rejects foreign, stale, missing, and cross-cwd Fork inputs before native creation", async () => {
    const sourceId = "session-source-validation";
    const cases = [
      {
        name: "foreign source",
        mutate: (input: Record<string, unknown>) => ({
          ...input,
          sourceRef: { ...sessionRef(sourceId), harnessId: "pi" },
        }),
        code: "invalidRequest",
      },
      {
        name: "mismatched checkpoint",
        mutate: (input: Record<string, unknown>) => ({
          ...input,
          checkpoint: checkpointRef("another-session", 2),
        }),
        code: "invalidRequest",
      },
      {
        name: "malformed checkpoint",
        mutate: (input: Record<string, unknown>) => ({
          ...input,
          checkpoint: { ...checkpointRef(sourceId, 2), checkpointId: "turn-end:02" },
        }),
        code: "checkpointNotFound",
      },
      {
        name: "stale checkpoint",
        mutate: (input: Record<string, unknown>) => ({
          ...input,
          checkpoint: checkpointRef(sourceId, 99),
        }),
        code: "checkpointNotFound",
      },
      {
        name: "cross cwd",
        mutate: (input: Record<string, unknown>) => ({ ...input, cwd: "/other" }),
        code: "unsupported",
      },
    ];

    for (const testCase of cases) {
      const { adapter, connection } = fixture();
      connection.history.set(sourceId, completedTurn(0, 1, "first"));
      connection.cwd.set(sourceId, path.resolve("/workspace"));
      const input = testCase.mutate({
        kind: "fork",
        sourceRef: sessionRef(sourceId),
        checkpoint: checkpointRef(sourceId, 2),
        cwd: "/workspace",
      });
      const opened = await adapter.open(input as never);
      expect(opened, testCase.name).toMatchObject({
        ok: false,
        error: { code: testCase.code },
      });
      expect(connection.calls.fork, testCase.name).not.toHaveBeenCalled();
      expect(connection.subscribers.size, testCase.name).toBe(0);
      await adapter.close();
    }

    const { adapter, connection } = fixture();
    const missing = await adapter.open({
      kind: "fork",
      sourceRef: sessionRef("session-missing"),
      checkpoint: checkpointRef("session-missing", 2),
      cwd: "/workspace",
    });
    expect(missing).toMatchObject({ ok: false, error: { code: "sessionNotFound" } });
    expect(connection.calls.fork).not.toHaveBeenCalled();
    await adapter.close();

    const withoutCwd = fixture();
    withoutCwd.connection.history.set(sourceId, completedTurn(0, 1, "first"));
    withoutCwd.connection.calls.list.mockResolvedValueOnce(
      success({
        items: [{ sessionId: sourceId, updatedAt: 0, running: false, blank: false }],
      }),
    );
    await expect(
      withoutCwd.adapter.open({
        kind: "fork",
        sourceRef: sessionRef(sourceId),
        checkpoint: checkpointRef(sourceId, 2),
        cwd: "/workspace",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "protocolError" } });
    expect(withoutCwd.connection.calls.fork).not.toHaveBeenCalled();
    await withoutCwd.adapter.close();
  });

  it("fails closed on native and derived-history Fork mismatches and removes subscribers", async () => {
    const sourceId = "session-source-failure";
    const cases: Array<{
      name: string;
      configure(connection: FakeConnection): void;
      code: string;
    }> = [
      {
        name: "native checkpoint rejection",
        configure: (connection) => {
          connection.forkFailure = "fork-unavailable";
        },
        code: "checkpointNotFound",
      },
      {
        name: "child Model readback failed",
        configure: (connection) => {
          connection.calls.models.mockResolvedValueOnce({
            rpcId: RpcId("response"),
            result: {
              ok: false,
              error: { code: "internal", message: "model state unavailable", details: {} },
            },
          });
        },
        code: "nativeFailure",
      },
      {
        name: "source identity returned as child",
        configure: (connection) => {
          connection.forkChildId = sourceId as SessionId;
        },
        code: "protocolError",
      },
      {
        name: "raw prefix changed",
        configure: (connection) => {
          connection.forkHistoryTransform = (entries) =>
            entries.map((entry, index) =>
              index === 1
                ? event(entry.event.seq, "user/message", {
                    source: { kind: "user" },
                    content: [{ type: "text", text: "wrong" }],
                  })
                : entry,
            );
        },
        code: "protocolError",
      },
      {
        name: "later Turn leaked",
        configure: (connection) => {
          connection.forkHistoryTransform = (entries) => [
            ...entries,
            event((entries.at(-1)?.event.seq ?? 0) + 1, "turn/start", { turn: 2 }),
          ];
        },
        code: "protocolError",
      },
      {
        name: "partial success failed verification",
        configure: (connection) => {
          connection.forkFailure = "workspace-attach-failed";
          connection.forkHistoryTransform = (entries) => entries.slice(1);
        },
        code: "protocolError",
      },
    ];

    for (const testCase of cases) {
      const { adapter, connection } = fixture();
      connection.history.set(sourceId, completedTurn(0, 1, "first"));
      connection.cwd.set(sourceId, path.resolve("/workspace"));
      testCase.configure(connection);
      const opened = await adapter.open({
        kind: "fork",
        sourceRef: sessionRef(sourceId),
        checkpoint: checkpointRef(sourceId, 2),
        cwd: "/workspace",
      });
      expect(opened, testCase.name).toMatchObject({
        ok: false,
        error: { code: testCase.code },
      });
      expect(connection.subscribers.size, testCase.name).toBe(0);
      await adapter.close();
    }
  });

  it("discovers native Permission Modes dynamically and confirms the create-time selection", async () => {
    const { adapter, connection } = fixture();
    connection.enablePermissionModes();

    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "ready",
      permissionModes: {
        modes: [
          { id: "team-safe", label: "Team safe" },
          { id: "trusted-run", label: "Trusted run" },
        ],
        defaultModeId: "team-safe",
      },
      capabilities: { configuration: { selectPermissionMode: true } },
    });
    const opened = await adapter.open({
      kind: "create",
      cwd: "/workspace",
      permissionModeId: harnessPermissionModeIdSchema.parse("trusted-run"),
    });
    if (!opened.ok) throw new Error(opened.error.message);

    expect(opened.value.capabilities.configuration.selectPermissionMode).toBe(true);
    expect(opened.value.initialState.effectivePermissionModeId).toBe("trusted-run");
    expect(connection.calls.commandExecute).toHaveBeenCalledWith(
      "session-native-1",
      "/permission trusted-run",
    );
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { state: { effectivePermissionModeId: "trusted-run" } },
    });
    await adapter.close();
  });

  it("restores, refreshes, and higher-seq syncs the complete Permission Mode state", async () => {
    const { adapter, connection } = fixture();
    connection.enablePermissionModes();
    connection.setPermissionMode(SESSION_ID, "trusted-run", 5);
    const opened = await adapter.open({
      kind: "resume",
      cwd: "/workspace",
      nativeRef: {
        harnessId: adapter.harnessId,
        nativeSessionId: SESSION_ID,
        formatVersion: 1,
      },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    expect(session.initialState.effectivePermissionModeId).toBe("trusted-run");

    connection.setPermissionMode(SESSION_ID, "team-safe", 6);
    await expect(session.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { state: { effectivePermissionModeId: "team-safe" } },
    });

    const iterator = session.outputs[Symbol.asyncIterator]();
    connection.setPermissionMode(SESSION_ID, "trusted-run", 8);
    connection.mux(SESSION_ID, {
      type: "session/projection",
      sessionId: SESSION_ID,
      key: "permissions",
      value: connection.permissionProjection("trusted-run"),
      seq: 8,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        kind: "event",
        event: {
          type: "session.state.changed",
          state: { effectivePermissionModeId: "trusted-run" },
        },
      },
    });
    connection.mux(SESSION_ID, {
      type: "session/projection",
      sessionId: SESSION_ID,
      key: "permissions",
      value: connection.permissionProjection("team-safe"),
      seq: 7,
    });
    const model = encodeDeepSeekHarnessModelRef({
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
    });
    const selectingModel = session.execute({ type: "model.select", model });
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        kind: "event",
        event: {
          type: "session.state.changed",
          state: { effectiveModel: model, effectivePermissionModeId: "trusted-run" },
        },
      },
    });
    await expect(selectingModel).resolves.toEqual({ ok: true, value: { completed: true } });
    await adapter.close();
  });

  it("selects Permission Mode during a live Turn and publishes even an idempotent confirmation", async () => {
    const { adapter, connection } = fixture();
    connection.enablePermissionModes();
    connection.setPermissionMode(SESSION_ID, "team-safe", 0);
    const opened = await adapter.open({
      kind: "resume",
      cwd: "/workspace",
      nativeRef: {
        harnessId: adapter.harnessId,
        nativeSessionId: SESSION_ID,
        formatVersion: 1,
      },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("permission-live-turn"),
      input: [{ type: "text", text: "continue" }],
    });
    const iterator = session.outputs[Symbol.asyncIterator]();
    connection.calls.commandExecute.mockImplementationOnce((agentId: string) => {
      connection.mux(agentId, {
        type: "session/projection",
        sessionId: agentId as SessionId,
        key: "permissions",
        value: {
          options: [
            ...PERMISSION_OPTIONS,
            {
              value: "custom",
              name: "Custom",
              description: "Native knobs are between preset events.",
            },
          ],
          currentValue: "custom",
        },
        seq: 1,
      });
      connection.setPermissionMode(agentId, "trusted-run", 2);
      return Promise.resolve(
        commandSuccess({
          commandId: "permission-command",
          result: { kind: "success" as const, text: "preset trusted-run" },
        }),
      );
    });

    const selecting = session.execute({
      type: "permissionMode.select",
      permissionModeId: harnessPermissionModeIdSchema.parse("trusted-run"),
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        kind: "event",
        event: {
          type: "session.state.changed",
          state: { effectivePermissionModeId: "trusted-run" },
        },
      },
    });
    await expect(selecting).resolves.toEqual({ ok: true, value: { completed: true } });

    const selectingAgain = session.execute({
      type: "permissionMode.select",
      permissionModeId: harnessPermissionModeIdSchema.parse("trusted-run"),
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        kind: "event",
        event: {
          type: "session.state.changed",
          state: { effectivePermissionModeId: "trusted-run" },
        },
      },
    });
    await expect(selectingAgain).resolves.toEqual({ ok: true, value: { completed: true } });
    await adapter.close();
  });

  it("keeps the confirmed Permission Mode when the native command rejects a selection", async () => {
    const { adapter, connection } = fixture();
    connection.enablePermissionModes();
    connection.setPermissionMode(SESSION_ID, "trusted-run", 0);
    const opened = await adapter.open({
      kind: "resume",
      cwd: "/workspace",
      nativeRef: {
        harnessId: adapter.harnessId,
        nativeSessionId: SESSION_ID,
        formatVersion: 1,
      },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    connection.calls.commandExecute.mockResolvedValueOnce(
      commandSuccess({
        commandId: "command-rejected",
        result: { kind: "error", text: "policy rejected" },
      }),
    );

    await expect(
      opened.value.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("team-safe"),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "nativeFailure", message: "policy rejected" },
    });
    const iterator = opened.value.outputs[Symbol.asyncIterator]();
    const model = encodeDeepSeekHarnessModelRef({
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
    });
    const selectingModel = opened.value.execute({ type: "model.select", model });
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        kind: "event",
        event: {
          type: "session.state.changed",
          state: { effectivePermissionModeId: "trusted-run" },
        },
      },
    });
    await expect(selectingModel).resolves.toEqual({ ok: true, value: { completed: true } });
    await adapter.close();
  });

  it("faults when a Permission Mode RPC error leaves unconfirmed partial native state", async () => {
    const { adapter, connection } = fixture();
    connection.enablePermissionModes();
    connection.setPermissionMode(SESSION_ID, "trusted-run", 0);
    const opened = await adapter.open({
      kind: "resume",
      cwd: "/workspace",
      nativeRef: {
        harnessId: adapter.harnessId,
        nativeSessionId: SESSION_ID,
        formatVersion: 1,
      },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    connection.calls.commandExecute.mockImplementationOnce((agentId: string) => {
      connection.setPermissionMode(agentId, "custom", 1);
      return Promise.resolve({
        ok: false,
        error: { code: "internal" as const, message: "permission setter failed", details: {} },
      });
    });
    const fault = opened.value.outputs[Symbol.asyncIterator]().next();

    await expect(
      opened.value.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("team-safe"),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "protocolError" } });
    await expect(fault).resolves.toMatchObject({
      value: { kind: "event", event: { type: "session.faulted" } },
    });
    await adapter.close();
  });

  it("fails closed when native Permission Mode success cannot be confirmed", async () => {
    const { adapter, connection } = fixture();
    connection.enablePermissionModes();
    connection.setPermissionMode(SESSION_ID, "team-safe", 0);
    const opened = await adapter.open({
      kind: "resume",
      cwd: "/workspace",
      nativeRef: {
        harnessId: adapter.harnessId,
        nativeSessionId: SESSION_ID,
        formatVersion: 1,
      },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    connection.calls.commandExecute.mockResolvedValueOnce(
      commandSuccess({
        commandId: "command-mismatch",
        result: { kind: "success", text: "preset trusted-run" },
      }),
    );
    const fault = opened.value.outputs[Symbol.asyncIterator]().next();

    await expect(
      opened.value.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("trusted-run"),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "nativeFailure", message: expect.stringContaining("did not activate") },
    });
    await expect(fault).resolves.toMatchObject({
      value: { kind: "event", event: { type: "session.faulted" } },
    });
    await adapter.close();
  });

  it("fails inspection and open instead of downgrading malformed Permission Mode protocol", async () => {
    const { adapter, connection } = fixture();
    connection.calls.settingsDescribe.mockResolvedValueOnce(
      success({
        writable: true,
        hasDocument: false,
        namespaces: [
          {
            ns: "permission",
            schema: permissionSettingsSchema(PERMISSION_OPTIONS),
            value: { defaultPreset: "missing" },
            applies: "live",
            secrets: [],
            revision: 0,
          },
        ],
      }),
    );
    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "unavailable",
      error: { code: "protocolError" },
    });

    connection.enablePermissionModes();
    connection.calls.commandList.mockResolvedValueOnce(
      commandSuccess([{ name: "compact", description: "Compact history" }]),
    );
    await expect(adapter.open({ kind: "create", cwd: "/workspace" })).resolves.toMatchObject({
      ok: false,
      error: { code: "protocolError" },
    });
    await adapter.close();
  });

  it("creates an official Session, selects the requested Model, and projects a live Tool Turn", async () => {
    const { adapter, connection } = fixture();
    const model = encodeDeepSeekHarnessModelRef({
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
    });
    const opened = await adapter.open({ kind: "create", cwd: "/workspace", model });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    const sessionId = session.initialState.nativeRef?.nativeSessionId;
    expect(sessionId).toBe("session-native-1");
    expect(connection.calls.create).toHaveBeenCalledWith({
      cwd: path.resolve("/workspace"),
      sessionId: "session-native-1",
    });
    expect(connection.calls.selectModel).toHaveBeenCalledWith({
      sessionId: "session-native-1",
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
    });
    expect(session.initialState).toMatchObject({
      effectiveModel: model,
      effectiveThinkingOptionId: "high",
      availableThinkingOptions: expect.arrayContaining([
        { id: "high", label: "High" },
        { id: "max", label: "Max" },
      ]),
    });

    const turnId = hostTurnIdSchema.parse("host-turn-1");
    await expect(
      session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: "hello" }] }),
    ).resolves.toEqual({ ok: true, value: { turnId } });
    const collecting = collectUntilTurn(session);
    connection.sessionEvent(sessionId as string, 1, "turn/start", { turn: 1 });
    connection.sessionEvent(sessionId as string, 2, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", text: "answer" },
    });
    connection.sessionEvent(sessionId as string, 3, "tool/call", {
      turn: 1,
      step: 1,
      callId: "read-1",
      name: "read",
      arguments: '{"file_path":"README.md"}',
    });
    connection.sessionEvent(sessionId as string, 4, "tool/result", {
      turn: 1,
      step: 1,
      message: {
        source: { kind: "tool", callId: "read-1" },
        content: [
          {
            type: "tool-result",
            toolCallId: "read-1",
            content: [{ type: "text", text: "contents" }],
            isError: false,
          },
        ],
      },
    });
    connection.sessionEvent(sessionId as string, 5, "assistant/message", {
      turn: 1,
      step: 1,
      message: { content: [{ type: "text", text: "answer" }] },
      usage: { inputTokens: 10, outputTokens: 4 },
    });
    connection.sessionEvent(sessionId as string, 6, "turn/end", {
      turn: 1,
      reason: { kind: "completed" },
    });
    const outputs = await collecting;
    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "item.completed",
            snapshot: expect.objectContaining({
              item: expect.objectContaining({
                type: "toolExecution",
                output: { content: [{ type: "text", text: "contents" }] },
              }),
            }),
          }),
        }),
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "turn.completed",
            nativeTurnRef: expect.objectContaining({ nativeTurnKey: "turn:1" }),
            outcome: expect.objectContaining({
              status: "succeeded",
              checkpoint: expect.objectContaining({ checkpointId: "turn-end:6" }),
            }),
          }),
        }),
      ]),
    );
    await session.close();
    expect(connection.closed).toBe(false);
    await adapter.close();
    expect(connection.closed).toBe(true);
  });

  it("requires a native Permission Mode catalog for approval-required Sessions", async () => {
    const { adapter, connection } = fixture();

    await expect(
      adapter.open({
        kind: "create",
        cwd: "/workspace",
        executionPolicy: "approval-required",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "unsupported", retryable: false },
    });
    expect(connection.calls.create).not.toHaveBeenCalled();
    await adapter.close();
  });

  it("selects and confirms the native safe default for approval-required Sessions", async () => {
    const { adapter, connection } = fixture();
    connection.enablePermissionModes();

    const opened = await adapter.open({
      kind: "create",
      cwd: "/workspace",
      executionPolicy: "approval-required",
    });
    if (!opened.ok) throw new Error(opened.error.message);

    expect(connection.calls.commandExecute).toHaveBeenCalledWith(
      "session-native-1",
      "/permission team-safe",
    );
    expect(opened.value.initialState.effectivePermissionModeId).toBe("team-safe");
    await opened.value.close();
    await adapter.close();
  });

  it("rejects an explicit Permission Mode combined with approval-required delegation", async () => {
    const { adapter, connection } = fixture();
    connection.enablePermissionModes();

    await expect(
      adapter.open({
        kind: "create",
        cwd: "/workspace",
        executionPolicy: "approval-required",
        permissionModeId: harnessPermissionModeIdSchema.parse("trusted-run"),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidRequest", retryable: false },
    });
    expect(connection.calls.create).not.toHaveBeenCalled();
    await adapter.close();
  });

  it("rejects danger-full-access as the approval-required default", async () => {
    const { adapter, connection } = fixture();
    connection.enablePermissionModes(
      [{ value: "danger-full-access", name: "Danger full access" }, ...PERMISSION_OPTIONS],
      "danger-full-access",
    );

    await expect(
      adapter.open({
        kind: "create",
        cwd: "/workspace",
        executionPolicy: "approval-required",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "unsupported", retryable: false },
    });
    expect(connection.calls.create).not.toHaveBeenCalled();
    await adapter.close();
  });

  it("fails approval-required creation when projection does not confirm the safe default", async () => {
    const { adapter, connection } = fixture();
    connection.enablePermissionModes();
    connection.calls.commandExecute.mockImplementationOnce((sessionId: string) => {
      connection.setPermissionMode(sessionId, "trusted-run");
      return Promise.resolve(
        commandSuccess({
          commandId: "command-1",
          result: { kind: "success" as const, text: "preset team-safe" },
        }),
      );
    });

    await expect(
      adapter.open({
        kind: "create",
        cwd: "/workspace",
        executionPolicy: "approval-required",
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "nativeFailure",
        message: "DeepSeek Harness did not activate the requested Permission Mode",
        retryable: false,
      },
    });
    await adapter.close();
  });

  it("uses danger-full-access only for unattended delegated Sessions", async () => {
    const { adapter, connection } = fixture();

    const regular = await adapter.open({ kind: "create", cwd: "/workspace" });
    expect(regular.ok).toBe(true);
    expect(connection.calls.commandExecute).not.toHaveBeenCalled();
    if (!regular.ok) throw new Error(regular.error.message);
    await regular.value.close();

    const delegated = await adapter.open({
      kind: "create",
      cwd: "/workspace",
      executionPolicy: "unattended-full-access",
    });
    expect(delegated.ok).toBe(true);
    expect(connection.calls.commandExecute).toHaveBeenCalledWith(
      "session-native-1",
      "/permission danger-full-access",
    );
    await adapter.close();
  });

  it("fails delegated Session creation when danger-full-access is not confirmed", async () => {
    const { adapter, connection } = fixture();
    connection.calls.commandExecute.mockResolvedValueOnce(
      commandSuccess({
        commandId: "command-1",
        result: { kind: "success", text: "preset danger-full-access" },
      }),
    );

    await expect(
      adapter.open({
        kind: "create",
        cwd: "/workspace",
        executionPolicy: "unattended-full-access",
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "nativeFailure",
        message: "DeepSeek Harness did not confirm danger-full-access with approval policy never",
        retryable: false,
      },
    });
    await adapter.close();
  });

  it("fails delegated Session creation when the native permission command fails", async () => {
    const { adapter, connection } = fixture();
    connection.calls.commandExecute.mockResolvedValueOnce(
      commandSuccess({
        commandId: "command-1",
        result: { kind: "error", text: "permission command failed" },
      }),
    );

    await expect(
      adapter.open({
        kind: "create",
        cwd: "/workspace",
        executionPolicy: "unattended-full-access",
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "nativeFailure",
        message: "permission command failed",
        retryable: false,
      },
    });
    await adapter.close();
  });

  it("selects another Model for a resumed Session and publishes confirmed state", async () => {
    const { adapter, connection } = fixture();
    const opened = await adapter.open({
      kind: "resume",
      cwd: "/workspace",
      nativeRef: {
        harnessId: adapter.harnessId,
        nativeSessionId: SESSION_ID,
        formatVersion: 1,
      },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    expect(session.capabilities.configuration.selectModel).toBe(true);
    const model = encodeDeepSeekHarnessModelRef({
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
    });
    const iterator = session.outputs[Symbol.asyncIterator]();

    const selecting = session.execute({ type: "model.select", model });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        kind: "event",
        event: {
          type: "session.state.changed",
          state: {
            nativeRef: { nativeSessionId: SESSION_ID },
            effectiveModel: model,
            effectiveThinkingOptionId: "high",
            availableThinkingOptions: expect.arrayContaining([
              { id: "high", label: "High" },
              { id: "max", label: "Max" },
            ]),
          },
        },
      },
    });
    await expect(selecting).resolves.toEqual({ ok: true, value: { completed: true } });
    expect(connection.calls.selectModel).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
    });
    expect(connection.calls.models).toHaveBeenCalledTimes(2);
    await adapter.close();
  });

  it("advertises Thinking options from the Host model catalog", async () => {
    const { adapter } = fixture();

    await expect(adapter.inspect()).resolves.toMatchObject({
      status: "ready",
      capabilities: { configuration: { selectThinkingOption: true } },
      catalog: {
        defaultThinkingOptionId: "high",
        thinkingOptions: [
          { id: "off", label: "Off" },
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
          { id: "max", label: "Max" },
        ],
        models: [
          { supportedThinkingOptionIds: ["off", "low", "high"] },
          { supportedThinkingOptionIds: ["off", "low", "high", "max"] },
        ],
      },
    });
    await adapter.close();
  });

  it("keeps current Model and Thinking state ahead of the last historical request", async () => {
    const { adapter, connection } = fixture();
    const current: ModelSelection = {
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
      reasoningEffort: "high",
    };
    const model = encodeDeepSeekHarnessModelRef(current);
    connection.currentModel = current;
    connection.history.set(SESSION_ID, [
      event(0, "turn/start", { turn: 1 }),
      event(1, "request/header", { header: { config: CURRENT_MODEL } }),
      event(2, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ]);

    const opened = await adapter.open({
      kind: "resume",
      cwd: "/workspace",
      nativeRef: {
        harnessId: adapter.harnessId,
        nativeSessionId: SESSION_ID,
        formatVersion: 1,
      },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    const expectedState = {
      effectiveModel: model,
      effectiveThinkingOptionId: "high",
      availableThinkingOptions: expect.arrayContaining([
        { id: "high", label: "High" },
        { id: "max", label: "Max" },
      ]),
    };

    expect(session.initialState).toMatchObject(expectedState);
    await expect(session.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        state: expectedState,
        turns: [{ model: encodeDeepSeekHarnessModelRef(CURRENT_MODEL) }],
      },
    });
    await adapter.close();
  });

  it("creates a Session with the requested Thinking option", async () => {
    const { adapter, connection } = fixture();
    const opened = await adapter.open({
      kind: "create",
      cwd: "/workspace",
      thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    expect(session.capabilities.configuration.selectThinkingOption).toBe(true);
    expect(connection.calls.selectModel).toHaveBeenCalledWith({
      sessionId: "session-native-1",
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
    });
    await expect(session.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        state: {
          effectiveThinkingOptionId: "high",
          availableThinkingOptions: expect.arrayContaining([
            { id: "off", label: "Off" },
            { id: "high", label: "High" },
          ]),
        },
      },
    });
    await session.close();
    await adapter.close();
  });

  it("rejects Thinking selection when native readback differs without publishing state", async () => {
    const { adapter, connection } = fixture();
    const opened = await adapter.open({
      kind: "resume",
      cwd: "/workspace",
      nativeRef: {
        harnessId: adapter.harnessId,
        nativeSessionId: SESSION_ID,
        formatVersion: 1,
      },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    const output = session.outputs[Symbol.asyncIterator]().next();
    connection.calls.models.mockResolvedValueOnce(
      success<SessionModels>({
        current: { ...CURRENT_MODEL, reasoningEffort: "low" },
        routable: true,
        groups: MODEL_GROUPS,
        failures: [],
      }),
    );

    await expect(
      session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "nativeFailure",
        message: "DeepSeek Harness did not activate the requested Thinking option",
        retryable: false,
      },
    });
    await session.close();
    await expect(output).resolves.toEqual({ done: true, value: undefined });
    await adapter.close();
  });

  it("selects Thinking for a resumed Session and publishes confirmed state", async () => {
    const { adapter, connection } = fixture();
    const opened = await adapter.open({
      kind: "resume",
      cwd: "/workspace",
      nativeRef: {
        harnessId: adapter.harnessId,
        nativeSessionId: SESSION_ID,
        formatVersion: 1,
      },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    const iterator = session.outputs[Symbol.asyncIterator]();

    const selecting = session.execute({
      type: "thinking.select",
      thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        kind: "event",
        event: {
          type: "session.state.changed",
          state: {
            nativeRef: { nativeSessionId: SESSION_ID },
            effectiveModel: expect.anything(),
            effectiveThinkingOptionId: "high",
            availableThinkingOptions: expect.arrayContaining([
              { id: "off", label: "Off" },
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ]),
          },
        },
      },
    });
    await expect(selecting).resolves.toEqual({ ok: true, value: { completed: true } });
    expect(connection.calls.selectModel).toHaveBeenLastCalledWith({
      sessionId: SESSION_ID,
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
    });
    await adapter.close();
  });

  it("discovers and executes dsh.compact through the native Remote command service", async () => {
    const { adapter, connection } = fixture();
    const opened = await adapter.open({
      kind: "resume",
      cwd: "/workspace",
      nativeRef: {
        harnessId: adapter.harnessId,
        nativeSessionId: SESSION_ID,
        formatVersion: 1,
      },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    const commands = session.commands;
    if (!commands) throw new Error("DeepSeek Harness Session did not expose commands");

    await expect(commands.list()).resolves.toMatchObject({
      ok: true,
      value: { commands: [{ id: "dsh.compact", invocation: "/compact" }] },
    });
    expect(connection.calls.commandList).toHaveBeenCalledWith(SESSION_ID);
    let resolveExecution:
      ((value: { ok: true; value: DeepSeekCommandExecution }) => void) | undefined;
    connection.calls.commandExecute.mockImplementationOnce(
      () =>
        new Promise<{ ok: true; value: DeepSeekCommandExecution }>((resolve) => {
          resolveExecution = resolve;
        }),
    );
    const iterator = session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("manual-compact");
    await expect(
      commands.execute({
        turnId,
        commandId: "dsh.compact",
      }),
    ).resolves.toEqual({ ok: true, value: { turnId } });
    expect(await nextEvent(iterator)).toEqual({ type: "turn.started", turnId });
    const started = await nextEvent(iterator);
    if (started.type !== "item.started") throw new Error("Expected compaction Item start");
    expect(started).toMatchObject({
      type: "item.started",
      turnId,
      item: { type: "contextCompaction" },
    });
    await expect(session.readSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });

    resolveExecution?.(
      commandSuccess({
        commandId: "native-command-1",
        result: { kind: "success", text: "compacted" },
      }),
    );
    expect(await nextEvent(iterator)).toEqual({
      type: "item.completed",
      turnId,
      snapshot: { item: started.item, outcome: { status: "succeeded" } },
    });
    expect(await nextEvent(iterator)).toEqual({
      type: "turn.completed",
      turnId,
      outcome: { status: "succeeded" },
    });
    expect(connection.calls.commandExecute).toHaveBeenCalledWith(
      SESSION_ID,
      "/compact",
      expect.any(AbortSignal),
    );
    expect(connection.calls.prompt).not.toHaveBeenCalled();
    await expect(session.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [] },
    });
    await adapter.close();
  });

  it("hides dsh.compact when the native deployment does not advertise the argument-free command", async () => {
    const { adapter, connection } = fixture();
    connection.calls.commandList.mockResolvedValueOnce(
      commandSuccess([
        {
          name: "compact",
          description: "Different deployment contract",
          input: { hint: "<instructions>" },
        },
      ]),
    );
    const session = await openCreated(adapter);
    const commands = session.commands;
    if (!commands) throw new Error("DeepSeek Harness Session did not expose commands");

    await expect(commands.list()).resolves.toEqual({
      ok: true,
      value: { commands: [] },
    });
    await adapter.close();
  });

  it("rejects unknown Harness commands and command arguments without touching the Host", async () => {
    const { adapter, connection } = fixture();
    const session = await openCreated(adapter);
    const commands = session.commands;
    if (!commands) throw new Error("DeepSeek Harness Session did not expose commands");

    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("manual-x"),
        commandId: "dsh.unknown",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    await expect(
      commands.execute({
        turnId: hostTurnIdSchema.parse("manual-compact"),
        commandId: "dsh.compact",
        arguments: { text: "keep details" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(connection.calls.commandExecute).not.toHaveBeenCalled();
    expect(connection.calls.prompt).not.toHaveBeenCalled();
    await adapter.close();
  });

  it("fails the temporary Turn when the native command does not resolve", async () => {
    const { adapter, connection } = fixture();
    const session = await openCreated(adapter);
    const commands = session.commands;
    if (!commands) throw new Error("DeepSeek Harness Session did not expose commands");
    const iterator = session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("missing-compact");

    await expect(commands.execute({ turnId, commandId: "dsh.compact" })).resolves.toEqual({
      ok: true,
      value: { turnId },
    });
    expect((await nextEvent(iterator)).type).toBe("turn.started");
    const started = await nextEvent(iterator);
    expect(started.type).toBe("item.started");
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "item.completed",
      snapshot: { outcome: { status: "failed", error: { code: "nativeFailure" } } },
    });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "turn.completed",
      outcome: { status: "failed", error: { code: "nativeFailure" } },
    });
    expect(connection.calls.prompt).not.toHaveBeenCalled();
    await adapter.close();
  });

  it("projects the native compact busy result as a failed temporary Turn", async () => {
    const { adapter, connection } = fixture();
    const session = await openCreated(adapter);
    const commands = session.commands;
    if (!commands) throw new Error("DeepSeek Harness Session did not expose commands");
    connection.calls.commandExecute.mockResolvedValueOnce(
      commandSuccess({
        commandId: "native-command-1",
        result: {
          kind: "error",
          text: "Compaction is unavailable because this process has an active compaction, or the agent is not idle.",
        },
      }),
    );
    const iterator = session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("busy-compact");

    await commands.execute({ turnId, commandId: "dsh.compact" });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "item.completed",
      snapshot: { outcome: { status: "failed", error: { code: "sessionBusy" } } },
    });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "turn.completed",
      outcome: { status: "failed", error: { code: "sessionBusy" } },
    });
    await expect(session.readSnapshot()).resolves.toMatchObject({ ok: true });
    await adapter.close();
  });

  it("cancels a running native compact command through its AbortSignal", async () => {
    const { adapter, connection } = fixture();
    const session = await openCreated(adapter);
    const commands = session.commands;
    if (!commands) throw new Error("DeepSeek Harness Session did not expose commands");
    let commandSignal: AbortSignal | undefined;
    connection.calls.commandExecute.mockImplementationOnce(
      (_sessionId: SessionId, _line: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          commandSignal = signal;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const iterator = session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("cancel-compact");

    await commands.execute({
      turnId,
      commandId: "dsh.compact",
    });
    await nextEvent(iterator);
    await nextEvent(iterator);
    await expect(session.execute({ type: "turn.cancel", turnId })).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(commandSignal?.aborted).toBe(true);
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "item.completed",
      snapshot: { outcome: { status: "cancelled" } },
    });
    await expect(nextEvent(iterator)).resolves.toMatchObject({
      type: "turn.completed",
      outcome: { status: "cancelled" },
    });
    await adapter.close();
  });

  it("preserves the confirmed Model when native selection fails", async () => {
    const { adapter, connection } = fixture();
    const session = await openCreated(adapter);
    const model = encodeDeepSeekHarnessModelRef({
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
    });
    connection.calls.selectModel.mockResolvedValueOnce({
      rpcId: RpcId("selection-failed"),
      result: {
        ok: false,
        error: { code: "model-unavailable", message: "Model is unavailable", details: {} },
      },
    });

    await expect(session.execute({ type: "model.select", model })).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Model is unavailable") },
    });
    expect(connection.calls.models).toHaveBeenCalledTimes(1);
    await expect(session.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { state: { effectiveModel: encodeDeepSeekHarnessModelRef(CURRENT_MODEL) } },
    });
    expect(connection.calls.models).toHaveBeenCalledTimes(2);
    await adapter.close();
  });

  it("rejects Model selection during a Turn", async () => {
    const { adapter, connection } = fixture();
    const session = await openCreated(adapter);
    const turnId = hostTurnIdSchema.parse("host-turn-model-busy");
    await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "hello" }],
    });
    const model = encodeDeepSeekHarnessModelRef({
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
    });

    await expect(session.execute({ type: "model.select", model })).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    expect(connection.calls.selectModel).not.toHaveBeenCalled();
    await adapter.close();
  });

  it("rejects Turn admission and snapshot reads while Model selection is pending", async () => {
    const { adapter, connection } = fixture();
    const session = await openCreated(adapter);
    const model = encodeDeepSeekHarnessModelRef({
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
    });
    let releaseSelection: (() => void) | undefined;
    connection.calls.selectModel.mockImplementationOnce(
      ({ provider, model: modelId }: { provider: string; model: string }) =>
        new Promise((resolve) => {
          releaseSelection = () => {
            connection.currentModel = { provider, model: modelId, reasoningEffort: "high" };
            resolve(success({ selected: connection.currentModel }));
          };
        }),
    );

    const selecting = session.execute({ type: "model.select", model });
    await expect(
      session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("host-turn-during-model-selection"),
        input: [{ type: "text", text: "hello" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    await expect(session.readSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    expect(connection.calls.prompt).not.toHaveBeenCalled();
    releaseSelection?.();
    await expect(selecting).resolves.toEqual({ ok: true, value: { completed: true } });
    await adapter.close();
  });

  it("rejects selection when native readback differs from the request", async () => {
    const { adapter, connection } = fixture();
    const session = await openCreated(adapter);
    const previousModel = encodeDeepSeekHarnessModelRef(CURRENT_MODEL);
    const model = encodeDeepSeekHarnessModelRef({
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
    });
    connection.calls.selectModel.mockResolvedValueOnce(
      success({
        selected: {
          provider: "deepseek-official",
          model: "deepseek-v4-pro",
          reasoningEffort: "high",
        },
      }),
    );

    await expect(session.execute({ type: "model.select", model })).resolves.toEqual({
      ok: false,
      error: {
        code: "nativeFailure",
        message: "DeepSeek Harness did not activate the requested Model",
        retryable: false,
      },
    });
    await expect(session.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { state: { effectiveModel: previousModel } },
    });
    await adapter.close();
  });

  it("projects Session Usage with a context window for a known Model", async () => {
    const { adapter, connection } = fixture();
    const session = await openCreated(adapter);
    const sessionId = session.initialState.nativeRef?.nativeSessionId;
    const turnId = hostTurnIdSchema.parse("host-turn-usage");
    await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "hello" }],
    });
    const collecting = collectUntilTurn(session);
    connection.sessionEvent(sessionId as string, 1, "request/context", {
      provider: "deepseek-official",
      model: "deepseek-chat",
      contextWindow: 128_000,
    });
    connection.mux(sessionId as string, {
      type: "session/projection",
      sessionId: sessionId as SessionId,
      key: "sessionStats",
      value: { decodeTokens: 164, decodeMs: 1_000 },
      seq: 1,
    });
    connection.sessionEvent(sessionId as string, 2, "request/header", {
      header: { config: { provider: "deepseek-official", model: "deepseek-chat" } },
    });
    connection.sessionEvent(sessionId as string, 3, "turn/start", { turn: 1 });
    connection.sessionEvent(sessionId as string, 4, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: {
        type: "usage",
        usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 5, reasoningTokens: 2 },
      },
    });
    connection.sessionEvent(sessionId as string, 5, "assistant/message", {
      turn: 1,
      step: 1,
      message: { content: [{ type: "text", text: "answer" }] },
    });
    connection.sessionEvent(sessionId as string, 6, "turn/end", {
      turn: 1,
      reason: { kind: "completed" },
    });
    const outputs = await collecting;
    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "session.usage.changed",
            observedForTurnId: turnId,
            usage: expect.objectContaining({
              inputTokens: 10,
              outputTokens: 4,
              cachedInputTokens: 5,
              reasoningOutputTokens: 2,
              cacheHitRatePercent: 33.33333333333333,
              outputTokensPerSecond: 164,
              contextUsedTokens: 15,
              contextWindowTokens: 128_000,
            }),
          }),
        }),
      ]),
    );
    await session.close();
    await adapter.close();
  });

  it("uses the context window DeepSeek Harness advertises on request/context", async () => {
    const { adapter, connection } = fixture();
    const session = await openCreated(adapter);
    const sessionId = session.initialState.nativeRef?.nativeSessionId;
    const turnId = hostTurnIdSchema.parse("host-turn-context");
    await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "hello" }],
    });
    const collecting = collectUntilTurn(session);
    connection.sessionEvent(sessionId as string, 1, "request/context", {
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      contextWindow: 131_072,
    });
    connection.sessionEvent(sessionId as string, 2, "turn/start", { turn: 1 });
    connection.sessionEvent(sessionId as string, 3, "assistant/message", {
      turn: 1,
      step: 1,
      message: { content: [{ type: "text", text: "answer" }] },
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 5 },
    });
    connection.sessionEvent(sessionId as string, 4, "turn/end", {
      turn: 1,
      reason: { kind: "completed" },
    });
    const outputs = await collecting;
    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "session.usage.changed",
            observedForTurnId: turnId,
            usage: expect.objectContaining({
              inputTokens: 10,
              outputTokens: 4,
              cachedInputTokens: 5,
              cacheHitRatePercent: 33.33333333333333,
              contextUsedTokens: 15,
              contextWindowTokens: 131_072,
            }),
          }),
        }),
      ]),
    );
    await session.close();
    await adapter.close();
  });

  it("accumulates Usage across Turns and replaces duplicate step reports", async () => {
    const { adapter, connection } = fixture();
    const session = await openCreated(adapter);
    const sessionId = session.initialState.nativeRef?.nativeSessionId;
    const iterator = session.outputs[Symbol.asyncIterator]();
    const collectTurn = async (): Promise<unknown[]> => {
      const outputs: unknown[] = [];
      for (;;) {
        const result = await iterator.next();
        if (result.done) throw new Error("Output stream ended before Turn completion");
        outputs.push(result.value);
        if (result.value.kind === "event" && result.value.event.type === "turn.completed") {
          return outputs;
        }
      }
    };

    const firstTurn = hostTurnIdSchema.parse("host-turn-aggregate-1");
    await session.execute({
      type: "turn.start",
      turnId: firstTurn,
      input: [{ type: "text", text: "first" }],
    });
    const firstCollecting = collectTurn();
    connection.sessionEvent(sessionId as string, 1, "request/context", {
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      contextWindow: 128_000,
    });
    connection.sessionEvent(sessionId as string, 2, "turn/start", { turn: 1 });
    connection.sessionEvent(sessionId as string, 3, "assistant/message", {
      turn: 1,
      step: 1,
      message: { content: [{ type: "text", text: "first answer" }] },
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 5 },
    });
    connection.sessionEvent(sessionId as string, 4, "turn/end", {
      turn: 1,
      reason: { kind: "completed" },
    });
    await firstCollecting;

    const secondTurn = hostTurnIdSchema.parse("host-turn-aggregate-2");
    await session.execute({
      type: "turn.start",
      turnId: secondTurn,
      input: [{ type: "text", text: "second" }],
    });
    const secondCollecting = collectTurn();
    connection.sessionEvent(sessionId as string, 5, "turn/start", { turn: 2 });
    connection.sessionEvent(sessionId as string, 6, "assistant/chunk", {
      turn: 2,
      step: 1,
      chunk: { type: "usage", usage: { inputTokens: 20, outputTokens: 6 } },
    });
    connection.sessionEvent(sessionId as string, 7, "assistant/message", {
      turn: 2,
      step: 1,
      message: { content: [{ type: "text", text: "second answer" }] },
      usage: { inputTokens: 20, outputTokens: 6 },
    });
    connection.sessionEvent(sessionId as string, 8, "turn/end", {
      turn: 2,
      reason: { kind: "completed" },
    });
    const outputs = await secondCollecting;
    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "session.usage.changed",
            observedForTurnId: secondTurn,
            usage: expect.objectContaining({
              inputTokens: 30,
              outputTokens: 10,
              cachedInputTokens: 5,
              contextUsedTokens: 20,
              contextWindowTokens: 128_000,
            }),
          }),
        }),
      ]),
    );
    await session.close();
    await adapter.close();
  });

  it("forwards cancellation for the active Turn", async () => {
    const { adapter, connection } = fixture();
    const session = await openCreated(adapter);
    const turnId = hostTurnIdSchema.parse("host-turn-cancel");
    await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "long task" }],
    });

    await expect(session.execute({ type: "turn.cancel", turnId })).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(connection.calls.cancel).toHaveBeenCalledWith({ sessionId: "session-native-1" });
    await adapter.close();
  });

  it("resumes only the mapped Native Session and filters injected user messages from history", async () => {
    const { adapter, connection } = fixture();
    connection.history.set(SESSION_ID, [
      event(0, "turn/start", { turn: 1 }),
      event(1, "user/message", {
        role: "user",
        source: { kind: "user", rpcId: "human" },
        content: [{ type: "text", text: "human prompt" }],
      }),
      event(2, "user/message", {
        role: "user",
        source: { kind: "skill-catalog" },
        content: [{ type: "text", text: "injected catalog" }],
      }),
      event(3, "request/context", {
        provider: CURRENT_MODEL.provider,
        model: CURRENT_MODEL.model,
        contextWindow: 131_072,
      }),
      event(4, "request/header", {
        header: { config: CURRENT_MODEL },
      }),
      event(5, "assistant/message", {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: "reasoning", text: "thought" },
            { type: "text", text: "answer" },
          ],
        },
        usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 5 },
      }),
      event(6, "assistant/message", {
        turn: 1,
        step: 2,
        message: { content: [] },
        usage: { inputTokens: 20, outputTokens: 6 },
      }),
      event(7, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ]);

    const opened = await adapter.open({
      kind: "resume",
      cwd: "/workspace",
      nativeRef: {
        harnessId: adapter.harnessId,
        nativeSessionId: SESSION_ID,
        formatVersion: 1,
      },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.value.initialUsage).toMatchObject({
      inputTokens: 30,
      outputTokens: 10,
      cachedInputTokens: 5,
      contextUsedTokens: 20,
      contextWindowTokens: 131_072,
    });
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            input: [{ type: "text", text: "human prompt" }],
            items: [
              { item: { type: "reasoning", text: "thought" } },
              { item: { type: "agentMessage", text: "answer" } },
            ],
            outcome: { status: "succeeded" },
          },
        ],
      },
    });
    expect(connection.calls.create).not.toHaveBeenCalled();
    expect(connection.calls.list).not.toHaveBeenCalled();
    await adapter.close();
  });

  it("projects full-profile questions and sends the official response envelope", async () => {
    const { adapter, connection } = fixture();
    const session = await openCreated(adapter);
    const turnId = hostTurnIdSchema.parse("host-turn-question");
    await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "ask" }],
    });
    const iterator = session.outputs[Symbol.asyncIterator]();
    connection.sessionEvent("session-native-1", 1, "turn/start", { turn: 1 });
    await iterator.next();
    connection.mux(
      "session-native-1",
      {
        type: "question/requested",
        sessionId: SESSION_ID,
        questions: [
          {
            id: "choice",
            question: "Choose",
            options: [{ label: "A" }, { label: "B" }],
          },
        ],
      },
      "question-rpc",
    );
    const requested = await iterator.next();
    expect(requested.value).toMatchObject({
      kind: "interaction",
      interaction: { type: "question", turnId },
    });
    const interaction = requested.value.interaction;
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: { type: "question", answers: { choice: ["A"] } },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    expect(connection.calls.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "client-response",
        rpcId: "question-rpc",
        result: {
          ok: true,
          value: {
            sessionId: "session-native-1",
            answer: { answers: [{ id: "choice", selected: ["A"] }] },
          },
        },
      }),
    );
    await adapter.close();
  });

  it("keeps one Question close when DSH resolves during respond and continues the Turn", async () => {
    const { adapter, connection } = fixture();
    const session = await openCreated(adapter);
    const turnId = hostTurnIdSchema.parse("host-turn-question-continue");
    await session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "ask" }],
    });
    const iterator = session.outputs[Symbol.asyncIterator]();
    connection.sessionEvent("session-native-1", 1, "turn/start", { turn: 1 });
    await iterator.next();
    connection.mux(
      "session-native-1",
      {
        type: "question/requested",
        sessionId: SESSION_ID,
        questions: [
          {
            id: "choice",
            question: "Choose",
            header: "Ask user question",
            options: [{ label: "能看到弹窗，一切正常" }, { label: "看不到" }],
          },
        ],
      },
      "question-rpc",
    );
    const requested = await iterator.next();
    const interaction = requested.value.interaction;

    let releaseRespond: ((value: { accepted: true }) => void) | undefined;
    connection.calls.respond.mockImplementationOnce(
      () =>
        new Promise<{ accepted: true }>((resolve) => {
          releaseRespond = resolve;
        }),
    );

    const responding = session.execute({
      type: "interaction.respond",
      interactionId: interaction.interactionId,
      response: { type: "question", answers: { choice: ["能看到弹窗，一切正常"] } },
    });

    connection.mux(
      "session-native-1",
      {
        type: "question/resolved",
        sessionId: SESSION_ID,
        questionRpcId: RpcId("question-rpc"),
        outcome: "answered",
      },
      "question-resolved",
    );
    connection.sessionEvent("session-native-1", 2, "assistant/chunk", {
      turn: 1,
      step: 2,
      chunk: { type: "reasoning-delta", text: "thinking after answer" },
    });
    releaseRespond?.({ accepted: true });
    await expect(responding).resolves.toEqual({ ok: true, value: { accepted: true } });
    connection.sessionEvent("session-native-1", 3, "assistant/chunk", {
      turn: 1,
      step: 2,
      chunk: { type: "reasoning-delta", text: " more thinking" },
    });
    connection.sessionEvent("session-native-1", 4, "assistant/message", {
      turn: 1,
      step: 2,
      message: { content: [{ type: "text", text: "final answer" }] },
    });
    connection.sessionEvent("session-native-1", 5, "turn/end", {
      turn: 1,
      reason: { kind: "completed" },
    });

    const outputs: HarnessOutput[] = [];
    for (;;) {
      const result = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("timed out waiting for turn.completed")), 200);
        }),
      ]);
      if (result.done) throw new Error("Output stream ended before Turn completion");
      outputs.push(result.value);
      if (result.value.kind === "event" && result.value.event.type === "turn.completed") break;
    }

    expect(
      outputs.filter(
        (output) => output.kind === "event" && output.event.type === "interaction.closed",
      ),
    ).toHaveLength(1);
    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "item.updated",
            update: { type: "text.append", text: "thinking after answer" },
          }),
        }),
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "item.completed",
            snapshot: expect.objectContaining({
              item: expect.objectContaining({ type: "agentMessage", text: "final answer" }),
            }),
          }),
        }),
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "turn.completed",
            outcome: expect.objectContaining({ status: "succeeded" }),
          }),
        }),
      ]),
    );
    await adapter.close();
  });

  it("projects native Tool failures from the nested DSH result block", () => {
    expect(
      projectToolResult(
        {
          source: { kind: "tool", callId: "read-1" },
          content: [
            {
              type: "tool-result",
              toolCallId: "read-1",
              content: [{ type: "text", text: "Error: file not found" }],
              isError: true,
            },
          ],
        },
        64_000,
      ),
    ).toEqual({
      callId: "read-1",
      failed: true,
      output: { content: [{ type: "text", text: "Error: file not found" }] },
    });
  });
});
