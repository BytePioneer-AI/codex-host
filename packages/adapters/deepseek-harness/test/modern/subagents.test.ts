import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HarnessOutputChannel,
  type HarnessOutput,
  type HarnessSession,
  type HostEvent,
  type HostItemSnapshot,
  type HostThreadSnapshot,
} from "@codexhost/harness-adapter";
import { harnessIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";

import {
  decodeModernSubagentId,
  encodeModernSubagentId,
  modernSubagentState,
  parseModernSubagentCatalog,
  projectModernSubagents,
  type ModernSubagentFacts,
  type ModernSubagentPath,
} from "../../src/modern/subagent-projection.js";
import { modernItemId, modernNativeTurnRef } from "../../src/modern/history.js";
import type { ModernJournalEvent, ModernJournalRemote } from "../../src/modern/journal.js";
import {
  ModernSubagents,
  withModernSubagents,
  type ModernSubagentObservation,
} from "../../src/modern/subagents.js";
import { DEEPSEEK_V012_PROFILE, DEEPSEEK_V015_PROFILE } from "../../src/profiles/profile.js";

const harnessId = harnessIdSchema.parse("deepseek-harness");
const cwd = "C:\\workspace";
const path: ModernSubagentPath = [{ childSessionId: "child", mode: "continuable" }];
const turnId = hostTurnIdSchema.parse("host-turn");
const resources: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.allSettled(resources.splice(0).map((resource) => resource.close()));
});

function event(
  type: string,
  data: ModernJournalEvent["data"],
  seq: number,
  time = 10,
): ModernJournalEvent {
  return { type, data, seq, time };
}

function snapshot(id = "parent", items: HostItemSnapshot[] = []): HostThreadSnapshot {
  return {
    turns: [
      {
        nativeTurnRef: modernNativeTurnRef(harnessId, id, 1),
        input: [],
        items,
        outcome: { status: "succeeded" },
      },
    ],
  };
}

function tool(
  name = "subagent",
  args = { description: "Review", prompt: "Inspect" } as Record<string, string | boolean>,
  output?: string,
): HostItemSnapshot {
  return {
    item: {
      type: "toolExecution",
      itemId: modernItemId("parent", name),
      toolName: name,
      arguments: args,
      ...(output ? { output: { content: [{ type: "text", text: output }] } } : {}),
    },
    outcome: { status: "succeeded" },
  };
}

function fakeSession(id = "child") {
  const channel = new HarnessOutputChannel<HarnessOutput>();
  const state = { snapshot: snapshot(id), failRead: false };
  const execute = vi.fn(async () => ({
    ok: false,
    error: { code: "unsupported", message: "read only", retryable: false },
  }));
  const close = vi.fn(async () => {
    channel.end();
  });
  const session = {
    harnessId,
    capabilities: {
      configuration: {
        selectModel: false,
        selectThinkingOption: false,
        selectPermissionMode: false,
        permissionModeScope: "live",
      },
      history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
    },
    initialState: {},
    initialUsage: null,
    outputs: channel.outputs,
    readSnapshot: vi.fn(async () =>
      state.failRead
        ? { ok: false, error: { code: "unavailable", message: "read failed", retryable: true } }
        : { ok: true, value: state.snapshot },
    ),
    execute,
    close,
  } as unknown as HarnessSession;
  return {
    session,
    channel,
    state,
    close,
    execute,
    emit: (event: HostEvent) => channel.emit({ kind: "event", event }),
  };
}

