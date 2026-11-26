import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  HarnessOutput,
  HarnessSessionState,
  HostEvent,
  HostInteraction,
  HostItemSnapshot,
  HostThreadSnapshot,
} from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";

import { OmoHarnessSession, type OmoHarnessSessionOptions } from "../src/omo-session.js";
import { OmoRpcSession, type OmoRpcProcessAdapter } from "../src/omo-rpc-session.js";

/**
 * Synthetic `omo --mode rpc` session peer. The fixture is a real OS process
 * (spawned from fake-omo.mjs), so process shutdown, stream ordering, and
 * command/reply correlation are the production ones; only the engine is fake.
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
  const directory = mkdtempSync(path.join(os.tmpdir(), "omo-session-test-"));
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

  async nextInteraction(timeoutMs = 5_000): Promise<HostInteraction> {
    for (;;) {
      const output = await this.next(timeoutMs);
      if (output.kind === "interaction") return output.interaction;
    }
  }

  async expectDone(timeoutMs = 5_000): Promise<void> {
    if (this.#done) return;
    const result = await bounded(this.#iterator.next(), timeoutMs, "output stream end");
    expect(result.done).toBe(true);
    this.#done = true;
  }

  /** Every remaining output until the stream ends. */
  async drain(timeoutMs = 5_000): Promise<HarnessOutput[]> {
    const values: HarnessOutput[] = [];
    while (!this.#done) {
      const result = await bounded(this.#iterator.next(), timeoutMs, "output stream drain");
      if (result.done) {
        this.#done = true;
        break;
      }
      values.push(result.value);
    }
    return values;
  }
}

interface TerminalEvent {
  type: "turn.completed";
  turnId: string;
  nativeTurnRef?: { nativeTurnKey: string };
  ephemeral?: true;
  outcome: Record<string, unknown>;
}

/** Every output up to (and including) one Turn's terminal. */
async function collectTurn(
  queue: OutputQueue,
  turnId: string,
  timeoutMs = 5_000,
): Promise<{ events: HostEvent[]; items: HostItemSnapshot[]; terminal: TerminalEvent }> {
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

function eventsOfType<T extends HostEvent["type"]>(
  events: HostEvent[],
  type: T,
): Extract<HostEvent, { type: T }>[] {
  return events.filter((event): event is Extract<HostEvent, { type: T }> => event.type === type);
}

interface SessionProbe {
  prompts: Array<{ message: string; clientTurnId: string | null }>;
  aborts: Array<Record<string, unknown>>;
  uiResponses: Array<Record<string, unknown>>;
  entries: Array<{ id: string; role: string | null }>;
  dialogState: string;
  isStreaming: boolean;
}

interface SessionFixture {
  rpc: OmoRpcSession;
  session: OmoHarnessSession;
  queue: OutputQueue;
  child(): ChildProcessWithoutNullStreams;
  probe(): Promise<SessionProbe>;
  closeAll(): Promise<void>;
}

async function createSessionFixture(
  scenario: string,
  environment: Record<string, string | undefined> = {},
  options: {
    session?: Omit<OmoHarnessSessionOptions, "initialState">;
  } = {},
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
        FAKE_OMO_SCENARIO: scenario,
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
    child: () => child,
    async probe() {
      const response = await rpc.send("probe.received");
      return response.data as SessionProbe;
    },
    async closeAll() {
      await session.close().catch(() => undefined);
      await rpc.close().catch(() => undefined);
    },
  };
}

function turnStart(turnId: string, text = "hello") {
  return {
    type: "turn.start" as const,
    turnId: hostTurnIdSchema.parse(turnId),
    input: [{ type: "text" as const, text }],
  };
}

function turnCancel(turnId: string) {
  return { type: "turn.cancel" as const, turnId: hostTurnIdSchema.parse(turnId) };
}

async function expectProcessGone(pid: number): Promise<void> {
  let receipt: NodeJS.ErrnoException | undefined;
  await vi.waitFor(
    () => {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (error) {
        alive = false;
        receipt = error as NodeJS.ErrnoException;
      }
      expect(alive).toBe(false);
      expect(receipt?.code).toBe("ESRCH");
    },
    { timeout: 5_000, interval: 25 },
  );
}

function textOf(snapshot: HostItemSnapshot | undefined): string | undefined {
  return snapshot?.item.type === "agentMessage" ? snapshot.item.text : undefined;
}

