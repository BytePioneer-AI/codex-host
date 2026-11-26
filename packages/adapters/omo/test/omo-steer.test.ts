import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  HarnessOutput,
  HarnessSessionState,
  HostEvent,
  HostItemSnapshot,
  HostThreadSnapshot,
} from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";

import {
  OmoRpcCommandTimeoutError,
  OmoRpcResponseError,
  OmoRpcSession,
  type OmoRpcProcessAdapter,
} from "../src/omo-rpc-session.js";
import { OmoHarnessSession, type OmoHarnessSessionOptions } from "../src/omo-session.js";
import {
  admitOmoSteer,
  OmoSteerDeliveryUncertainError,
  OmoSteerRejectedError,
  OmoSteerSettlementError,
  OmoSteerTargetEndedError,
  OmoSteerWindow,
  reconcileOmoSteerSettlement,
} from "../src/omo-steer.js";

/**
 * Steer coverage, two layers:
 *
 * - The window tracker, the admission classifier, and the settlement count are
 *   pure functions, exercised without a process.
 * - The Session integration uses the synthetic `omo --mode rpc` peer (a real OS
 *   process), so ordering, settlement waiting, faulting, and process shutdown
 *   are the production ones and only the engine is fake.
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
  const directory = mkdtempSync(path.join(os.tmpdir(), "omo-steer-test-"));
  roots.push(directory);
  return directory;
}

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

  async expectDone(timeoutMs = 5_000): Promise<void> {
    if (this.#done) return;
    const result = await bounded(this.#iterator.next(), timeoutMs, "output stream end");
    expect(result.done).toBe(true);
    this.#done = true;
  }
}

interface TerminalEvent {
  type: "turn.completed";
  turnId: string;
  nativeTurnRef?: { nativeTurnKey: string };
  outcome: Record<string, unknown>;
}

interface TurnCapture {
  events: HostEvent[];
  items: HostItemSnapshot[];
  terminal: TerminalEvent;
}

async function collectTerminal(
  queue: OutputQueue,
  turnId: string,
  timeoutMs = 5_000,
): Promise<TurnCapture> {
  const events: HostEvent[] = [];
  const items: HostItemSnapshot[] = [];
  for (;;) {
    const event = await queue.nextEvent(timeoutMs);
    events.push(event);
    if (event.type === "item.completed") items.push(event.snapshot);
    if (event.type === "turn.completed" && event.turnId === turnId) {
      return { events, items, terminal: event as unknown as TerminalEvent };
    }
  }
}

interface SteerProbe {
  prompts: Array<{ message: string; clientTurnId: string | null }>;
  steers: Array<Record<string, unknown>>;
  clearQueues: Array<Record<string, unknown>>;
  entries: Array<{ id: string; role: string | null }>;
}

interface SteerFixture {
  rpc: OmoRpcSession;
  session: OmoHarnessSession;
  queue: OutputQueue;
  child(): ChildProcessWithoutNullStreams;
  probe(): Promise<SteerProbe>;
  /** Commands the peer recorded for post-exit inspection (control.log). */
  controlCommands(): Array<Record<string, unknown>>;
  closeAll(): Promise<void>;
}