function fixture(profile = DEEPSEEK_V015_PROFILE) {
  const child = fakeSession();
  child.state.snapshot = snapshot("child", [
    {
      item: {
        type: "agentMessage",
        itemId: modernItemId("child", "answer"),
        text: "Live child answer",
      },
      outcome: { status: "succeeded" },
    },
  ]);
  const parentEvents = [event("turn/start", { turn: 1 }, 0, 1)];
  const ownEvents = [
    event(
      "subagent/descriptor",
      {
        version: 3,
        mode: "continuable",
        label: "Review",
        provider: "spawn",
        agentModel: "child-model",
        agentReasoningEffort: "high",
      },
      0,
      2,
    ),
    event("turn/start", { turn: 1 }, 1, 3),
    event(
      "user/message",
      { source: { kind: "user" }, content: [{ type: "text", text: "Inspect" }] },
      2,
      4,
    ),
  ];
  const observation: ModernSubagentObservation = {
    session: child.session,
    header: {
      version: profile.sessionFormatVersion,
      id: "child",
      createdAt: 2,
      cwd,
      parentSession: "parent",
      origin: "subagent",
    },
    events: ownEvents,
    inheritedEventCount: 0,
  };
  const rows = new Map<string, unknown[]>([
    [
      "parent",
      [
        {
          kind: "child",
          id: "child",
          mode: "continuable",
          label: "Review",
          activity: "running",
          hasChildren: false,
        },
      ],
    ],
  ]);
  const call = vi.fn(async (_endpoint: string, args: Record<string, unknown>) => ({
    ok: true,
    value: { parentAvailable: true, entries: rows.get(String(args.parentSessionId)) ?? [] },
  }));
  const openObservation = vi.fn(async (path: ModernSubagentPath) => {
    expect(path.length).toBeGreaterThan(0);
    return observation;
  });
  const emitted: HostEvent[] = [];
  const monitor = new ModernSubagents({
    rootSessionId: "parent",
    cwd,
    profile,
    remote: { call } as unknown as ModernJournalRemote,
    rootJournal: () => ({ events: parentEvents, inheritedEventCount: 0 }),
    openObservation,
    emit: (output) => emitted.push(output),
  });
  resources.push(monitor);
  return {
    child,
    observation,
    ownEvents,
    parentEvents,
    rows,
    call,
    openObservation,
    emitted,
    monitor,
  };
}

function facts(overrides: Partial<ModernSubagentFacts> = {}): ModernSubagentFacts {
  const entry: ModernSubagentFacts["entry"] = {
    id: "child",
    mode: "continuable",
    label: "Review",
    activity: "inactive",
    hasChildren: false,
  };
  const value = {
    entry,
    path,
    header: {
      version: 3 as const,
      id: "child",
      cwd,
      createdAt: 2,
      parentSession: "parent",
      origin: "subagent" as const,
    },
    events: [event("turn/end", { turn: 1, reason: { kind: "completed" } }, 0)],
    inheritedEventCount: 0,
    snapshot: snapshot("child"),
    ...overrides,
  };
  return { ...value, state: modernSubagentState("parent", value) };
}