describe("OmO Session capabilities and declaration", () => {
  it("declares the staging scope: no configuration, history, steer or autonomous features", async () => {
    const fixtureSession = await createSessionFixture("session");
    expect(fixtureSession.session.capabilities).toEqual({
      configuration: {
        selectModel: false,
        selectThinkingOption: false,
        selectPermissionMode: false,
        permissionModeScope: "live",
      },
      history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
      steer: false,
    });
    expect(fixtureSession.session.initialUsage).toBeNull();
    await expect(
      fixtureSession.session.execute({
        type: "turn.steer",
        turnId: hostTurnIdSchema.parse("turn-1"),
        input: [{ type: "text", text: "steer" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    await expect(
      fixtureSession.session.execute({
        type: "model.select",
        model: { id: "synthetic-provider/synthetic-model" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    await expect(
      fixtureSession.session.execute({
        type: "thinking.select",
        thinkingOptionId: "high",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    await expect(
      fixtureSession.session.execute({
        type: "permissionMode.select",
        permissionModeId: "ask",
      } as never),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    await fixtureSession.closeAll();
  });
});

describe("OmO Session turn lifecycle", () => {
  it("projects text, reasoning, tools, a file change and exactly one terminal on agent_settled", async () => {
    const fixtureSession = await createSessionFixture("session", {
      FAKE_OMO_TURN_SCRIPT: "full",
    });
    const started = await fixtureSession.session.execute(turnStart("turn-1", "hello"));
    expect(started).toEqual({ ok: true, value: { turnId: "turn-1" } });

    const { events, items, terminal } = await collectTurn(fixtureSession.queue, "turn-1");

    // One terminal, and it is the last lifecycle event of the Turn.
    expect(eventsOfType(events, "turn.completed")).toHaveLength(1);
    expect(events.at(-1)).toBe(terminal);
    expect(terminal.outcome).toEqual({
      status: "succeeded",
      checkpoint: {
        harnessId: "omo",
        nativeSessionId: "synthetic-session-id",
        checkpointId: "u-1",
        formatVersion: 1,
      },
    });
    expect(terminal.nativeTurnRef).toEqual({
      harnessId: "omo",
      nativeSessionId: "synthetic-session-id",
      nativeTurnKey: "turn:u-1",
      formatVersion: 1,
    });

    // Streamed text is the completed text: deltas "Hel" + "lo" vs message_end "Hello".
    const agentItems = items.filter((item) => item.item.type === "agentMessage");
    expect(agentItems.map((item) => textOf(item))).toEqual(["Hello", "Done"]);
    const firstAgentId = agentItems[0]?.item.itemId;
    expect(firstAgentId).toBeDefined();
    const appends = eventsOfType(events, "item.updated")
      .filter((event) => event.itemId === firstAgentId)
      .map((event) => (event.update.type === "text.append" ? event.update.text : ""));
    expect(appends.join("")).toBe("Hello");

    // Reasoning is projected only from native thinking content.
    const reasoning = items.find((item) => item.item.type === "reasoning");
    expect(reasoning?.item).toMatchObject({ type: "reasoning", text: "thinking" });

    // Shell call → commandExecution with accumulated output, exit code and duration.
    const command = items.find((item) => item.item.type === "commandExecution");
    expect(command?.item).toMatchObject({
      type: "commandExecution",
      command: "ls -la",
      cwd: "/tmp",
      output: "file-a\nfile-b",
      exitCode: 0,
    });
    expect(
      command?.item.type === "commandExecution" ? command.item.durationMs : undefined,
    ).toBeTypeOf("number");
    expect(command?.outcome).toEqual({ status: "succeeded" });
    const commandAppends = eventsOfType(events, "item.updated").filter(
      (event) => event.itemId === command?.item.itemId,
    );
    expect(commandAppends).toContainEqual(
      expect.objectContaining({ update: { type: "output.append", text: "file-a\n" } }),
    );

    // Edit tool → toolExecution plus a fileChange that supersedes it.
    const tool = items.find((item) => item.item.type === "toolExecution");
    expect(tool?.item).toMatchObject({
      type: "toolExecution",
      toolName: "edit",
      arguments: { path: "/tmp/a.txt" },
      output: { content: [{ type: "text", text: "edited" }] },
    });
    const change = items.find((item) => item.item.type === "fileChange");
    expect(change?.item).toMatchObject({
      type: "fileChange",
      sourceItemIds: [tool?.item.itemId],
      changes: [
        {
          path: "/tmp/a.txt",
          kind: "update",
          unifiedDiff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new",
        },
      ],
    });

    // The prompt carried the host Turn id as the durable client Turn id.
    expect((await fixtureSession.probe()).prompts).toEqual([
      { message: "hello", clientTurnId: "turn-1" },
    ]);

    // Live and history identities agree: the snapshot's last Turn is the same.
    const snapshot = await fixtureSession.session.readSnapshot();
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) throw new Error("expected a snapshot");
    const turns = (snapshot.value as HostThreadSnapshot).turns;
    expect(turns.at(-1)?.nativeTurnRef).toEqual(terminal.nativeTurnRef);
    expect(turns.at(-1)?.input).toEqual([{ type: "text", text: "hello" }]);

    await fixtureSession.closeAll();
  });

  it("never completes a Turn on agent_end alone", async () => {
    const fixtureSession = await createSessionFixture("session", {
      FAKE_OMO_TURN_SCRIPT: "agent-end-first",
    });
    await expect(fixtureSession.session.execute(turnStart("turn-1"))).resolves.toMatchObject({
      ok: true,
    });

    // The fixture emits agent_end (willRetry: true) before any answer. If that
    // completed the Turn, the terminal would precede the item and its text.
    const first = await fixtureSession.queue.nextEvent();
    expect(first).toEqual({ type: "turn.started", turnId: "turn-1" });
    const { events, items, terminal } = await collectTurn(fixtureSession.queue, "turn-1");
    const all = [first, ...events];
    const terminalIndex = all.findIndex((event) => event.type === "turn.completed");
    const firstItemIndex = all.findIndex((event) => event.type === "item.started");
    expect(terminalIndex).toBeGreaterThan(firstItemIndex);
    expect(eventsOfType(all, "turn.completed")).toHaveLength(1);
    expect(terminal.outcome).toEqual(expect.objectContaining({ status: "succeeded" }));
    expect(items.filter((item) => item.item.type === "agentMessage").map(textOf)).toEqual([
      "Retried",
    ]);
    await fixtureSession.closeAll();
  });

  it("treats an extension-handled prompt as one ephemeral Turn", async () => {
    const fixtureSession = await createSessionFixture("session", {
      FAKE_OMO_PROMPT_DISPOSITION: "handled",
    });
    await expect(
      fixtureSession.session.execute(turnStart("turn-1", "/ext")),
    ).resolves.toMatchObject({ ok: true });
    const { events, terminal } = await collectTurn(fixtureSession.queue, "turn-1");
    expect(events.map((event) => event.type)).toEqual(["turn.started", "turn.completed"]);
    expect(terminal.ephemeral).toBe(true);
    expect(terminal.nativeTurnRef).toBeUndefined();
    // Admission is over: the next Turn is accepted immediately.
    await expect(fixtureSession.session.execute(turnStart("turn-2"))).resolves.toMatchObject({
      ok: true,
    });
    await fixtureSession.closeAll();
  });

  it("resolves Turn identity through the bounded history fallback when no entry event arrives", async () => {
    const fixtureSession = await createSessionFixture("session", {
      FAKE_OMO_TURN_SCRIPT: "full",
      FAKE_OMO_NO_USER_ENTRY_EVENT: "1",
    });
    await expect(fixtureSession.session.execute(turnStart("turn-1"))).resolves.toMatchObject({
      ok: true,
    });
    const first = await collectTurn(fixtureSession.queue, "turn-1");
    expect(first.terminal.nativeTurnRef?.nativeTurnKey).toBe("turn:u-1");

    await expect(
      fixtureSession.session.execute(turnStart("turn-2", "again")),
    ).resolves.toMatchObject({ ok: true });
    const second = await collectTurn(fixtureSession.queue, "turn-2");
    expect(second.terminal.nativeTurnRef?.nativeTurnKey).toBe("turn:u-2");
    await fixtureSession.closeAll();
  });

  it("rejects an empty Turn without sending a prompt or emitting events", async () => {
    const fixtureSession = await createSessionFixture("session");
    await expect(
      fixtureSession.session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("turn-empty"),
        input: [{ type: "text", text: "   " }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect((await fixtureSession.probe()).prompts).toEqual([]);
    await fixtureSession.closeAll();
  });

  it("bounds tool output and marks truncation", async () => {
    const fixtureSession = await createSessionFixture(
      "session",
      { FAKE_OMO_TURN_SCRIPT: "full" },
      { session: { toolOutputLimit: 4 } },
    );
    await fixtureSession.session.execute(turnStart("turn-1"));
    const { items } = await collectTurn(fixtureSession.queue, "turn-1");
    const command = items.find((item) => item.item.type === "commandExecution");
    expect(command?.item).toMatchObject({
      output: "file",
      outputTruncated: true,
    });
    const tool = items.find((item) => item.item.type === "toolExecution");
    expect(tool?.item.type === "toolExecution" ? tool.item.output : undefined).toEqual({
      content: [{ type: "text", text: "edit" }],
      truncated: true,
    });
    await fixtureSession.closeAll();
  });
});

describe("OmO Session error mapping", () => {
  it.each([
    ["streaming", "sessionBusy", true],
    ["provider_credentials_missing", "authenticationRequired", false],
    ["provider_credentials_expired", "authenticationRequired", false],
    ["no_model_selected", "configurationRequired", false],
  ] as const)(
    "maps a %s prompt refusal to %s and emits no Turn events",
    async (errorCode, code, retryable) => {
      const fixtureSession = await createSessionFixture("session", {
        FAKE_OMO_PROMPT_ERROR: errorCode,
      });
      await expect(fixtureSession.session.execute(turnStart("turn-rejected"))).resolves.toEqual({
        ok: false,
        error: expect.objectContaining({ code, retryable }),
      });
      // Clearing the refusal proves the rejected Turn emitted nothing: the very
      // first output belongs to the next accepted Turn.
      await fixtureSession.rpc.send("set_controls", { promptError: null, turnScript: "full" });
      await expect(fixtureSession.session.execute(turnStart("turn-2"))).resolves.toMatchObject({
        ok: true,
      });
      const first = await fixtureSession.queue.next();
      expect(first).toMatchObject({
        kind: "event",
        event: { type: "turn.started", turnId: "turn-2" },
      });
      await fixtureSession.closeAll();
    },
  );

  it("refuses a second Turn while one is streaming with a retryable sessionBusy", async () => {
    const fixtureSession = await createSessionFixture("session", {
      FAKE_OMO_TURN_SCRIPT: "cancel",
    });
    await fixtureSession.session.execute(turnStart("turn-1"));
    const first = await fixtureSession.queue.nextEvent();
    expect(first).toEqual({ type: "turn.started", turnId: "turn-1" });

    await expect(fixtureSession.session.execute(turnStart("turn-2"))).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ code: "sessionBusy", retryable: true }),
    });
    await expect(fixtureSession.session.readSnapshot()).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ code: "sessionBusy", retryable: true }),
    });
    await fixtureSession.session.execute(turnCancel("turn-1"));
    await collectTurn(fixtureSession.queue, "turn-1");
    await fixtureSession.closeAll();
  });
});

describe("OmO Session cancellation", () => {
  it("accepts an idle:false abort without blocking and settles one cancelled Turn", async () => {
    const fixtureSession = await createSessionFixture("session", {
      FAKE_OMO_TURN_SCRIPT: "cancel",
      FAKE_OMO_ABORT_DELAY_MS: "120",
      FAKE_OMO_ABORT_IDLE: "false",
      FAKE_OMO_ABORT_SETTLE_DELAY_MS: "60",
    });
    await fixtureSession.session.execute(turnStart("turn-1"));

    // Read up to the streamed text so cancellation targets a streaming Turn.
    for (;;) {
      const event = await fixtureSession.queue.nextEvent();
      if (
        event.type === "item.updated" &&
        event.update.type === "text.append" &&
        event.update.text === "Working"
      ) {
        break;
      }
    }

    const cancelStartedAt = Date.now();
    await expect(fixtureSession.session.execute(turnCancel("turn-1"))).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    // The fixture answers the abort 120ms later with idle:false; execute must
    // not wait for the run to settle.
    expect(Date.now() - cancelStartedAt).toBeLessThan(2_000);

    const { events, terminal } = await collectTurn(fixtureSession.queue, "turn-1");
    expect(eventsOfType(events, "turn.completed")).toHaveLength(1);
    expect(terminal.outcome).toEqual(
      expect.objectContaining({ status: "cancelled", reason: "Cancelled by user" }),
    );
    const abort = (await fixtureSession.probe()).aborts[0];
    expect(abort).toMatchObject({ type: "abort", clearQueue: true });
    expect(abort).not.toHaveProperty("awaitIdle");

    // The next Turn is accepted immediately, and a late frame from the aborted
    // Turn cannot pollute it.
    await fixtureSession.rpc.send("set_controls", { turnScript: "full" });
    await expect(
      fixtureSession.session.execute(turnStart("turn-2", "again")),
    ).resolves.toMatchObject({ ok: true });
    await fixtureSession.rpc.send("emit", {
      frames: [
        {
          type: "message_update",
          clientTurnId: "turn-1",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "POLLUTION" },
        },
      ],
    });
    const second = await collectTurn(fixtureSession.queue, "turn-2");
    const appended = eventsOfType(second.events, "item.updated")
      .filter((event) => event.update.type === "text.append")
      .map((event) => (event.update.type === "text.append" ? event.update.text : ""))
      .join("");
    expect(appended).not.toContain("POLLUTION");
    expect(eventsOfType(second.events, "turn.completed")).toHaveLength(1);
    expect(second.terminal.outcome).toMatchObject({ status: "succeeded" });
    await fixtureSession.closeAll();
  });

  it("settles a cancelled Turn from confirmed idleness when the native settle is missing", async () => {
    const fixtureSession = await createSessionFixture(
      "session",
      { FAKE_OMO_TURN_SCRIPT: "interaction", FAKE_OMO_ABORT_SETTLES: "false" },
      { session: { cancelSettleTimeoutMs: 200 } },
    );
    await fixtureSession.session.execute(turnStart("turn-1"));
    const approval = await fixtureSession.queue.nextInteraction();
    expect(approval.type).toBe("approval");

    await expect(fixtureSession.session.execute(turnCancel("turn-1"))).resolves.toMatchObject({
      ok: true,
    });
    // The fixture answers the abort but never sends agent_settled; the bounded
    // probe proves idle and the Turn still terminates exactly once.
    const { events, terminal } = await collectTurn(fixtureSession.queue, "turn-1");
    expect(eventsOfType(events, "turn.completed")).toHaveLength(1);
    expect(terminal.outcome).toEqual(
      expect.objectContaining({
        status: "cancelled",
        reason: expect.stringContaining("native idle confirmation"),
      }),
    );
    const closed = eventsOfType(events, "interaction.closed");
    expect(closed).toEqual([
      {
        type: "interaction.closed",
        interactionId: approval.interactionId,
        turnId: "turn-1",
        reason: "cancelled",
      },
    ]);

    // A late native settle with no active Turn is ignored, and the next Turn
    // still terminates exactly once.
    await fixtureSession.rpc.send("emit", { frames: [{ type: "agent_settled" }] });
    await fixtureSession.rpc.send("set_controls", { turnScript: "full" });
    await expect(fixtureSession.session.execute(turnStart("turn-2"))).resolves.toMatchObject({
      ok: true,
    });
    const second = await collectTurn(fixtureSession.queue, "turn-2");
    expect(eventsOfType(second.events, "turn.completed")).toHaveLength(1);
    expect(second.terminal.outcome).toMatchObject({ status: "succeeded" });
    await fixtureSession.closeAll();
  });

  it("faults the Session when abort fails and the engine still streams", async () => {
    const fixtureSession = await createSessionFixture("session", {
      FAKE_OMO_TURN_SCRIPT: "cancel",
      FAKE_OMO_ABORT_ERROR: "invalid_argument",
    });
    await fixtureSession.session.execute(turnStart("turn-1"));
    for (;;) {
      const event = await fixtureSession.queue.nextEvent();
      if (event.type === "item.updated" && event.update.type === "text.append") break;
    }
    await expect(fixtureSession.session.execute(turnCancel("turn-1"))).resolves.toMatchObject({
      ok: false,
      error: { code: "nativeFailure" },
    });

    const events: HostEvent[] = [];
    for (;;) {
      const event = await fixtureSession.queue.nextEvent();
      events.push(event);
      if (event.type === "session.faulted") break;
    }
    const terminal = eventsOfType(events, "turn.completed");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.outcome).toMatchObject({ status: "failed" });
    expect(eventsOfType(events, "session.faulted")).toHaveLength(1);
    expect(eventsOfType(events, "session.faulted")[0]?.error).toMatchObject({
      code: "nativeFailure",
      retryable: true,
    });
    await fixtureSession.queue.expectDone(5_000);
    await expect(fixtureSession.session.execute(turnStart("turn-2"))).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    const pid = fixtureSession.child().pid;
    expect(pid).toBeDefined();
    await expectProcessGone(pid as number);
  });
});

describe("OmO Session interactions", () => {
  it("round-trips an approval and correlates deny-with-feedback to the same tool Item", async () => {
    const fixtureSession = await createSessionFixture("session", {
      FAKE_OMO_TURN_SCRIPT: "interaction",
    });
    await fixtureSession.session.execute(turnStart("turn-1"));

    // The edit tool starts before the prompt; read its item to correlate later.
    const started: HostEvent[] = [];
    let approval: HostInteraction | undefined;
    for (;;) {
      const output = await fixtureSession.queue.next();
      if (output.kind === "interaction") {
        approval = output.interaction;
        break;
      }
      started.push(output.event);
    }
    expect(approval?.type).toBe("approval");
    if (approval?.type !== "approval") throw new Error("expected an approval");
    expect(approval.actions).toEqual([
      { id: "allow-once", label: "Allow once", effect: "allowOnce" },
      { id: "allow-always", label: "Allow always", effect: "allowAlways" },
      { id: "deny-with-feedback", label: "Deny with feedback", effect: "deny" },
      { id: "deny", label: "Deny", effect: "deny" },
    ]);
    const toolItemId = started
      .filter((event) => event.type === "item.started")
      .map((event) => event.item)
      .find((item) => item.type === "toolExecution")?.itemId;
    expect(toolItemId).toBeDefined();

    // A wrong-typed response and an unknown id are typed errors, not closes.
    await expect(
      fixtureSession.session.execute({
        type: "interaction.respond",
        interactionId: approval.interactionId,
        response: { type: "question", answers: { answer: ["nope"] } },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await expect(
      fixtureSession.session.execute({
        type: "interaction.respond",
        interactionId: "missing-interaction" as never,
        response: { type: "approval", actionId: "allow-once" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });

    await expect(
      fixtureSession.session.execute({
        type: "interaction.respond",
        interactionId: approval.interactionId,
        response: { type: "approval", actionId: "deny-with-feedback" },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });

    const closed = await fixtureSession.queue.nextEvent();
    expect(closed).toEqual({
      type: "interaction.closed",
      interactionId: approval.interactionId,
      turnId: "turn-1",
      reason: "responded",
    });
    // A duplicate answer for the closed interaction is refused.
    await expect(
      fixtureSession.session.execute({
        type: "interaction.respond",
        interactionId: approval.interactionId,
        response: { type: "approval", actionId: "allow-once" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });

    const followUp = await fixtureSession.queue.nextInteraction();
    expect(followUp.type).toBe("question");
    if (followUp.type !== "question") throw new Error("expected a question");
    expect(followUp.itemId).toBe(toolItemId);
    expect(followUp.questions[0]).toMatchObject({
      id: "answer",
      type: "text",
      prompt: "Why deny?",
    });

    await expect(
      fixtureSession.session.execute({
        type: "interaction.respond",
        interactionId: followUp.interactionId,
        response: { type: "question", answers: { answer: ["because"] } },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });

    const { events, terminal } = await collectTurn(fixtureSession.queue, "turn-1");
    expect(events[0]).toEqual({
      type: "interaction.closed",
      interactionId: followUp.interactionId,
      turnId: "turn-1",
      reason: "responded",
    });
    expect(terminal.outcome).toMatchObject({ status: "succeeded" });
    const receipts = (await fixtureSession.probe()).uiResponses;
    expect(receipts.map((receipt) => [receipt.uiRequestId, receipt.value])).toEqual([
      ["ui-approve-1", "Deny with feedback"],
      ["ui-feedback-1", "because"],
    ]);
    await fixtureSession.closeAll();
  });

  it("expires an unanswered timed dialog exactly once and keeps the Turn usable", async () => {
    const fixtureSession = await createSessionFixture("session", {
      FAKE_OMO_TURN_SCRIPT: "interaction-timeout",
    });
    await fixtureSession.session.execute(turnStart("turn-1"));
    const confirm = await fixtureSession.queue.nextInteraction();
    expect(confirm.type).toBe("question");
    if (confirm.type !== "question") throw new Error("expected a question");
    expect(confirm.questions[0]).toMatchObject({
      type: "choice",
      prompt: "All messages will be lost.",
    });
    expect(confirm.expiresAt).toBeTypeOf("string");

    const { events, terminal } = await collectTurn(fixtureSession.queue, "turn-1");
    const closed = eventsOfType(events, "interaction.closed");
    expect(closed).toEqual([
      {
        type: "interaction.closed",
        interactionId: confirm.interactionId,
        turnId: "turn-1",
        reason: "expired",
      },
    ]);
    expect(terminal.outcome).toMatchObject({ status: "succeeded" });
    // The Host never answered; the native side was not marked answered by us.
    expect((await fixtureSession.probe()).uiResponses).toEqual([]);
    // A response after expiry is a typed error, never a second close.
    await expect(
      fixtureSession.session.execute({
        type: "interaction.respond",
        interactionId: confirm.interactionId,
        response: { type: "question", answers: { answer: ["yes"] } },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    await fixtureSession.closeAll();
  });

  it("closes a pending interaction once on Session fault", async () => {
    const fixtureSession = await createSessionFixture("session", {
      FAKE_OMO_TURN_SCRIPT: "interaction",
    });
    await fixtureSession.session.execute(turnStart("turn-1"));
    const approval = await fixtureSession.queue.nextInteraction();

    await fixtureSession.rpc
      .send("emit", {
        frames: [{ type: "transcript_write_failed", role: "assistant", errorMessage: "disk full" }],
      })
      .catch(() => undefined);
    const events: HostEvent[] = [];
    for (;;) {
      const event = await fixtureSession.queue.nextEvent();
      events.push(event);
      if (event.type === "session.faulted") break;
    }
    expect(eventsOfType(events, "interaction.closed")).toEqual([
      {
        type: "interaction.closed",
        interactionId: approval.interactionId,
        turnId: "turn-1",
        reason: "cancelled",
      },
    ]);
    expect(eventsOfType(events, "turn.completed")).toHaveLength(1);
    expect(eventsOfType(events, "turn.completed")[0]?.outcome).toMatchObject({ status: "failed" });
    expect(eventsOfType(events, "session.faulted")).toHaveLength(1);
    await fixtureSession.queue.expectDone(5_000);
  });

  it("cancels a capability-gated question dialog it never announced", async () => {
    const fixtureSession = await createSessionFixture("session", {
      FAKE_OMO_TURN_SCRIPT: "cancel",
    });
    await fixtureSession.session.execute(turnStart("turn-1"));
    await fixtureSession.queue.nextEvent();
    await fixtureSession.rpc.send("emit", {
      frames: [
        {
          type: "extension_ui_request",
          id: "ui-question-1",
          method: "question",
          questions: [{ id: "q", header: "Q", question: "Which?", options: [] }],
        },
      ],
    });
    await vi.waitFor(
      async () => {
        const probe = await fixtureSession.probe();
        expect(probe.uiResponses).toContainEqual(
          expect.objectContaining({ uiRequestId: "ui-question-1", cancelled: true }),
        );
      },
      { timeout: 2_000, interval: 20 },
    );
    await fixtureSession.session.execute(turnCancel("turn-1"));
    await collectTurn(fixtureSession.queue, "turn-1");
    await fixtureSession.closeAll();
  });

  it("cancels dialogs left in get_state.pendingDialogs and reports them nowhere", async () => {
    const fixtureSession = await createSessionFixture("session", {
      FAKE_OMO_PENDING_DIALOGS: "default",
    });
    await vi.waitFor(
      async () => {
        const probe = await fixtureSession.probe();
        expect(probe.uiResponses).toContainEqual(
          expect.objectContaining({ uiRequestId: "synthetic-dialog", cancelled: true }),
        );
      },
      { timeout: 2_000, interval: 20 },
    );
    await fixtureSession.closeAll();
  });
});

describe("OmO Session faults", () => {
  it("faults on transcript_write_failed with one failed terminal", async () => {
    const fixtureSession = await createSessionFixture("session", {
      FAKE_OMO_TURN_SCRIPT: "transcript-fault",
    });
    await fixtureSession.session.execute(turnStart("turn-1"));
    const events: HostEvent[] = [];
    for (;;) {
      const event = await fixtureSession.queue.nextEvent();
      events.push(event);
      if (event.type === "session.faulted") break;
    }
    const terminal = eventsOfType(events, "turn.completed");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.outcome).toMatchObject({
      status: "failed",
      error: { code: "nativeFailure", message: expect.stringContaining("disk full") },
    });
    expect(eventsOfType(events, "session.faulted")).toHaveLength(1);
    await fixtureSession.queue.expectDone(5_000);
    const pid = fixtureSession.child().pid;
    expect(pid).toBeDefined();
    await expectProcessGone(pid as number);
  });

  it("faults on session_recovered and never reports a silent success", async () => {
    const fixtureSession = await createSessionFixture("session", {
      FAKE_OMO_TURN_SCRIPT: "recovered",
    });
    await fixtureSession.session.execute(turnStart("turn-1"));
    const events: HostEvent[] = [];
    for (;;) {
      const event = await fixtureSession.queue.nextEvent();
      events.push(event);
      if (event.type === "session.faulted") break;
    }
    const terminal = eventsOfType(events, "turn.completed");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.outcome).toMatchObject({
      status: "failed",
      error: { code: "protocolError" },
    });
    expect(eventsOfType(events, "session.faulted")[0]?.error).toMatchObject({
      code: "protocolError",
    });
    await fixtureSession.queue.expectDone(5_000);
  });
});

describe("OmO Session terminal outcomes from native signals", () => {
  it("presents a restored interrupted tool result as cancelled, not success", async () => {
    const fixtureSession = await createSessionFixture("session", {
      FAKE_OMO_TURN_SCRIPT: "interrupted",
    });
    await fixtureSession.session.execute(turnStart("turn-1"));
    const { items, terminal } = await collectTurn(fixtureSession.queue, "turn-1");
    const command = items.find((item) => item.item.type === "commandExecution");
    expect(command?.outcome).toMatchObject({ status: "failed" });
    expect(terminal.outcome).toEqual(
      expect.objectContaining({
        status: "cancelled",
        reason: "OmO restored an interrupted tool call",
      }),
    );
  });

  it("keeps a Turn succeeded when the agent recovers from an ordinary tool failure", async () => {
    const fixtureSession = await createSessionFixture("session", {
      FAKE_OMO_TURN_SCRIPT: "tool-error-recovery",
    });
    await fixtureSession.session.execute(turnStart("turn-1"));
    const { items, events, terminal } = await collectTurn(fixtureSession.queue, "turn-1");
    const command = items.find((item) => item.item.type === "commandExecution");
    expect(command?.outcome).toMatchObject({
      status: "failed",
      error: { code: "nativeFailure" },
    });
    expect(terminal.outcome).toMatchObject({ status: "succeeded" });
    expect(eventsOfType(events, "session.faulted")).toEqual([]);
    expect(items.filter((item) => item.item.type === "agentMessage").map(textOf)).toEqual([
      "Recovered",
    ]);
  });
});

describe("OmO Session close", () => {
  it("closes idempotently, closes a pending interaction once, ends outputs and reaps the process", async () => {
    const fixtureSession = await createSessionFixture("session", {
      FAKE_OMO_TURN_SCRIPT: "interaction",
    });
    await fixtureSession.session.execute(turnStart("turn-1"));
    const approval = await fixtureSession.queue.nextInteraction();
    const pid = fixtureSession.child().pid;
    expect(pid).toBeDefined();

    const first = fixtureSession.session.close();
    const second = fixtureSession.session.close();
    expect(second).toBe(first);
    await first;
    await fixtureSession.session.close();

    const events: HostEvent[] = [];
    for (const output of await fixtureSession.queue.drain()) {
      if (output.kind === "event") events.push(output.event);
    }
    await fixtureSession.queue.expectDone(1_000);
    expect(eventsOfType(events, "interaction.closed")).toEqual([
      {
        type: "interaction.closed",
        interactionId: approval.interactionId,
        turnId: "turn-1",
        reason: "cancelled",
      },
    ]);
    expect(eventsOfType(events, "turn.completed")).toHaveLength(1);
    expect(eventsOfType(events, "turn.completed")[0]?.outcome).toMatchObject({ status: "failed" });
    await expectProcessGone(pid as number);
    await expect(fixtureSession.session.execute(turnStart("turn-2"))).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    await expect(fixtureSession.session.readSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
  });
});
