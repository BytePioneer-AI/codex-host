import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  HarnessOutput,
  HarnessSessionState,
  HostEvent,
  HostUsage,
} from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";

import { OmoHarnessSession, type OmoHarnessSessionOptions } from "../src/omo-session.js";
import { OmoRpcSession, type OmoRpcProcessAdapter } from "../src/omo-rpc-session.js";

/**
 * Engine-autonomous Turns (B12), session usage (B13), and background work
 * (GAP-4), driven through the synthetic classic-RPC peer process. All numbers
 * asserted here come from the fixture; no real engine or model is involved.
 */
const fixture = path.join(import.meta.dirname, "fixtures", "fake-omo.mjs");
const roots: string[] = [];
const sessions: OmoHarnessSession[] = [];
const rpcs: OmoRpcSession[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  for (const rpc of rpcs.splice(0)) await rpc.close().catch(() => undefined);
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "omo-autonomous-usage-test-"));
  roots.push(directory);
  return directory;
}

/** Bounds a wait so a hung Session fails the test instead of the suite. */
function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

interface UsageProbe {
  interrupts: Array<Record<string, unknown>>;
}

interface SessionFixture {
  rpc: OmoRpcSession;
  session: OmoHarnessSession;
  queue: OutputQueue;
  probe(): Promise<UsageProbe>;
  closeAll(): Promise<void>;
}