describe("DeepSeek native subagent identities and facts", () => {
  it("keeps complete UUID ancestry inside the Host identity limit", () => {
    const deep = Array.from({ length: 16 }, (_, index) => ({
      childSessionId: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
      mode: "continuable" as const,
    }));
    const id = encodeModernSubagentId("11111111-1111-1111-1111-111111111111", deep);
    expect(id.length).toBeLessThanOrEqual(1024);
    expect(decodeModernSubagentId(id, "11111111-1111-1111-1111-111111111111")).toEqual(deep);
    expect(() =>
      encodeModernSubagentId("parent", [
        { childSessionId: "a".repeat(500), mode: "one-shot" },
        { childSessionId: "b".repeat(500), mode: "one-shot" },
      ]),
    ).toThrow(/limit/u);
  });

  it("encodes a stable complete ancestry and rejects unrelated or noncanonical handles", () => {
    const nested = [...path, { childSessionId: "grandchild", mode: "one-shot" as const }];
    const id = encodeModernSubagentId("parent", nested);
    expect(decodeModernSubagentId(id, "parent")).toEqual(nested);
    expect(() => decodeModernSubagentId(id, "stranger")).toThrow();
    for (const invalid of [
      "ordinary-child-id",
      id + "=",
      "dsh-subagent-v1:a",
      encodeModernSubagentId("parent", []),
      encodeModernSubagentId("parent", [...path, ...path]),
      encodeModernSubagentId("parent", [{ childSessionId: "parent", mode: "one-shot" }]),
    ]) {
      expect(() => decodeModernSubagentId(invalid, "parent")).toThrow();
    }
  });

  it("validates directory rows and keeps diagnostics separate from children", () => {
    expect(
      parseModernSubagentCatalog({
        parentAvailable: false,
        entries: [
          { kind: "diagnostic", id: "missing", reason: "corrupt" },
          { kind: "child", id: "one", mode: "one-shot", activity: "inactive", hasChildren: false },
        ],
      }),
    ).toEqual([{ id: "one", mode: "one-shot", activity: "inactive", hasChildren: false }]);
    for (const invalid of [
      {},
      {
        parentAvailable: false,
        entries: [
          { kind: "child", id: "x", mode: "continuable", activity: "inactive", hasChildren: false },
        ],
      },
      { parentAvailable: true, entries: [{ kind: "diagnostic", id: "x", reason: "whatever" }] },
    ])
      expect(() => parseModernSubagentCatalog(invalid)).toThrow();
    expect(() =>
      parseModernSubagentCatalog({
        parentAvailable: true,
        entries: Array.from({ length: 257 }, (_, id) => ({
          kind: "diagnostic",
          id: String(id),
          reason: "corrupt",
        })),
      }),
    ).toThrow(/limit/u);
  });

  it.each([
    ["completed", "completed"],
    ["error", "failed"],
    ["max-tokens", "failed"],
    ["blocked", "failed"],
    ["aborted", "interrupted"],
    ["interrupted", "interrupted"],
  ] as const)("maps native %s to %s", (kind, status) => {
    expect(facts({ events: [event("turn/end", { reason: { kind } }, 0)] }).state.status).toBe(
      status,
    );
  });

  it("never turns inactivity or inherited parent completion into child success", () => {
    expect(facts({ events: [] }).state.status).toBe("pending");
    expect(facts({ inheritedEventCount: 1 }).state.status).toBe("pending");
    expect(facts({ events: [event("turn/start", { turn: 1 }, 0)] }).state).toMatchObject({
      status: "interrupted",
      resultSummary: expect.stringContaining("执行结果未知"),
    });
    expect(
      facts({
        entry: { id: "child", mode: "continuable", activity: "running", hasChildren: false },
      }).state.status,
    ).toBe("running");
  });

  it("preserves failed consumed work across no-op turns and recognizes cancelled unrun input", () => {
    const failed = [
      event("turn/start", { turn: 1 }, 0),
      event("step/start", { turn: 1 }, 1),
      event("turn/end", { turn: 1, reason: { kind: "error" } }, 2),
    ];
    const cancelled = event(
      "agent/inbox/spliced",
      { removedCount: 1, outcome: "canceled", inserted: [] },
      3,
    );
    const noop = [
      event("turn/start", { turn: 2 }, 4),
      event("turn/end", { turn: 2, reason: { kind: "completed" } }, 5),
    ];
    expect(facts({ events: [...failed, cancelled, ...noop] }).state.status).toBe("failed");
    expect(facts({ events: [cancelled, ...noop] }).state.status).toBe("interrupted");
    const claimed = [
      event("turn/start", { turn: 1 }, 0),
      event("agent/inbox/spliced", { removedCount: 1, inserted: [] }, 1),
      event("turn/end", { turn: 1, reason: { kind: "blocked" } }, 2),
    ];
    expect(facts({ events: [...claimed, ...noop] }).state.status).toBe("failed");
  });
});

describe("DeepSeek native child projection", () => {
  const parentEvents = [
    event("turn/start", { turn: 1 }, 0, 1),
    event("turn/end", { turn: 1, reason: { kind: "completed" } }, 1, 10),
  ];
  const project = (items: HostItemSnapshot[], children = [facts()], inheritedEventCount = 0) =>
    projectModernSubagents({
      snapshot: snapshot("parent", items),
      parentId: "parent",
      events: parentEvents,
      inheritedEventCount,
      children,
    }).turns[0]?.items ?? [];

  it("uses a verified native receipt and preserves the actual scheduling parameter", () => {
    const projected = project([
      tool("subagent", { run_in_background: false }, "started subagent child"),
    ]);
    expect(projected).toHaveLength(1);
    expect(projected[0]?.item).toMatchObject({
      type: "subagentDelegation",
      operation: "spawn",
      subagents: [{ nativeSubagentId: encodeModernSubagentId("parent", path), background: false }],
    });
  });

  it("matches unique task facts but keeps identical parallel calls unassociated", () => {
    const child = facts({
      events: [
        event(
          "user/message",
          { source: { kind: "user" }, content: [{ type: "text", text: "Inspect" }] },
          0,
        ),
      ],
    });
    expect(project([tool()], [child])[0]?.item.type).toBe("subagentDelegation");
    const duplicate = tool();
    duplicate.item.itemId = modernItemId("parent", "duplicate");
    const projected = project([tool(), duplicate], [child]);
    expect(projected.map((item) => item.item.type)).toEqual([
      "toolExecution",
      "toolExecution",
      "subagentDelegation",
    ]);
  });

  it("does not treat a job ID or an unverified provider output as a child", () => {
    expect(
      project([tool("subagent", {}, "started background subagent job child")])[0]?.item.type,
    ).toBe("toolExecution");
    expect(project([tool("subagent", {}, "started subagent stranger")], [])[0]?.item.type).toBe(
      "toolExecution",
    );
  });

  it("only maps send_message when its target is an owned direct child", () => {
    expect(
      project([tool("send_message", { agent_id: "child", message: "Continue" })])[0]?.item,
    ).toMatchObject({ type: "subagentDelegation", operation: "send", prompt: "Continue" });
    expect(
      project([tool("send_message", { agent_id: "parent", message: "Report" })])[0]?.item.type,
    ).toBe("toolExecution");
  });

  it("does not attach inherited calls or catalog cards to a fork's new ownership", () => {
    expect(project([tool()], [facts()], 2).map((item) => item.item.type)).toEqual([
      "toolExecution",
    ]);
  });
});

