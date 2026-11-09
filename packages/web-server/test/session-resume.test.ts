import assert from "node:assert/strict";
import { it } from "node:test";
import { deflateRawSync } from "node:zlib";
import { SessionLog, type WireEvent } from "../src/session-log.ts";

function journal(start = 0) {
  return new SessionLog(
    { version: 4, id: "resume", createdAt: 0, isSeeded: false },
    {
      readLines: () => [],
      readJson: (_path, fallback) => fallback,
      writeLines: () => {},
      writeJson: () => {},
      appendLine: () => {},
    },
    () => {},
    start,
  );
}
interface Opening {
  epoch: string;
  cursor: number;
  resumedAfter?: number;
  records: Array<{ type: "event"; event: WireEvent }>;
  projections: { values: Record<string, unknown> };
  assistantStream: { revision: number; activeAttempt?: { nextIndex: number; stream: unknown[] } };
}
function open(log: SessionLog, resume?: { epoch: string; cursor: number }) {
  const frames: unknown[] = [];
  let close = () => {};
  log.follow(
    {
      id: "test",
      closed: false,
      push: (frame) => frames.push(structuredClone(frame)),
      end: () => close(),
      fail: () => close(),
      onClose: (listener) => {
        close = listener;
      },
    },
    { assistantStream: true, ...(resume ? { resume } : {}) },
  );
  close();
  return frames[0] as Opening;
}

it("resumes only a continuous generation and keeps the epoch across prepended pages", () => {
  const log = journal(100);
  log.append("turn/start", { turn: 0 });
  log.append("user/message", { text: "old" });
  const snapshot = open(log);
  const resume = { epoch: snapshot.epoch, cursor: snapshot.cursor };
  assert.deepEqual(open(log, resume).records, []);
  log.append("assistant/message", { text: "new" });
  assert.deepEqual(
    open(log, resume).records.map((r) => r.event.seq),
    [102],
  );
  log.prepend([{ type: "turn/end", seq: 0, time: 0, data: { turn: -1 } }]);
  assert.equal(open(log, resume).resumedAfter, 101);
  for (const cursor of [97, 104, 101.5]) {
    assert.equal(open(log, { epoch: resume.epoch, cursor }).resumedAfter, undefined);
  }
  const restarted = journal(100);
  restarted.append("turn/start", { turn: 0 });
  restarted.append("user/message", { text: "same length, different history" });
  assert.equal(open(restarted, resume).resumedAfter, undefined);
  log.reset();
  log.append("turn/start", { turn: 1 });
  log.append("user/message", { text: "rewritten" });
  assert.equal(open(log, resume).resumedAfter, undefined);
});

it("restores non-durable assistant and tool baselines even at an unchanged durable cursor", () => {
  const log = journal();
  log.append("turn/start", { turn: 0 });
  log.startAttempt(0, 0);
  const snapshot = open(log);
  log.chunk({ type: "text-delta", text: "while away" });
  log.setProjection("codexhostToolOutput", { tool: "latest live output" });
  const resumed = open(log, snapshot);
  assert.deepEqual(resumed.records, []);
  assert.equal(resumed.assistantStream.activeAttempt?.nextIndex, 1);
  assert.equal(resumed.assistantStream.revision, 2);
  assert.deepEqual(resumed.projections.values.codexhostToolOutput, { tool: "latest live output" });
  log.endAttempt(undefined);
  assert.equal(open(log, snapshot).assistantStream.activeAttempt, undefined);
});

it("measures complete opening bytes before and after resuming", () => {
  const log = journal();
  for (let i = 0; i < 60; i++) {
    log.append("turn/start", { turn: i }, {}, i);
    log.append("user/message", { text: `question ${i}` }, { surfaceOp: "append" }, i);
    log.append(
      "assistant/message",
      { text: `answer ${i}: ${"history ".repeat(500)}` },
      { surfaceOp: "append" },
      i,
    );
    log.append("turn/end", { turn: i }, {}, i);
  }
  const held = open(log);
  const bytes = (frame: Opening) => {
    const body = JSON.stringify(frame);
    return { json: Buffer.byteLength(body), deflate: deflateRawSync(body, { level: 3 }).length };
  };
  for (const scenario of ["unchanged", "new-message", "stream-only"]) {
    const cache = open(log);
    if (scenario === "new-message")
      log.append("user/message", { text: "new since leaving" }, { surfaceOp: "append" }, 100);
    if (scenario === "stream-only") {
      log.startAttempt(60, 0);
      log.chunk({ type: "text-delta", text: "streaming while away" });
    }
    const full = open(log),
      resumed = open(log, cache);
    console.log(
      "RESUME_BYTES",
      scenario,
      JSON.stringify({ before: bytes(full), after: bytes(resumed) }),
    );
    assert.ok(bytes(resumed).json < bytes(full).json / 10);
    assert.equal(resumed.records.length, scenario === "new-message" ? 1 : 0);
  }
  assert.ok(held.records.length > 0);
});