async function createSessionFixture(
  environment: Record<string, string | undefined> = {},
  options: { session?: Omit<OmoHarnessSessionOptions, "initialState"> } = {},
): Promise<SessionFixture> {
  const cwd = temporaryDirectory();
  const processAdapter: OmoRpcProcessAdapter = {
    spawn(spawnOptions) {
      const child = spawn(process.execPath, [fixture], {
        cwd: spawnOptions.cwd,
        env: spawnOptions.environment,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      children.push(child);
      return child;
    },
  };
  const rpc = new OmoRpcSession(
    {
      cwd,
      environment: {
        FAKE_OMO_SCENARIO: "session",
        FAKE_OMO_PENDING_DIALOGS: "none",
        PI_TELEMETRY: "0",
        ...environment,
      },
      commandTimeoutMs: 2_000,
      startupTimeoutMs: 5_000,
      closeTimeoutMs: 500,
    },
    processAdapter,
  );
  rpcs.push(rpc);
  await rpc.start();
  const state = rpc.state;
  let initialState: HarnessSessionState = {};
  if (state.sessionId && state.sessionFile) {
    initialState = {
      nativeRef: {
        harnessId: "omo",
        nativeSessionId: state.sessionId,
        locator: { sessionPath: state.sessionFile, cwd },
        formatVersion: 1,
      },
    };
  }
  const session = new OmoHarnessSession(rpc, {
    cwd,
    initialState,
    commandTimeoutMs: 2_000,
    abortTimeoutMs: 1_000,
    cancelSettleTimeoutMs: 2_000,
    probeTimeoutMs: 300,
    settleGraceMs: 30,
    closeTurnTimeoutMs: 300,
    ...options.session,
  });
  sessions.push(session);
  const child = children.at(-1);
  if (!child) throw new Error("the fixture process did not spawn");
  return {
    rpc,
    session,
    queue: new OutputQueue(session.outputs),
    async probe() {
      const response = await rpc.send("probe.received");
      return response.data as UsageProbe;
    },
    async closeAll() {
      await session.close().catch(() => undefined);
      await rpc.close().catch(() => undefined);
    },
  };
}

/** Ordered reader of the Session's single output stream. */
class OutputQueue {
  readonly #iterator: AsyncIterator<HarnessOutput>;
  #done = false;

  constructor(outputs: AsyncIterable<HarnessOutput>) {
    this.#iterator = outputs[Symbol.asyncIterator]();
  }

  async next(timeoutMs = 5_000): Promise<HarnessOutput> {
    if (this.#done) throw new Error("the output stream already ended");
    const result = await bounded(this.#iterator.next(), timeoutMs, "Session output");
    if (result.done) {
      this.#done = true;
      throw new Error("the output stream ended before the expected output");
    }
    return result.value;
  }

  async nextEvent(timeoutMs = 5_000): Promise<HostEvent> {
    for (;;) {
      const output = await this.next(timeoutMs);
      if (output.kind === "event") return output.event;
    }
  }

  /** The next `session.usage.changed` event, skipping other output. */
  async nextUsage(timeoutMs = 5_000): Promise<HostEvent> {
    for (;;) {
      const event = await this.nextEvent(timeoutMs);
      if (event.type === "session.usage.changed") return event;
    }
  }

  /** Every remaining output until the stream ends. */
  async drain(timeoutMs = 5_000): Promise<HostEvent[]> {
    const events: HostEvent[] = [];
    while (!this.#done) {
      const result = await bounded(this.#iterator.next(), timeoutMs, "output stream drain");
      if (result.done) {
        this.#done = true;
        break;
      }
      if (result.value.kind === "event") events.push(result.value.event);
    }
    return events;
  }
}

function turnStart(turnId: string, text = "hello") {
  return {
    type: "turn.start" as const,
    turnId: hostTurnIdSchema.parse(turnId),
    input: [{ type: "text" as const, text }],
  };
}

/** One turn's lifecycle events, up to and including its terminal. */
async function collectTurnEvents(
  queue: OutputQueue,
  turnId: string,
  timeoutMs = 5_000,
): Promise<HostEvent[]> {
  const events: HostEvent[] = [];
  for (;;) {
    const event = await queue.nextEvent(timeoutMs);
    events.push(event);
    if (event.type === "turn.completed" && event.turnId === turnId) return events;
  }
}

const USAGE_STATS_A = {
  tokens: { input: 1000, output: 200, cacheRead: 500, cacheWrite: 100, total: 1800 },
  cost: 0.5,
  contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30 },
};

const USAGE_STATS_B = {
  tokens: { input: 1130, output: 270, cacheRead: 600, cacheWrite: 110, total: 2110 },
  cost: 0.875,
  contextUsage: { tokens: 61000, contextWindow: 200000, percent: 31 },
};

const USAGE_RECORD_1 = {
  input: 100,
  output: 50,
  cacheRead: 40,
  cacheWrite: 10,
  totalTokens: 200,
  cost: { input: 0.125, output: 0.125, cacheRead: 0, cacheWrite: 0, total: 0.25 },
};

const USAGE_RECORD_2 = {
  input: 30,
  output: 20,
  cacheRead: 60,
  cacheWrite: 0,
  totalTokens: 110,
  cost: { input: 0.125, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.125 },
};

/** Every `session.usage.changed` usage value of a collected event slice. */
function usageSnapshots(events: HostEvent[]): (HostUsage | null)[] {
  return events
    .filter(
      (event): event is Extract<HostEvent, { type: "session.usage.changed" }> =>
        event.type === "session.usage.changed",
    )
    .map((event) => event.usage);
}

describe("OmO autonomous engine Turns", () => {
  it("observes an engine Turn after a requested Turn as its own Turn with one terminal and a persisted identity", async () => {
    const fixtureSession = await createSessionFixture({
      FAKE_OMO_TURN_SCRIPT: "full",
    });

    const requested = await fixtureSession.session.execute(turnStart("turn-1", "hello"));
    expect(requested).toEqual({ ok: true, value: { turnId: "turn-1" } });
    const requestedEvents = await collectTurnEvents(fixtureSession.queue, "turn-1");
    const requestedItems = requestedEvents
      .filter((event) => event.type === "item.completed")
      .map((event) => (event.type === "item.completed" ? event.snapshot.item : null));
    expect(
      requestedItems.some((item) => item?.type === "agentMessage" && item.text.includes("Hello")),
    ).toBe(true);

    expect(fixtureSession.session.capabilities.autonomousTurns).toEqual({ observe: true });

    await fixtureSession.rpc.send("autonomous.run", {
      message: "engine work",
      text: "engine result",
      usage: { input: 3, output: 2, cacheRead: 5, cacheWrite: 1, totalTokens: 11 },
    });

    const events = await collectTurnEventsFromAutonomous(fixtureSession.queue);
    const started = events.find(
      (event): event is Extract<HostEvent, { type: "turn.autonomous.started" }> =>
        event.type === "turn.autonomous.started",
    );
    expect(started).toBeDefined();
    expect(started?.input).toEqual([]);
    const turnId = started?.turnId;
    expect(typeof turnId).toBe("string");
    expect(turnId).not.toBe("turn-1");

    const terminals = events.filter(
      (event): event is Extract<HostEvent, { type: "turn.completed" }> =>
        event.type === "turn.completed" && event.turnId === turnId,
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.ephemeral).toBeUndefined();
    expect(terminals[0]?.nativeTurnRef).toEqual({
      harnessId: "omo",
      nativeSessionId: "synthetic-session-id",
      nativeTurnKey: "turn:u-2",
      formatVersion: 1,
    });
    expect(terminals[0]?.outcome).toMatchObject({ status: "succeeded" });

    // The engine Turn's content is its own, never the requested Turn's.
    const agentMessages = events
      .filter((event) => event.type === "item.completed")
      .map((event) => (event.type === "item.completed" ? event.snapshot.item : null));
    expect(
      agentMessages.some((item) => item?.type === "agentMessage" && item.text === "engine result"),
    ).toBe(true);
    expect(
      agentMessages.some((item) => item?.type === "agentMessage" && item.text.includes("Hello")),
    ).toBe(false);
    await fixtureSession.closeAll();
  });

  it("completes an engine Turn with no persisted user entry as ephemeral", async () => {
    const fixtureSession = await createSessionFixture();
    await fixtureSession.rpc.send("autonomous.run", { entry: false, text: "no entry" });
    const events = await collectTurnEventsFromAutonomous(fixtureSession.queue);
    const started = events.find((event) => event.type === "turn.autonomous.started");
    const turnId = started?.type === "turn.autonomous.started" ? started.turnId : null;
    expect(turnId).toBeDefined();
    const terminals = events.filter(
      (event): event is Extract<HostEvent, { type: "turn.completed" }> =>
        event.type === "turn.completed" && event.turnId === turnId,
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.nativeTurnRef).toBeUndefined();
    expect(terminals[0]?.ephemeral).toBe(true);
    expect(terminals[0]?.outcome).toMatchObject({ status: "succeeded" });
    await fixtureSession.closeAll();
  });

  it("buffers an engine Turn behind an in-flight configuration selection and drains it after", async () => {
    const fixtureSession = await createSessionFixture();
    await fixtureSession.rpc.send("set_controls", { modelDelayMs: 200 });

    // The selection is in flight; the engine Turn starts behind it.
    const selection = fixtureSession.session.execute({
      type: "model.select",
      model: { id: "synthetic-provider/other-model" },
    });
    await fixtureSession.rpc.send("autonomous.run", { text: "queued engine result" });

    const selected = await selection;
    expect(selected).toEqual({ ok: true, value: { completed: true } });

    const events = await collectTurnEventsFromAutonomous(fixtureSession.queue);
    const stateChanged = events.findIndex(
      (event) => event.type === "session.state.changed" && event.state.effectiveModel !== undefined,
    );
    const autonomousStarted = events.findIndex((event) => event.type === "turn.autonomous.started");
    expect(stateChanged).toBeGreaterThanOrEqual(0);
    expect(autonomousStarted).toBeGreaterThan(stateChanged);

    const started = events[autonomousStarted];
    const turnId = started?.type === "turn.autonomous.started" ? started.turnId : null;
    const terminals = events.filter(
      (event): event is Extract<HostEvent, { type: "turn.completed" }> =>
        event.type === "turn.completed" && event.turnId === turnId,
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.outcome).toMatchObject({ status: "succeeded" });
    const agentMessages = events
      .filter((event) => event.type === "item.completed")
      .map((event) => (event.type === "item.completed" ? event.snapshot.item : null));
    expect(
      agentMessages.some(
        (item) => item?.type === "agentMessage" && item.text === "queued engine result",
      ),
    ).toBe(true);
    await fixtureSession.closeAll();
  });
});

/** Collects output from the first `turn.autonomous.started` through its terminal. */
async function collectTurnEventsFromAutonomous(queue: OutputQueue): Promise<HostEvent[]> {
  const events: HostEvent[] = [];
  let turnId: string | null = null;
  for (;;) {
    const event = await queue.nextEvent();
    events.push(event);
    if (turnId === null) {
      if (event.type === "turn.autonomous.started") turnId = event.turnId;
      continue;
    }
    if (event.type === "turn.completed" && event.turnId === turnId) return events;
  }
}

describe("OmO session usage", () => {
  it("accumulates assistant Usage records exactly and re-anchors from native stats at Turn end", async () => {
    const fixtureSession = await createSessionFixture({
      FAKE_OMO_SESSION_STATS: JSON.stringify(USAGE_STATS_A),
      FAKE_OMO_TURN_SCRIPT: "usage",
    });

    // The constructor-started anchor read lands while the engine is idle.
    const anchorEvent = await fixtureSession.queue.nextUsage();
    expect(anchorEvent).toEqual({
      type: "session.usage.changed",
      usage: {
        inputTokens: 1600,
        outputTokens: 200,
        cachedInputTokens: 500,
        cacheWriteInputTokens: 100,
        totalTokens: 1800,
        totalCostUsd: 0.5,
        costSource: "native",
        contextWindowTokens: 200000,
        contextUsedTokens: 60000,
        contextUsagePercent: 30,
        sessionCacheUsage: { inputTokens: 1600, cachedInputTokens: 500 },
      },
    });

    await fixtureSession.rpc.send("set_controls", {
      messageUsages: [USAGE_RECORD_1, USAGE_RECORD_2],
      sessionStats: USAGE_STATS_B,
    });
    const started = await fixtureSession.session.execute(turnStart("turn-1", "hello"));
    expect(started).toEqual({ ok: true, value: { turnId: "turn-1" } });
    const events = await collectTurnEvents(fixtureSession.queue, "turn-1");
    const snapshots = usageSnapshots(events);
    // Mid-Turn: anchor + observed records, attributed to the running Turn.
    expect(snapshots).toEqual([
      {
        inputTokens: 1750,
        outputTokens: 250,
        cachedInputTokens: 540,
        cacheWriteInputTokens: 110,
        totalTokens: 2000,
        totalCostUsd: 0.75,
        costSource: "native",
        sessionCacheUsage: { inputTokens: 1750, cachedInputTokens: 540 },
      },
      {
        inputTokens: 1840,
        outputTokens: 270,
        cachedInputTokens: 600,
        cacheWriteInputTokens: 110,
        totalTokens: 2110,
        totalCostUsd: 0.875,
        costSource: "native",
        sessionCacheUsage: { inputTokens: 1840, cachedInputTokens: 600 },
      },
    ]);
    for (const event of events) {
      if (event.type === "session.usage.changed" && event.usage !== null) {
        expect(event.observedForTurnId).toBe("turn-1");
      }
    }

    // The Turn-completion refresh re-anchors from the native totals.
    const refreshed = await fixtureSession.queue.nextUsage();
    expect(refreshed).toEqual({
      type: "session.usage.changed",
      usage: {
        inputTokens: 1840,
        outputTokens: 270,
        cachedInputTokens: 600,
        cacheWriteInputTokens: 110,
        totalTokens: 2110,
        totalCostUsd: 0.875,
        costSource: "native",
        contextWindowTokens: 200000,
        contextUsedTokens: 61000,
        contextUsagePercent: 31,
        sessionCacheUsage: { inputTokens: 1840, cachedInputTokens: 600 },
      },
      observedForTurnId: "turn-1",
    });
    expect(fixtureSession.session.initialUsage).toEqual(refreshed.usage);
    await fixtureSession.closeAll();
  });

  it("observes engine-Turn usage with the autonomous Turn as the observed Turn", async () => {
    const fixtureSession = await createSessionFixture({
      FAKE_OMO_SESSION_STATS: JSON.stringify(USAGE_STATS_A),
    });
    await fixtureSession.queue.nextUsage();

    await fixtureSession.rpc.send("autonomous.run", {
      text: "engine result",
      usage: { input: 3, output: 2, cacheRead: 5, cacheWrite: 1, totalTokens: 11 },
    });
    const events = await collectTurnEventsFromAutonomous(fixtureSession.queue);
    const started = events.find(
      (event): event is Extract<HostEvent, { type: "turn.autonomous.started" }> =>
        event.type === "turn.autonomous.started",
    );
    const usageEvents = events.filter(
      (event): event is Extract<HostEvent, { type: "session.usage.changed" }> =>
        event.type === "session.usage.changed",
    );
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toEqual({
      type: "session.usage.changed",
      // The record carries no cost, so the cumulative cost is unknown (omitted).
      usage: {
        inputTokens: 1609,
        outputTokens: 202,
        cachedInputTokens: 505,
        cacheWriteInputTokens: 101,
        totalTokens: 1811,
        sessionCacheUsage: { inputTokens: 1609, cachedInputTokens: 505 },
      },
      observedForTurnId: started?.turnId,
    });
    await fixtureSession.closeAll();
  });

  it.each([
    { label: "missing", second: null },
    { label: "garbage", second: { input: "lots", output: 5, cacheRead: 0, cacheWrite: 0 } },
  ])(
    "publishes null for a $second Usage record and never reuses the last known numbers",
    async ({ second }) => {
      const fixtureSession = await createSessionFixture({
        FAKE_OMO_SESSION_STATS: JSON.stringify(USAGE_STATS_A),
        FAKE_OMO_TURN_SCRIPT: "usage",
      });
      await fixtureSession.queue.nextUsage();

      // The refresh after the Turn fails too, so the null stays the last state.
      await fixtureSession.rpc.send("set_controls", {
        messageUsages: [USAGE_RECORD_1, second],
        sessionStatsError: "stats_unavailable",
      });
      const started = await fixtureSession.session.execute(turnStart("turn-1", "hello"));
      expect(started).toEqual({ ok: true, value: { turnId: "turn-1" } });
      const events = await collectTurnEvents(fixtureSession.queue, "turn-1");
      const snapshots = usageSnapshots(events);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0]).toEqual({
        inputTokens: 1750,
        outputTokens: 250,
        cachedInputTokens: 540,
        cacheWriteInputTokens: 110,
        totalTokens: 2000,
        totalCostUsd: 0.75,
        costSource: "native",
        sessionCacheUsage: { inputTokens: 1750, cachedInputTokens: 540 },
      });
      expect(snapshots[1]).toBeNull();
      await fixtureSession.closeAll();
    },
  );

  it("isolates refreshUsage failures: no fault, and the Session keeps serving Turns", async () => {
    const fixtureSession = await createSessionFixture({
      FAKE_OMO_SESSION_STATS: JSON.stringify(USAGE_STATS_A),
      FAKE_OMO_TURN_SCRIPT: "full",
    });
    await fixtureSession.queue.nextUsage();
    await fixtureSession.rpc.send("set_controls", { sessionStatsError: "stats_unavailable" });

    await expect(fixtureSession.session.refreshUsage()).resolves.toBeUndefined();

    const started = await fixtureSession.session.execute(turnStart("turn-1", "hello"));
    expect(started).toEqual({ ok: true, value: { turnId: "turn-1" } });
    // The refresh error neither faults the Session nor disturbs the Turn.
    await fixtureSession.session.refreshUsage();
    const events = await collectTurnEvents(fixtureSession.queue, "turn-1");
    expect(events.some((event) => event.type === "session.faulted")).toBe(false);
    const terminal = events.at(-1);
    expect(terminal).toMatchObject({ type: "turn.completed", outcome: { status: "succeeded" } });
    const followUp = await fixtureSession.session.execute(turnStart("turn-2", "again"));
    expect(followUp).toEqual({ ok: true, value: { turnId: "turn-2" } });
    await collectTurnEvents(fixtureSession.queue, "turn-2");
    await fixtureSession.closeAll();
  });

  it("keeps usage state per Session instance (no cross-Session leakage)", async () => {
    const first = await createSessionFixture({
      FAKE_OMO_SESSION_STATS: JSON.stringify(USAGE_STATS_A),
    });
    const second = await createSessionFixture({
      FAKE_OMO_SESSION_STATS: JSON.stringify(USAGE_STATS_B),
    });
    const firstUsage = await first.queue.nextUsage();
    const secondUsage = await second.queue.nextUsage();
    expect(firstUsage.usage).toMatchObject({ inputTokens: 1600, outputTokens: 200 });
    expect(secondUsage.usage).toMatchObject({ inputTokens: 1840, outputTokens: 270 });
    expect(firstUsage.usage).not.toEqual(secondUsage.usage);
    await first.closeAll();
    await second.closeAll();
  });
});

describe("OmO background work", () => {
  it("reflects session_lifecycle waitingOn: children and background count, human does not", async () => {
    const fixtureSession = await createSessionFixture();
    expect(fixtureSession.session.hasBackgroundWork()).toBe(false);

    const emit = async (frames: Array<Record<string, unknown>>): Promise<void> => {
      await fixtureSession.rpc.send("emit", { frames });
    };
    const waitForWork = async (expected: boolean): Promise<void> => {
      await vi.waitFor(
        () => {
          expect(fixtureSession.session.hasBackgroundWork()).toBe(expected);
        },
        { timeout: 2_000, interval: 10 },
      );
    };

    await emit([
      {
        type: "session_lifecycle",
        sessionId: "synthetic-session-id",
        lifecycle: {
          state: "waiting_background",
          seq: 1,
          waitingOn: {
            background: [{ source: "shell", activeCount: 1, items: [{ id: "mon_1" }] }],
            human: [],
          },
        },
      },
    ]);
    await waitForWork(true);

    await emit([
      {
        type: "session_lifecycle",
        sessionId: "synthetic-session-id",
        lifecycle: {
          state: "waiting_human",
          seq: 2,
          waitingOn: {
            human: [{ kind: "question", originSessionId: "s", requestId: "q1", revision: 1 }],
          },
        },
      },
    ]);
    await waitForWork(false);

    await emit([
      {
        type: "session_lifecycle",
        sessionId: "synthetic-session-id",
        lifecycle: { state: "running", seq: 3, waitingOn: { children: 3 } },
      },
    ]);
    await waitForWork(true);

    // Unknown fields and malformed snapshots are ignored (additive rule), and
    // an older seq never replaces a newer observation.
    await emit([
      {
        type: "session_lifecycle",
        sessionId: "synthetic-session-id",
        lifecycle: { waitingOn: "busy" },
      },
      {
        type: "session_lifecycle",
        sessionId: "synthetic-session-id",
        lifecycle: { state: "done", seq: 1, waitingOn: {} },
      },
    ]);
    await waitForWork(true);
    await fixtureSession.closeAll();
  });

  it("adopts the open-time get_state lifecycle as the initial background-work observation", async () => {
    const working = await createSessionFixture({
      FAKE_OMO_LIFECYCLE: JSON.stringify({
        state: "waiting_children",
        seq: 1,
        waitingOn: { children: 2 },
      }),
    });
    expect(working.session.hasBackgroundWork()).toBe(true);

    const humanWaiting = await createSessionFixture({
      FAKE_OMO_LIFECYCLE: JSON.stringify({
        state: "waiting_human",
        seq: 1,
        waitingOn: {
          human: [{ kind: "approval", originSessionId: "s", requestId: "q1", revision: 1 }],
        },
      }),
    });
    expect(humanWaiting.session.hasBackgroundWork()).toBe(false);
    await working.closeAll();
    await humanWaiting.closeAll();
  });

  it('sends interrupt {background:"stop"} exactly, repeatedly, and never faults', async () => {
    const fixtureSession = await createSessionFixture();
    const idle = await fixtureSession.session.stopBackgroundWork();
    expect(idle).toEqual({ ok: true, value: undefined });
    const again = await fixtureSession.session.stopBackgroundWork();
    expect(again).toEqual({ ok: true, value: undefined });

    const probe = await fixtureSession.probe();
    expect(probe.interrupts).toHaveLength(2);
    for (const interrupt of probe.interrupts) {
      // The exact frame contents: `interrupt` with `background:"stop"` and no
      // turn id.
      expect(interrupt.type).toBe("interrupt");
      expect(interrupt.background).toBe("stop");
      expect("turnId" in interrupt).toBe(false);
    }

    const started = await fixtureSession.session.execute(turnStart("turn-1", "hello"));
    expect(started).toEqual({ ok: true, value: { turnId: "turn-1" } });
    const events = await collectTurnEvents(fixtureSession.queue, "turn-1");
    expect(events.some((event) => event.type === "session.faulted")).toBe(false);
    await fixtureSession.closeAll();
  });

  it("keeps the Turn lifecycle intact when background work is stopped mid-Turn", async () => {
    const fixtureSession = await createSessionFixture({
      FAKE_OMO_TURN_SCRIPT: "cancel",
    });
    const started = await fixtureSession.session.execute(turnStart("turn-1", "hello"));
    expect(started).toEqual({ ok: true, value: { turnId: "turn-1" } });

    const stopped = await fixtureSession.session.stopBackgroundWork();
    expect(stopped).toEqual({ ok: true, value: undefined });
    const probe = await fixtureSession.probe();
    expect(probe.interrupts).toHaveLength(1);
    expect(probe.interrupts[0]?.type).toBe("interrupt");
    expect(probe.interrupts[0]?.background).toBe("stop");
    expect(probe.interrupts[0] && "turnId" in probe.interrupts[0]).toBe(false);

    // The interrupted Turn settles with exactly one cancelled terminal.
    const events = await collectTurnEvents(fixtureSession.queue, "turn-1");
    const terminals = events.filter(
      (event): event is Extract<HostEvent, { type: "turn.completed" }> =>
        event.type === "turn.completed" && event.turnId === "turn-1",
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.outcome).toMatchObject({ status: "cancelled" });
    expect(events.some((event) => event.type === "session.faulted")).toBe(false);

    // The Session keeps serving Turns after the interruption.
    await fixtureSession.rpc.send("set_controls", { turnScript: "full" });
    const followUp = await fixtureSession.session.execute(turnStart("turn-2", "again"));
    expect(followUp).toEqual({ ok: true, value: { turnId: "turn-2" } });
    const followUpEvents = await collectTurnEvents(fixtureSession.queue, "turn-2");
    expect(followUpEvents.at(-1)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await fixtureSession.closeAll();
  });
});