async function createSteerFixture(
  environment: Record<string, string | undefined> = {},
  options: { session?: Omit<OmoHarnessSessionOptions, "initialState"> } = {},
): Promise<SteerFixture> {
  const cwd = temporaryDirectory();
  const controlLog = path.join(cwd, ".fake-omo", "control.log");
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
        FAKE_OMO_CONTROL_LOG: controlLog,
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
    child: () => child,
    async probe() {
      const response = await rpc.send("probe.received");
      return response.data as SteerProbe;
    },
    controlCommands() {
      if (!existsSync(controlLog)) return [];
      return readFileSync(controlLog, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    async closeAll() {
      await session.close().catch(() => undefined);
      await rpc.close().catch(() => undefined);
    },
  };
}

function turnStart(turnId: string, text = "run the command") {
  return {
    type: "turn.start" as const,
    turnId: hostTurnIdSchema.parse(turnId),
    input: [{ type: "text" as const, text }],
  };
}

function turnSteer(turnId: string, text: string) {
  return {
    type: "turn.steer" as const,
    turnId: hostTurnIdSchema.parse(turnId),
    input: [{ type: "text" as const, text }],
  };
}

/** Reads events until one matches; the matched event is returned separately. */
async function nextUntil(
  queue: OutputQueue,
  predicate: (event: HostEvent) => boolean,
  timeoutMs = 5_000,
): Promise<{ event: HostEvent; events: HostEvent[] }> {
  const events: HostEvent[] = [];
  for (;;) {
    const event = await queue.nextEvent(timeoutMs);
    events.push(event);
    if (predicate(event)) return { event, events };
  }
}

function isCommandItemStart(event: HostEvent): boolean {
  return event.type === "item.started" && event.item.type === "commandExecution";
}

function isCommandItemCompletion(event: HostEvent): boolean {
  return (
    event.type === "item.completed" &&
    event.snapshot.item.type === "commandExecution" &&
    event.snapshot.item.itemId.startsWith("omo-item-live-v1-")
  );
}

/** Runs a steer-window Turn up to the parked tool call and returns its identity. */
async function startSteeredTurn(fixtureSession: SteerFixture, turnId = "turn-1"): Promise<void> {
  const started = await fixtureSession.session.execute(turnStart(turnId));
  expect(started).toMatchObject({ ok: true });
  await nextUntil(fixtureSession.queue, isCommandItemStart);
}

async function waitForProcessExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  await vi.waitFor(
    () => {
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    },
    { timeout: 5_000, interval: 25 },
  );
}

describe("OmoSteerWindow", () => {
  it("opens only while a root tool call runs and closes finally", () => {
    const window = new OmoSteerWindow();
    expect(window.isOpen).toBe(false);

    window.toolStarted("call-1");
    expect(window.isOpen).toBe(true);
    expect(window.openToolCount).toBe(1);

    window.toolStarted("call-1");
    expect(window.openToolCount).toBe(1);

    window.toolStarted("call-2");
    window.toolEnded("call-1");
    expect(window.isOpen).toBe(true);
    window.toolEnded("call-2");
    expect(window.isOpen).toBe(false);

    window.toolStarted("call-3");
    window.close();
    expect(window.isOpen).toBe(false);
    window.toolStarted("call-4");
    expect(window.isOpen).toBe(false);
  });
});