describe.each([DEEPSEEK_V012_PROFILE, DEEPSEEK_V015_PROFILE])(
  "DSH $version child observation",
  (profile) => {
    it("discovers without catalog events, exposes model and real history, and never executes", async () => {
      const f = fixture(profile);
      await f.monitor.refresh();
      expect(f.call).toHaveBeenCalledWith(
        "subagents/list",
        { parentSessionId: "parent" },
        expect.any(AbortSignal),
      );
      expect(f.openObservation).toHaveBeenCalledWith(path);
      const projected = f.monitor.project(snapshot("parent", [tool()]));
      expect(projected.turns[0]?.items[0]?.item).toMatchObject({
        type: "subagentDelegation",
        subagents: [{ model: "child-model", reasoningEffort: "high", status: "running" }],
      });
      const result = await f.monitor.readSnapshot(encodeModernSubagentId("parent", path));
      expect(result).toMatchObject({
        ok: true,
        value: { turns: [{ items: [{ item: { text: "Live child answer" } }] }] },
      });
      expect(f.child.execute).not.toHaveBeenCalled();
      await f.monitor.close();
      expect(f.child.close).toHaveBeenCalledTimes(1);
    });

    it("publishes actual child completion and later resumes the same identity", async () => {
      const f = fixture(profile);
      await f.monitor.refresh();
      f.ownEvents.push(
        event(
          "turn/end",
          { turn: 1, reason: { kind: "error", error: { message: "model failed" } } },
          3,
        ),
      );
      f.child.emit({
        type: "turn.completed",
        turnId,
        outcome: {
          status: "failed",
          error: { code: "nativeFailure", message: "model failed", retryable: false },
        },
      });
      await vi.waitFor(() =>
        expect(f.emitted).toContainEqual(
          expect.objectContaining({ type: "subagent.state.changed", status: "failed" }),
        ),
      );
      f.ownEvents.push(event("turn/start", { turn: 2 }, 4));
      f.child.emit({ type: "turn.started", turnId });
      await vi.waitFor(() => expect(f.monitor.observedPaths()[0]?.status).toBe("running"));
      expect(f.monitor.observedPaths()[0]?.path).toEqual(path);
    });

    it("refuses unrelated, missing, wrong-mode, wrong-workspace and corrupt-header child reads", async () => {
      const f = fixture(profile);
      expect((await f.monitor.readSnapshot(encodeModernSubagentId("other", path))).ok).toBe(false);
      expect(f.openObservation).not.toHaveBeenCalled();
      expect(
        (
          await f.monitor.readSnapshot(
            encodeModernSubagentId("parent", [{ childSessionId: "child", mode: "one-shot" }]),
          )
        ).ok,
      ).toBe(false);
      f.observation.header = { ...f.observation.header, cwd: "C:\\other" };
      expect((await f.monitor.readSnapshot(encodeModernSubagentId("parent", path))).ok).toBe(false);
      expect(f.child.close).toHaveBeenCalled();
    });

    it("preserves known state on catalog/read/follow failure instead of inventing success", async () => {
      const f = fixture(profile);
      await f.monitor.refresh();
      f.child.state.failRead = true;
      await f.monitor.refresh();
      expect(f.monitor.observedPaths()[0]?.status).toBe("running");
      f.child.emit({
        type: "session.faulted",
        error: { code: "unavailable", message: "lost follow", retryable: true },
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(
        f.emitted
          .filter((e) => e.type === "subagent.state.changed")
          .every((e) => e.type === "subagent.state.changed" && e.status === "running"),
      ).toBe(true);
    });

    it("restores nested paths only after every direct parent is verified", async () => {
      const f = fixture(profile);
      f.rows.set("parent", [
        {
          kind: "child",
          id: "child",
          mode: "continuable",
          label: "Review",
          activity: "running",
          hasChildren: true,
        },
      ]);
      f.rows.set("child", [
        {
          kind: "child",
          id: "grandchild",
          mode: "one-shot",
          activity: "inactive",
          hasChildren: false,
        },
      ]);
      const grandchild = fakeSession("grandchild");
      const original = f.observation;
      f.openObservation.mockImplementation(async (p) =>
        p.length === 1
          ? original
          : {
              session: grandchild.session,
              header: { ...original.header, id: "grandchild", parentSession: "child" },
              events: [
                event("subagent/descriptor", { version: 3, mode: "one-shot", provider: "fork" }, 0),
              ],
              inheritedEventCount: 0,
            },
      );
      const nested = [...path, { childSessionId: "grandchild", mode: "one-shot" as const }];
      expect((await f.monitor.readSnapshot(encodeModernSubagentId("parent", nested))).ok).toBe(
        true,
      );
      expect(f.monitor.observedPaths()).toHaveLength(2);
      f.rows.set("parent", []);
      expect((await f.monitor.readSnapshot(encodeModernSubagentId("parent", nested))).ok).toBe(
        false,
      );
    });

    it("closes an observation which finishes opening after parent close", async () => {
      const f = fixture(profile);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.openObservation.mockImplementation(async () => {
        await gate;
        return f.observation;
      });
      const refresh = f.monitor.refresh();
      await vi.waitFor(() => expect(f.openObservation).toHaveBeenCalled());
      const close = f.monitor.close();
      release();
      await Promise.all([refresh, close]);
      expect(f.monitor.observedPaths()).toEqual([]);
      expect(f.child.close).toHaveBeenCalledTimes(1);
      expect(f.emitted).toEqual([]);
    });

    it("rejects ancestry cycles and never traverses a parent with an invalid durable header", async () => {
      const f = fixture(profile);
      f.rows.set("parent", [
        { kind: "child", id: "parent", mode: "one-shot", activity: "inactive", hasChildren: true },
      ]);
      await expect(f.monitor.refresh()).rejects.toThrow(/cycle/u);
      expect(f.openObservation).not.toHaveBeenCalled();
      f.rows.set("parent", [
        {
          kind: "child",
          id: "child",
          mode: "continuable",
          label: "Review",
          activity: "running",
          hasChildren: true,
        },
      ]);
      f.observation.header = { ...f.observation.header, parentSession: "other" };
      await f.monitor.refresh();
      expect(f.call.mock.calls.every(([, args]) => args.parentSessionId === "parent")).toBe(true);
    });

    it("keeps an independently published catalog card stable when task facts arrive later", async () => {
      const f = fixture(profile);
      const prompt = f.ownEvents.pop();
      if (!prompt) throw new Error("Missing fixture prompt");
      await f.monitor.refresh();
      const initial = f.monitor.project(snapshot("parent", [tool()]));
      expect(initial.turns[0]?.items.map((item) => item.item.type)).toEqual([
        "toolExecution",
        "subagentDelegation",
      ]);
      f.ownEvents.push(prompt);
      await f.monitor.refresh();
      expect(
        f.monitor
          .project(snapshot("parent", [tool()]))
          .turns[0]?.items.map((item) => item.item.itemId),
      ).toEqual(initial.turns[0]?.items.map((item) => item.item.itemId));
    });

    it("skips unchanged history on directory refresh but reads live stream revisions", async () => {
      const f = fixture(profile);
      await f.monitor.refresh();
      const reads = vi.mocked(f.child.session.readSnapshot).mock.calls.length;
      await f.monitor.refresh();
      await f.monitor.refresh();
      expect(f.child.session.readSnapshot).toHaveBeenCalledTimes(reads);
      f.child.state.snapshot = snapshot("child", [
        {
          item: {
            type: "agentMessage",
            itemId: modernItemId("child", "answer"),
            text: "More live text",
          },
          outcome: { status: "succeeded" },
        },
      ]);
      f.child.emit({
        type: "item.updated",
        turnId,
        itemId: modernItemId("child", "answer"),
        update: { type: "text.append", text: "More live text" },
      });
      await vi.waitFor(() => expect(f.child.session.readSnapshot).toHaveBeenCalledTimes(reads + 1));
      expect(f.emitted).toContainEqual(
        expect.objectContaining({
          type: "subagent.state.changed",
          resultSummary: "More live text",
        }),
      );
    });

    it("reopens a faulted follow without restarting native child work", async () => {
      const f = fixture(profile);
      await f.monitor.refresh();
      f.child.emit({
        type: "session.faulted",
        error: { code: "unavailable", message: "connection lost", retryable: true },
      });
      await new Promise((resolve) => setImmediate(resolve));
      const replacement = fakeSession("child");
      f.openObservation.mockResolvedValue({ ...f.observation, session: replacement.session });
      await f.monitor.refresh();
      expect(f.openObservation).toHaveBeenCalledTimes(2);
      expect(f.child.close).toHaveBeenCalledTimes(1);
      expect(replacement.execute).not.toHaveBeenCalled();
    });
  },
);

function eventMatching(event: Record<string, unknown>) {
  return expect.objectContaining({ event: expect.objectContaining(event) });
}

function observeParent(...args: Parameters<typeof withModernSubagents>) {
  const wrapped = withModernSubagents(...args);
  const outputs: HarnessOutput[] = [];
  const pump = (async () => {
    for await (const output of wrapped.outputs) outputs.push(output);
  })();
  const close = async () => {
    await wrapped.close();
    await pump;
  };
  resources.push({ close });
  return { wrapped, outputs, close };
}

describe("DeepSeek parent wrapper", () => {
  it("refreshes after an in-flight pre-creation directory cut before settling the launch tool", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.call.mockImplementationOnce(async () => {
      await gate;
      return { ok: true, value: { parentAvailable: true, entries: [] } };
    });
    const parent = fakeSession("parent");
    const item = tool("subagent", {}, "started subagent child");
    parent.state.snapshot = snapshot("parent", [item]);
    const { outputs, close } = observeParent(parent.session, f.monitor);

    parent.emit({ type: "turn.started", turnId });
    parent.emit({ type: "item.started", turnId, item: item.item });
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(1));
    parent.emit({ type: "item.completed", turnId, snapshot: item });
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await vi.waitFor(() =>
      expect(outputs).toContainEqual(
        eventMatching({
          type: "item.completed",
          snapshot: expect.objectContaining({
            item: expect.objectContaining({ type: "subagentDelegation" }),
          }),
        }),
      ),
    );
    expect(f.call).toHaveBeenCalledTimes(2);
    expect(
      outputs.filter((output) => output.kind === "event" && output.event.type === "item.started"),
    ).toHaveLength(1);
    await close();
  });

  it("preserves original Item and Turn termination if auxiliary card mapping throws", async () => {
    const f = fixture();
    const parent = fakeSession("parent");
    const item = tool();
    parent.state.snapshot = snapshot("parent", [item]);
    vi.spyOn(f.monitor, "project").mockImplementation(() => {
      throw new Error("projection failure");
    });
    const { outputs, close } = observeParent(parent.session, f.monitor);

    parent.emit({ type: "turn.started", turnId });
    parent.emit({ type: "item.started", turnId, item: item.item });
    parent.emit({ type: "item.completed", turnId, snapshot: item });
    parent.emit({ type: "turn.completed", turnId, outcome: { status: "succeeded" } });
    await vi.waitFor(() =>
      expect(outputs).toContainEqual(eventMatching({ type: "turn.completed" })),
    );
    expect(
      outputs
        .filter((output) => output.kind === "event" && output.event.type.startsWith("item."))
        .map((output) => (output.kind === "event" ? output.event.type : "")),
    ).toEqual(["item.started", "item.completed"]);
    await close();
  });
  it("uses the live snapshot for a foreground child before the parent has finished", async () => {
    const f = fixture();
    const parent = fakeSession("parent");
    parent.state.snapshot = { turns: [] };
    const item = tool();
    const { outputs, close } = observeParent(parent.session, f.monitor, async () => ({
      ok: true,
      value: snapshot("parent", [item]),
    }));

    parent.emit({ type: "turn.started", turnId });
    parent.emit({ type: "item.started", turnId, item: item.item });
    await vi.waitFor(() =>
      expect(outputs).toContainEqual(
        eventMatching({
          type: "item.started",
          item: expect.objectContaining({ type: "subagentDelegation" }),
        }),
      ),
    );
    expect(
      outputs.some((output) => output.kind === "event" && output.event.type === "turn.completed"),
    ).toBe(false);
    await close();
  });

  it("forwards terminal events produced by closing an active native parent", async () => {
    const f = fixture();
    f.rows.clear();
    const parent = fakeSession("parent");
    const item = tool();
    const { wrapped, outputs, close } = observeParent(parent.session, f.monitor);

    parent.emit({ type: "turn.started", turnId });
    parent.emit({ type: "item.started", turnId, item: item.item });
    parent.close.mockImplementation(async () => {
      parent.emit({
        type: "item.completed",
        turnId,
        snapshot: { ...item, outcome: { status: "cancelled" } },
      });
      parent.emit({ type: "turn.completed", turnId, outcome: { status: "cancelled" } });
      parent.channel.end();
    });
    await close();
    expect(
      outputs.map((output) => (output.kind === "event" ? output.event.type : "interaction")),
    ).toEqual(["turn.started", "item.started", "item.completed", "turn.completed"]);
    expect(outputs.at(-1)).toMatchObject({ event: { outcome: { status: "cancelled" } } });
    await wrapped.close();
    expect(parent.close).toHaveBeenCalledTimes(1);
  });
  it("starts and completes verified cards, forwards interactions, and observes after parent completion", async () => {
    const f = fixture();
    const parent = fakeSession("parent");
    const item = tool();
    parent.state.snapshot = snapshot("parent", [item]);
    const { wrapped, outputs, close } = observeParent(parent.session, f.monitor);

    parent.emit({ type: "turn.started", turnId });
    parent.emit({ type: "item.started", turnId, item: item.item });
    parent.emit({ type: "item.completed", turnId, snapshot: item });
    parent.emit({ type: "turn.completed", turnId, outcome: { status: "succeeded" } });
    await vi.waitFor(() =>
      expect(outputs).toContainEqual(eventMatching({ type: "turn.completed" })),
    );
    const starts = outputs.flatMap((output) =>
      output.kind === "event" && output.event.type === "item.started" ? [output.event.item] : [],
    );
    expect(starts).toHaveLength(1);
    expect(starts[0]?.type).toBe("subagentDelegation");
    const count = outputs.length;
    f.ownEvents.push(event("turn/end", { turn: 1, reason: { kind: "completed" } }, 3));
    f.child.emit({ type: "turn.completed", turnId, outcome: { status: "succeeded" } });
    await vi.waitFor(() =>
      expect(outputs.slice(count)).toContainEqual(
        eventMatching({ type: "subagent.state.changed", status: "completed" }),
      ),
    );
    expect(
      outputs
        .slice(count)
        .some((output) => output.kind === "event" && output.event.type.startsWith("item.")),
    ).toBe(false);
    expect((await wrapped.readSnapshot()).ok).toBe(true);
    await close();
  });

  it("keeps an unverified provider call as an ordinary tool and forwards execute", async () => {
    const f = fixture();
    f.rows.clear();
    const parent = fakeSession("parent");
    const item = tool();
    parent.state.snapshot = snapshot("parent", [item]);
    const { wrapped, outputs, close } = observeParent(parent.session, f.monitor);

    parent.emit({ type: "turn.started", turnId });
    parent.emit({ type: "item.started", turnId, item: item.item });
    parent.emit({
      type: "item.updated",
      turnId,
      itemId: item.item.itemId,
      update: { type: "output.append", text: "running" },
    });
    parent.emit({ type: "item.completed", turnId, snapshot: item });
    await vi.waitFor(() => expect(outputs).toHaveLength(4));
    expect(outputs[1]).toMatchObject({
      event: { type: "item.started", item: { type: "toolExecution" } },
    });
    await wrapped.execute({ type: "turn.cancel", turnId });
    expect(parent.execute).toHaveBeenCalled();
    await close();
  });
});
