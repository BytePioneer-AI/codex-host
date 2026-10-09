import assert from "node:assert/strict";
import { defined } from "./support/defined.ts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { HarnessRegistry } from "../src/harnesses.ts";
import type { WireEvent } from "../src/session-log.ts";
import { Sessions, type SessionNotification } from "../src/sessions.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcRegistry, StreamRegistry, type StreamSink } from "../src/transport.ts";
import { Workspaces } from "../src/workspaces.ts";

interface Bench {
  rpc: RpcRegistry;
  streams: StreamRegistry;
  sessions: Sessions;
  events: EventHub;
  data: DataDir;
  frames: unknown[];
  notifications: SessionNotification[];
  cwd: string;
  call<T = unknown>(method: string, args: Record<string, unknown>): Promise<T>;
}

let root = "";
let bench: Bench;

function sink(frames: unknown[]): StreamSink {
  return {
    id: "test",
    closed: false,
    push: (frame) => frames.push(frame),
    end() {},
    fail() {},
    onClose() {},
  };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function journal(sessionId: string): WireEvent[] {
  return bench.data.readLines<WireEvent>(`sessions/${sessionId}/events.jsonl`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codexhost-sessions-"));
  const cwd = join(root, "ws");
  mkdirSync(cwd);
  const data = new DataDir(join(root, "data"));
  const harnesses = new HarnessRegistry([resolve(import.meta.dirname, "fake-harness")]);
  const workspaces = new Workspaces(data, cwd);
  const events = new EventHub("/home/test");
  const sessions = new Sessions(data, harnesses, workspaces, events);
  const rpc = new RpcRegistry();
  const streams = new StreamRegistry();
  workspaces.register(rpc, streams);
  sessions.register(rpc, streams);
  sessions.registerCommands(rpc);
  sessions.registerImport(rpc);
  rpc.register("$events/result", (args) => events.settle(args as never));
  const frames: unknown[] = [];
  events.handler({}, sink(frames));
  const notifications: SessionNotification[] = [];
  sessions.notifier = (notification) => notifications.push(notification);
  globalThis.fakeHarnessScripts = {};
  globalThis.fakeHarnessLog = [];
  bench = {
    rpc,
    streams,
    sessions,
    events,
    data,
    frames,
    notifications,
    cwd,
    async call<T>(method: string, args: Record<string, unknown>): Promise<T> {
      const result = await rpc.dispatch(method, { args });
      if (!result.ok) throw new Error(`${method}: ${result.error.code} ${result.error.message}`);
      return result.value as T;
    },
  };
});

afterEach(async () => {
  await bench.sessions.close();
  rmSync(root, { recursive: true, force: true });
});

async function newSession(): Promise<string> {
  const { sessionId } = await bench.call<{ sessionId: string }>("session/create", {
    request: { cwd: bench.cwd },
  });
  return sessionId;
}

async function prompt(
  sessionId: string,
  text: string,
  mode: "queue" | "steer" = "queue",
): Promise<void> {
  await bench.call("session/prompt", {
    request: { requestId: `r-${text}`, sessionId, mode, content: [{ type: "text", text }] },
  });
}

function turnEnds(sessionId: string): WireEvent[] {
  return journal(sessionId).filter((event) => event.type === "turn/end");
}

describe("Sessions with a scripted Harness", () => {
  it("runs a turn end to end and notifies with the reply", async () => {
    const sessionId = await newSession();
    await prompt(sessionId, "hello");
    await waitFor(() => turnEnds(sessionId).length === 1, "turn end");
    const events = journal(sessionId);
    assert.deepEqual(
      events.map((event) => event.type).filter((type) => !type.startsWith("session/")),
      ["turn/start", "step/start", "user/message", "assistant/message", "step/end", "turn/end"],
    );
    const reply = defined(events.find((event) => event.type === "assistant/message")).data as {
      message: { content: Array<{ text: string }> };
    };
    assert.equal(defined(reply.message.content[0]).text, "echo: hello");
    assert.equal(bench.notifications.at(-1)?.kind, "turn");
    assert.equal(bench.notifications.at(-1)?.body, "echo: hello");
    const list = await bench.call<{ items: Array<{ sessionId: string; blank: boolean }> }>(
      "session/list",
      {},
    );
    assert.equal(list.items.find((item) => item.sessionId === sessionId)?.blank, false);
  });

  it("routes an approval through the event hub and resumes the turn", async () => {
    defined(globalThis.fakeHarnessScripts).approve = [
      {
        interaction: {
          type: "approval",
          interactionId: "ap-1",
          title: "Run rm -rf build",
          subject: { type: "nativeAction" },
          actions: [
            { id: "yes", label: "Allow", effect: "allowOnce" },
            { id: "no", label: "Deny", effect: "deny" },
          ],
        },
      },
      { awaitResponse: "ap-1" },
      { event: { type: "turn.completed", outcome: { status: "succeeded" } } },
    ];
    const sessionId = await newSession();
    await prompt(sessionId, "approve");
    await waitFor(
      () => bench.frames.some((frame) => (frame as { type?: string }).type === "waterfall"),
      "approval waterfall",
    );
    const waterfall = bench.frames.find(
      (frame) => (frame as { type?: string }).type === "waterfall",
    ) as { eventId: string; event: string; agentId: string; request: { toolName: string } };
    assert.equal(waterfall.event, "approval/request");
    assert.equal(waterfall.agentId, sessionId);
    assert.equal(waterfall.request.toolName, "Run rm -rf build");
    assert.equal(bench.notifications.at(-1)?.kind, "approval");
    await bench.call("$events/result", {
      clientId: "c",
      eventId: waterfall.eventId,
      outcome: { kind: "result", value: "allowed-once" },
    });
    await waitFor(() => turnEnds(sessionId).length === 1, "turn end after approval");
    assert.deepEqual(
      defined(globalThis.fakeHarnessLog).find((entry) => entry.responded === "ap-1")?.response,
      { type: "approval", actionId: "yes" },
    );
  });

  it("maps question answers back to option values", async () => {
    defined(globalThis.fakeHarnessScripts).ask = [
      {
        interaction: {
          type: "question",
          interactionId: "q-1",
          questions: [
            {
              id: "color",
              type: "choice",
              prompt: "Color?",
              options: [
                { value: "r", label: "Red" },
                { value: "b", label: "Blue" },
              ],
              multiple: false,
              allowOther: true,
              optional: false,
            },
          ],
        },
      },
      { awaitResponse: "q-1" },
      { event: { type: "turn.completed", outcome: { status: "succeeded" } } },
    ];
    const sessionId = await newSession();
    await prompt(sessionId, "ask");
    await waitFor(
      () =>
        bench.frames.some(
          (frame) => (frame as { event?: string }).event === "user-questions/request",
        ),
      "question waterfall",
    );
    const waterfall = bench.frames.find(
      (frame) => (frame as { event?: string }).event === "user-questions/request",
    ) as { eventId: string };
    await bench.call("$events/result", {
      clientId: "c",
      eventId: waterfall.eventId,
      outcome: {
        kind: "result",
        value: { answers: [{ id: "color", selected: ["Blue"], custom: "teal" }] },
      },
    });
    await waitFor(() => turnEnds(sessionId).length === 1, "turn end after answer");
    assert.deepEqual(
      defined(globalThis.fakeHarnessLog).find((entry) => entry.responded === "q-1")?.response,
      { type: "question", answers: { color: ["b", "teal"] } },
    );
  });

  it("queues prompts sent while a turn runs and starts them in order", async () => {
    defined(globalThis.fakeHarnessScripts).slow = [{ awaitCancel: true }];
    const sessionId = await newSession();
    await prompt(sessionId, "slow");
    await waitFor(
      () => journal(sessionId).some((event) => event.type === "user/message"),
      "first turn",
    );
    await prompt(sessionId, "second");
    const runtimeInbox = () =>
      (
        bench.data.readJson<Record<string, unknown>>(`sessions/${sessionId}/projections.json`, {})
          .inbox as { "next-turn": unknown[] }
      )["next-turn"];
    assert.equal(runtimeInbox().length, 1);
    await bench.call("session/cancel", { request: { sessionId } });
    await waitFor(() => turnEnds(sessionId).length === 1, "cancelled turn");
    // Cancel clears the queue: the queued prompt does not start.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(turnEnds(sessionId).length, 1);
    assert.deepEqual((defined(turnEnds(sessionId)[0]).data as { reason: unknown }).reason, {
      kind: "aborted",
      reason: { kind: "user" },
    });
  });

  it("steers by cancelling and starting the new input next", async () => {
    defined(globalThis.fakeHarnessScripts).slow = [{ awaitCancel: true }];
    const sessionId = await newSession();
    await prompt(sessionId, "slow");
    await waitFor(
      () => journal(sessionId).some((event) => event.type === "user/message"),
      "first turn",
    );
    await prompt(sessionId, "redirect", "steer");
    await waitFor(() => turnEnds(sessionId).length === 2, "steered turn");
    const users = journal(sessionId)
      .filter((event) => event.type === "user/message")
      .map(
        (event) => defined((event.data as { content: Array<{ text: string }> }).content[0]).text,
      );
    assert.deepEqual(users, ["slow", "redirect"]);
    assert.deepEqual(
      defined(globalThis.fakeHarnessLog)
        .filter((entry) => entry.command !== undefined)
        .map((entry) => entry.command),
      ["turn.start", "turn.cancel", "turn.start"],
    );
  });

  it("switches permission mode through the slash command and keeps one Harness per session", async () => {
    const sessionId = await newSession();
    const modes = await bench.call<{ options: Array<{ value: string }> }>(
      "permissionPresets/catalog",
      { sessionId },
    );
    assert.deepEqual(
      modes.options.map((option) => option.value),
      ["ask", "yolo"],
    );
    const result = await bench.call<{ result: { kind: string } }>("commands/execute", {
      agentId: sessionId,
      line: "/permission yolo",
      submittedAttachments: [],
    });
    assert.equal(result.result.kind, "success");
    const bad = await bench.call<{ result: { kind: string } }>("commands/execute", {
      agentId: sessionId,
      line: "/permission nope",
      submittedAttachments: [],
    });
    assert.equal(bad.result.kind, "error");
    await prompt(sessionId, "hi");
    await waitFor(() => turnEnds(sessionId).length === 1, "turn");
    const rejected = await bench.rpc.dispatch("session/selectModel", {
      args: { request: { sessionId, provider: "other", model: "x" } },
    });
    assert.equal(rejected.ok, false);
  });

  it("rejects attachments instead of dropping them", async () => {
    const sessionId = await newSession();
    const result = await bench.rpc.dispatch("session/prompt", {
      args: {
        request: {
          requestId: "i",
          sessionId,
          mode: "queue",
          content: [{ type: "image", mediaType: "image/png", data: "AAAA" }],
        },
      },
    });
    assert.equal(result.ok, false);
  });
});

describe("fork", () => {
  it("forks at a completed turn with its checkpoint and copies the journal prefix", async () => {
    defined(globalThis.fakeHarnessScripts).one = [
      {
        event: {
          type: "item.completed",
          snapshot: {
            item: { type: "agentMessage", itemId: "a1", text: "first" },
            outcome: { status: "succeeded" },
          },
        },
      },
      {
        event: {
          type: "turn.completed",
          outcome: { status: "succeeded", checkpoint: { harnessId: "fake", key: "cp-1" } },
        },
      },
    ];
    defined(globalThis.fakeHarnessScripts).two = [
      {
        event: {
          type: "item.completed",
          snapshot: {
            item: { type: "agentMessage", itemId: "a2", text: "second" },
            outcome: { status: "succeeded" },
          },
        },
      },
      {
        event: {
          type: "turn.completed",
          outcome: { status: "succeeded", checkpoint: { harnessId: "fake", key: "cp-2" } },
        },
      },
    ];
    const sessionId = await newSession();
    await prompt(sessionId, "one");
    await waitFor(() => turnEnds(sessionId).length === 1, "turn 1");
    await prompt(sessionId, "two");
    await waitFor(() => turnEnds(sessionId).length === 2, "turn 2");
    const firstEnd = defined(turnEnds(sessionId)[0]);
    const { sessionId: forkId } = await bench.call<{ sessionId: string }>("session/fork", {
      request: { sessionId, atSeq: firstEnd.seq },
    });
    assert.deepEqual(
      defined(globalThis.fakeHarnessLog)
        .filter((entry) => entry.open !== undefined)
        .map((entry) => entry.open),
      ["create", "fork"],
    );
    const forked = journal(forkId);
    assert.equal(forked.length, firstEnd.seq + 1);
    assert.equal(defined(forked.at(-1)).type, "turn/end");
    const list = await bench.call<{
      items: Array<{ sessionId: string; projections: { values: { title: string } } }>;
    }>("session/list", {});
    assert.match(
      defined(list.items.find((item) => item.sessionId === forkId)).projections.values.title,
      /^Fork · /u,
    );
    await prompt(forkId, "after fork");
    await waitFor(() => turnEnds(forkId).length === 2, "fork turn");
    assert.equal(
      (
        defined(
          journal(forkId)
            .filter((event) => event.type === "turn/start")
            .at(-1),
        ).data as { turn: number }
      ).turn,
      2,
    );
  });
});

function followSnapshot(sessionId: string): Promise<{ records: Array<{ event: WireEvent }> }> {
  return new Promise((resolve) => {
    const frames: unknown[] = [];
    const capture: StreamSink = {
      id: "follow",
      closed: false,
      push: (frame) => {
        frames.push(frame);
        if ((frame as { type?: string }).type === "snapshot")
          resolve(frame as { records: Array<{ event: WireEvent }> });
      },
      end() {},
      fail() {},
      onClose() {},
    };
    const handler = defined(
      (
        bench.streams as unknown as {
          handlers: Map<string, (args: unknown, sink: StreamSink) => void>;
        }
      ).handlers.get("session/follow"),
    );
    handler(
      { request: { address: { kind: "session", sessionId }, assistantStream: true } },
      capture,
    );
  });
}

const historyTurn = (prompt: string, reply: string, startedAtMs: number) => ({
  nativeTurnRef: { harnessId: "fake", nativeSessionId: "h", nativeTurnKey: prompt },
  input: [{ type: "text", text: prompt }],
  items: [
    {
      item: {
        type: "commandExecution",
        itemId: `c-${prompt}`,
        command: "ls",
        output: "a\n",
        exitCode: 0,
      },
      outcome: { status: "succeeded" },
    },
    {
      item: { type: "agentMessage", itemId: `m-${prompt}`, text: reply },
      outcome: { status: "succeeded" },
    },
  ],
  outcome: { status: "succeeded" },
  startedAtMs,
  completedAtMs: startedAtMs + 31_000,
  checkpoint: { key: `cp-${prompt}` },
});

describe("native session import", () => {
  it("imports once, replays history with native timestamps on first open, and resumes", async () => {
    process.env.FAKE_HARNESS_CWD = bench.cwd;
    globalThis.fakeHarnessHistory = {
      "native-1": [
        historyTurn("first", "one", 1_700_000_000_000),
        historyTurn("second", "two", 1_700_000_100_000),
      ],
    };
    const candidates = await bench.call<{
      items: Array<{ nativeSessionId: string; imported?: string }>;
    }>("codexhost/importCandidates", { request: { harnessId: "fake" } });
    assert.deepEqual(
      candidates.items.map((item) => item.nativeSessionId),
      ["native-1"],
    );
    const first = await bench.call<{ sessionId: string; created: boolean }>("codexhost/import", {
      request: { harnessId: "fake", nativeSessionId: "native-1" },
    });
    const again = await bench.call<{ sessionId: string; created: boolean }>("codexhost/import", {
      request: { harnessId: "fake", nativeSessionId: "native-1" },
    });
    assert.equal(first.created, true);
    assert.deepEqual(again, { sessionId: first.sessionId, created: false });
    const snapshot = await followSnapshot(first.sessionId);
    const types = snapshot.records.map((record) => record.event.type);
    assert.equal(types.filter((type) => type === "turn/start").length, 2);
    assert.equal(types.filter((type) => type === "tool/call").length, 2);
    const turnStart = defined(
      snapshot.records.find((record) => record.event.type === "turn/start"),
    ).event;
    const turnEnd = defined(
      snapshot.records.find((record) => record.event.type === "turn/end"),
    ).event;
    assert.equal(turnStart.time, 1_700_000_000_000);
    assert.equal(turnEnd.time - turnStart.time, 31_000);
    // History reads open the native session for resume, and later prompts continue it.
    await prompt(first.sessionId, "third");
    await waitFor(() => turnEnds(first.sessionId).length === 3, "resumed turn");
    assert.ok(defined(globalThis.fakeHarnessLog).some((entry) => entry.open === "resume"));
    const meta = bench.data.readJson<Record<string, { checkpoints?: Record<string, unknown> }>>(
      "sessions/index.json",
      {},
    )[first.sessionId];
    assert.deepEqual(Object.keys(meta?.checkpoints ?? {}).sort(), ["1", "2"]);
  });
});

describe("subagents", () => {
  it("lists delegated subagents in the parent catalog and replays the child transcript", async () => {
    globalThis.fakeHarnessSubagents = {
      "sub-native-1": [historyTurn("child task", "child done", 1_700_000_000_000)],
    };
    defined(globalThis.fakeHarnessScripts).delegate = [
      {
        event: {
          type: "item.started",
          item: {
            type: "subagentDelegation",
            itemId: "d1",
            operation: "spawn",
            prompt: "do it",
            subagents: [
              {
                subagentId: "s1",
                nativeSubagentId: "sub-native-1",
                description: "Child worker",
                background: false,
                status: "running",
              },
            ],
          },
        },
      },
      {
        event: {
          type: "item.completed",
          snapshot: {
            item: {
              type: "subagentDelegation",
              itemId: "d1",
              operation: "spawn",
              prompt: "do it",
              subagents: [
                {
                  subagentId: "s1",
                  nativeSubagentId: "sub-native-1",
                  description: "Child worker",
                  background: false,
                  status: "completed",
                  resultSummary: "ok",
                },
              ],
            },
            outcome: { status: "succeeded" },
          },
        },
      },
      { event: { type: "turn.completed", outcome: { status: "succeeded" } } },
    ];
    const sessionId = await newSession();
    await prompt(sessionId, "delegate");
    await waitFor(() => turnEnds(sessionId).length === 1, "delegation turn");
    const catalog = bench.data.readJson<Record<string, unknown>>(
      `sessions/${sessionId}/projections.json`,
      {},
    ).subagentCatalog as Array<{ id: string; label: string; mode: string }>;
    assert.equal(catalog.length, 1);
    assert.equal(defined(catalog[0]).label, "Child worker");
    const list = await bench.call<{
      items: Array<{ sessionId: string; origin?: string; parentSessionId?: string }>;
    }>("session/list", {});
    const child = defined(list.items.find((item) => item.sessionId === defined(catalog[0]).id));
    assert.equal(child.origin, "subagent");
    assert.equal(child.parentSessionId, sessionId);
    const snapshot = await followSnapshot(child.sessionId);
    const texts = snapshot.records
      .filter((record) => record.event.type === "assistant/message")
      .flatMap(
        (record) =>
          (record.event.data as { message: { content: Array<{ type: string; text?: string }> } })
            .message.content,
      )
      .filter((part) => part.type === "text")
      .map((part) => part.text);
    assert.deepEqual(texts, ["child done"]);
  });
});