describe("admitOmoSteer", () => {
  function openWindow(): OmoSteerWindow {
    const window = new OmoSteerWindow();
    window.toolStarted("call-1");
    return window;
  }

  it("sends the documented steer payload and accepts a queued admission", async () => {
    const payloads: Array<Readonly<Record<string, unknown>>> = [];
    await expect(
      admitOmoSteer({
        window: openWindow(),
        text: "also print DONE",
        expectedTurnId: "native-turn-1",
        clientTurnId: "turn-1",
        send: async (payload) => {
          payloads.push(payload);
          return { data: { disposition: "queued" } };
        },
        targetActive: () => true,
      }),
    ).resolves.toBeUndefined();
    expect(payloads).toEqual([
      { message: "also print DONE", expectedTurnId: "native-turn-1", clientTurnId: "turn-1" },
    ]);
  });

  it("accepts an older host's answer without a disposition and omits an absent client Turn id", async () => {
    const payloads: Array<Readonly<Record<string, unknown>>> = [];
    await expect(
      admitOmoSteer({
        window: openWindow(),
        text: "steer",
        expectedTurnId: "native-turn-1",
        send: async (payload) => {
          payloads.push(payload);
          return {};
        },
        targetActive: () => true,
      }),
    ).resolves.toBeUndefined();
    expect(payloads[0]).toEqual({ message: "steer", expectedTurnId: "native-turn-1" });
  });

  it("refuses without writing when the tool window closed", async () => {
    const window = openWindow();
    window.close();
    let sent = 0;
    await expect(
      admitOmoSteer({
        window,
        text: "steer",
        expectedTurnId: "native-turn-1",
        send: async () => {
          sent += 1;
          return { data: { disposition: "queued" } };
        },
        targetActive: () => true,
      }),
    ).rejects.toBeInstanceOf(OmoSteerRejectedError);
    expect(sent).toBe(0);
  });

  it("maps a native turn_conflict refusal to a typed rejection", async () => {
    const refusal = new OmoRpcResponseError("steer", {
      type: "response",
      id: "codexhost-1",
      success: false,
      error: "no running turn matches expectedTurnId",
      errorCode: "turn_conflict",
    });
    const error = await admitOmoSteer({
      window: openWindow(),
      text: "steer",
      expectedTurnId: "stale-turn",
      send: async () => {
        throw refusal;
      },
      targetActive: () => true,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OmoSteerRejectedError);
    expect((error as OmoSteerRejectedError).refusal?.errorCode).toBe("turn_conflict");
  });

  it("throws an uncertain delivery for a timeout after the write", async () => {
    const error = await admitOmoSteer({
      window: openWindow(),
      text: "steer",
      expectedTurnId: "native-turn-1",
      send: async () => {
        throw new OmoRpcCommandTimeoutError("steer", 2_000);
      },
      targetActive: () => true,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OmoSteerDeliveryUncertainError);
    expect((error as Error).message).toContain("delivery is unknown");
  });

  it("throws an uncertain delivery when an input handler consumed the steer", async () => {
    const error = await admitOmoSteer({
      window: openWindow(),
      text: "steer",
      expectedTurnId: "native-turn-1",
      send: async () => ({ data: { disposition: "handled" } }),
      targetActive: () => true,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OmoSteerDeliveryUncertainError);
    expect((error as Error).message).toContain("handled");
  });

  it("classifies an answer that arrives after settlement as target-ended, not a refusal", async () => {
    let active = true;
    const error = await admitOmoSteer({
      window: openWindow(),
      text: "steer",
      expectedTurnId: "native-turn-1",
      send: async () => {
        // The target settles while the answer is in flight; the receipt is
        // still a success, but it cannot join the ended Turn.
        active = false;
        return { data: { disposition: "queued" } };
      },
      targetActive: () => active,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OmoSteerTargetEndedError);
  });
});

describe("reconcileOmoSteerSettlement", () => {
  it("requires exactly the prompt plus each accepted steer", () => {
    expect(() => reconcileOmoSteerSettlement(["u-1"], 0)).not.toThrow();
    expect(() => reconcileOmoSteerSettlement(["u-1", "u-2"], 1)).not.toThrow();
    expect(() => reconcileOmoSteerSettlement(["u-1", "u-2", "u-3"], 2)).not.toThrow();

    expect(() => reconcileOmoSteerSettlement(["u-1"], 1)).toThrow(OmoSteerSettlementError);
    expect(() => reconcileOmoSteerSettlement(["u-1", "u-2"], 0)).toThrow(OmoSteerSettlementError);
    try {
      reconcileOmoSteerSettlement(["u-1"], 1);
    } catch (error) {
      expect(error).toMatchObject({ expectedUserEntries: 2, persistedUserEntries: 1 });
    }
  });
});

describe("OmO Session steering", () => {
  it("declares steer only inside an open tool window and queues one same-Turn input", async () => {
    const fixtureSession = await createSteerFixture({ FAKE_OMO_TURN_SCRIPT: "steer-window" });
    await startSteeredTurn(fixtureSession);
    expect(fixtureSession.session.capabilities.steer).toBe(true);

    await expect(
      fixtureSession.session.execute(turnSteer("turn-1", "also print DONE")),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });

    const { terminal } = await collectTerminal(fixtureSession.queue, "turn-1");
    expect(terminal.outcome).toMatchObject({ status: "succeeded" });
    expect(terminal.nativeTurnRef?.nativeTurnKey).toBe("turn:u-1");
    // The window closed with the tool call; the Host stops using same-Turn input.
    expect(fixtureSession.session.capabilities.steer).toBe(false);

    const probe = await fixtureSession.probe();
    expect(probe.steers).toHaveLength(1);
    expect(probe.steers[0]).toMatchObject({
      message: "also print DONE",
      expectedTurnId: "native-turn-1",
      clientTurnId: "turn-1",
    });
    expect(probe.entries.map((entry) => `${entry.id}:${entry.role}`)).toEqual([
      "u-1:user",
      "u-2:user",
    ]);

    const snapshot = await fixtureSession.session.readSnapshot();
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    const turns: HostThreadSnapshot["turns"] = snapshot.value.turns;
    expect(turns).toHaveLength(2);
    expect(turns[0]?.nativeTurnRef.nativeTurnKey).toBe("turn:u-1");
    expect(turns[1]?.input).toEqual([{ type: "text", text: "also print DONE" }]);
    await fixtureSession.closeAll();
  });

  it("refuses a turn_conflict steer as a typed invalidState and never retries it", async () => {
    const fixtureSession = await createSteerFixture({
      FAKE_OMO_TURN_SCRIPT: "steer-window",
      FAKE_OMO_STEER_MODE: "conflict",
    });
    await startSteeredTurn(fixtureSession);
    await expect(
      fixtureSession.session.execute(turnSteer("turn-1", "too late")),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState", retryable: false } });

    const { terminal } = await collectTerminal(fixtureSession.queue, "turn-1");
    expect(terminal.outcome).toMatchObject({ status: "succeeded" });
    const probe = await fixtureSession.probe();
    expect(probe.steers).toHaveLength(1);
    expect(probe.entries.map((entry) => entry.id)).toEqual(["u-1"]);
    await fixtureSession.closeAll();
  });

  it("throws target-ended for a post-settlement receipt, keeps history, and closes the process", async () => {
    const fixtureSession = await createSteerFixture({
      FAKE_OMO_TURN_SCRIPT: "steer-window",
      FAKE_OMO_STEER_MODE: "late-settle",
    });
    const child = fixtureSession.child();
    await startSteeredTurn(fixtureSession);
    await expect(
      fixtureSession.session.execute(turnSteer("turn-1", "never joined")),
    ).rejects.toBeInstanceOf(OmoSteerTargetEndedError);

    // The Turn's own terminal is published first, then the native queue is
    // cleared and the Session faults; the Host resumes from the persisted
    // history instead of resending the input.
    const { terminal } = await collectTerminal(fixtureSession.queue, "turn-1");
    expect(terminal.outcome).toMatchObject({ status: "succeeded" });
    const fault = await fixtureSession.queue.nextEvent();
    expect(fault).toMatchObject({ type: "session.faulted", error: { code: "invalidState" } });
    await fixtureSession.queue.expectDone();
    await waitForProcessExit(child);

    // The queued text was removed natively exactly once (never resent).
    expect(fixtureSession.controlCommands()).toEqual([{ type: "clear_queue" }]);
    await expect(fixtureSession.session.readSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    await fixtureSession.closeAll();
  });

  it("stops declaring steer when the tool window closes and writes nothing", async () => {
    const fixtureSession = await createSteerFixture({ FAKE_OMO_TURN_SCRIPT: "steer-window" });
    await startSteeredTurn(fixtureSession);
    await fixtureSession.rpc.send("steer.tool-end");
    await nextUntil(fixtureSession.queue, isCommandItemCompletion);
    expect(fixtureSession.session.capabilities.steer).toBe(false);

    await expect(
      fixtureSession.session.execute(turnSteer("turn-1", "outside the window")),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });

    await fixtureSession.rpc.send("steer.finish");
    const { terminal } = await collectTerminal(fixtureSession.queue, "turn-1");
    expect(terminal.outcome).toMatchObject({ status: "succeeded" });
    const probe = await fixtureSession.probe();
    expect(probe.steers).toEqual([]);
    expect(probe.entries.map((entry) => entry.id)).toEqual(["u-1"]);
    await fixtureSession.closeAll();
  });

  it("fails the Turn and faults when an accepted steer never becomes a user entry", async () => {
    const fixtureSession = await createSteerFixture({
      FAKE_OMO_TURN_SCRIPT: "steer-window",
      FAKE_OMO_STEER_MODE: "queue-silent",
    });
    await startSteeredTurn(fixtureSession);
    await expect(
      fixtureSession.session.execute(turnSteer("turn-1", "accepted but lost")),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });

    const { terminal } = await collectTerminal(fixtureSession.queue, "turn-1");
    expect(terminal.outcome).toMatchObject({
      status: "failed",
      error: { code: "protocolError" },
    });
    const fault = await fixtureSession.queue.nextEvent();
    expect(fault).toMatchObject({ type: "session.faulted", error: { code: "protocolError" } });
    await fixtureSession.queue.expectDone();
    expect(fixtureSession.controlCommands()).toEqual([{ type: "clear_queue" }]);
    await fixtureSession.closeAll();
  });

  it("rejects an empty steer without writing to the engine", async () => {
    const fixtureSession = await createSteerFixture({ FAKE_OMO_TURN_SCRIPT: "steer-window" });
    await startSteeredTurn(fixtureSession);
    await expect(fixtureSession.session.execute(turnSteer("turn-1", "   "))).resolves.toMatchObject(
      { ok: false, error: { code: "invalidRequest" } },
    );
    const probe = await fixtureSession.probe();
    expect(probe.steers).toEqual([]);
    await fixtureSession.closeAll();
  });
});
