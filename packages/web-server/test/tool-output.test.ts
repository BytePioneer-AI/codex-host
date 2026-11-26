import assert from "node:assert/strict";
import { defined } from "./support/defined.ts";
import { it } from "node:test";
import { deflateRawSync } from "node:zlib";
import { SessionLog, type WireEvent } from "../src/session-log.ts";
import { capText } from "../src/projector.ts";
import { webToolOutputPreviews } from "@codexhost/shared-contracts";
import {
  compactLogToolOutputs,
  readToolOutput,
  resolveToolOutput,
  toolOutputRecords,
  toolOutputSink,
  TOOL_OUTPUT_LIMIT,
  TOOL_OUTPUT_WINDOW_BUDGET,
  TOOL_OUTPUT_PREVIEW,
} from "../src/tool-output.ts";
import type { StreamSink } from "../src/transport.ts";

function journal() {
  return new SessionLog(
    { version: 4, id: "tool-session", createdAt: 0, isSeeded: false },
    {
      readLines: () => [],
      readJson: (_path, fallback) => fallback,
      writeLines: () => {},
      writeJson: () => {},
      appendLine: () => {},
    },
    () => {},
  );
}
function result(log: SessionLog, text: string, turn: number, ended = true) {
  log.append("turn/start", { turn });
  const event = log.append("tool/result", {
    turn,
    step: 0,
    message: { source: { callId: `tool-${turn}` }, content: [{ type: "text", text }] },
  });
  if (ended) log.append("turn/end", { turn });
  return { type: "event" as const, event };
}
const textOf = (event: WireEvent) =>
  (event.data as { message: { content: Array<{ text: string }> } }).message.content[0]?.text;
const refs = (event: WireEvent) => webToolOutputPreviews((event.data as { meta?: unknown }).meta);

it("previews large or over-budget settled text without changing local or active results", () => {
  const log = journal();
  const large = result(log, "L".repeat(TOOL_OUTPUT_LIMIT + 1), 0);
  const active = result(log, "A".repeat(90_000), 1, false);
  const original = JSON.stringify(log.events);
  const records = toolOutputRecords(log, [large, active]);
  const first = defined(records[0]).event;
  const second = defined(records[1]).event;
  assert.equal(textOf(first)?.length, TOOL_OUTPUT_PREVIEW);
  assert.equal(textOf(second)?.length, 90_000);
  assert.equal(refs(second).length, 0);
  assert.equal(JSON.stringify(log.events), original);
  assert.equal(readToolOutput(log, defined(refs(first)[0]).reference).text, textOf(large.event));
  const medium = Array.from({ length: 6 }, (_, turn) =>
    result(log, "m".repeat(TOOL_OUTPUT_WINDOW_BUDGET / 4), turn + 2),
  );
  const sent = toolOutputRecords(log, medium);
  assert.deepEqual(
    sent.map((r) => refs(r.event).length),
    [1, 1, 0, 0, 0, 0],
  );
  assert.equal(textOf(defined(sent[0]).event)?.length, TOOL_OUTPUT_PREVIEW);
  assert.equal(
    textOf(defined(sent.at(-1)).event)?.length,
    TOOL_OUTPUT_WINDOW_BUDGET / 4,
    "newest output keeps its full text",
  );
  assert.deepEqual(
    sent.map((record) => record.event.seq),
    medium.map((record) => record.event.seq),
  );
  const boundary = result(log, "b".repeat(TOOL_OUTPUT_LIMIT), 9);
  assert.equal(refs(defined(toolOutputRecords(log, [boundary])[0]).event).length, 0);
  const unicode = result(
    log,
    "x".repeat(TOOL_OUTPUT_PREVIEW - 1) + "😀" + "y".repeat(TOOL_OUTPUT_LIMIT),
    10,
  );
  assert.equal(
    textOf(defined(toolOutputRecords(log, [unicode])[0]).event)?.length,
    TOOL_OUTPUT_PREVIEW - 1,
  );
  const pushed: unknown[] = [];
  const sink: StreamSink = {
    id: "direct",
    closed: false,
    push: (value) => pushed.push(value),
    end: () => {},
    fail: () => {},
    onClose: () => {},
  };
  toolOutputSink(log, sink).push({ type: "snapshot", records: [large, active] });
  const directFrame = pushed[0] as { records: Array<{ event: WireEvent }> };
  assert.equal(textOf(defined(directFrame.records[0]).event)?.length, TOOL_OUTPUT_PREVIEW);
  assert.equal(refs(defined(directFrame.records[0]).event).length, 1);
  assert.equal(textOf(defined(directFrame.records[1]).event)?.length, 90_000);
  assert.equal(refs(defined(directFrame.records[1]).event).length, 0);
});

it("passes live events through without accessing the history journal", () => {
  const log = journal();
  const event = result(log, "live".repeat(30_000), 0, false);
  const guarded = new Proxy(log, {
    get(target, key, receiver) {
      assert.notEqual(key, "events", "live forwarding must not scan the journal");
      return Reflect.get(target, key, receiver);
    },
  });
  for (const relay of [false, true]) {
    let pushed: unknown;
    const sink: StreamSink = {
      id: relay ? "relay" : "direct",
      ...(relay ? { relay: true } : {}),
      closed: false,
      push: (value) => {
        pushed = value;
      },
      end: () => {},
      fail: () => {},
      onClose: () => {},
    };
    toolOutputSink(guarded, sink).push(event);
    assert.equal(pushed, event);
  }
});

it("reads only the exact capped projection version and rejects foreign or rewritten references", () => {
  const log = journal();
  const capped = capText("z".repeat(200_000));
  const record = result(log, capped, 0);
  const ref = defined(refs(defined(toolOutputRecords(log, [record])[0]).event)[0]).reference;
  assert.equal(readToolOutput(log, ref).text, capped);
  assert.match(capped, /characters truncated/);
  for (const bad of [
    { ...ref, version: "old" },
    { ...ref, sessionId: "other" },
    { ...ref, turn: 42 },
    { ...ref, callId: "other" },
    { ...ref, part: 8 },
  ]) {
    assert.throws(() => readToolOutput(log, bad), { code: "session/tool-output-stale" });
  }
  log.reset();
  result(log, capped, 0);
  assert.throws(() => readToolOutput(log, ref), { code: "session/tool-output-stale" });
});

it("measures complete relay opening bytes and previews snapshots, resume windows and pages identically", () => {
  const log = journal();
  // Non-repeating, deterministic diagnostics give compression a realistic workload.
  let seed = 17;
  const output = Array.from({ length: 12_000 }, (_, n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return `${n.toString(16)} ${seed.toString(36)} diagnostic\n`;
  }).join("");
  const record = result(log, capText(output), 0);
  const frames: unknown[] = [];
  const sink: StreamSink = {
    id: "relay",
    relay: true,
    closed: false,
    push: (frame) => frames.push(frame),
    end: () => {},
    fail: () => {},
    onClose: () => {},
  };
  log.follow(sink, { assistantStream: true });
  const full = frames.shift() as { records: Array<{ type: "event"; event: WireEvent }> };
  const wrapped = toolOutputSink(log, sink);
  wrapped.push(full);
  const preview = frames.shift() as typeof full;
  const bytes = (frame: unknown) => {
    const json = JSON.stringify(frame);
    return { json: Buffer.byteLength(json), deflate: deflateRawSync(json, { level: 3 }).length };
  };
  console.log("TOOL_OUTPUT_BYTES", JSON.stringify({ before: bytes(full), after: bytes(preview) }));
  assert.ok(bytes(preview).json < bytes(full).json / 5);
  assert.ok(bytes(preview).deflate < bytes(full).deflate / 5);
  assert.equal(JSON.stringify(preview).includes(output.slice(20_000, 20_100)), false);
  wrapped.push({ ...full, resumedAfter: -1 });
  const resumed = frames.shift() as typeof full;
  assert.deepEqual(resumed.records, preview.records);
  const page = log.page(log.lastSeq, undefined);
  assert.deepEqual(
    toolOutputRecords(log, page.records as Array<{ type: "event"; event: WireEvent }>),
    preview.records,
  );
  assert.equal(textOf(record.event), capText(output));
});

it("compacts settled oversized tool text in place and resolves it on demand with version checks", async () => {
  const log = journal();
  const full = capText("C".repeat(150_000));
  const settled = result(log, full, 0, true);
  const active = result(log, "A".repeat(90_000), 1, false);
  const originalEvent = settled.event;

  compactLogToolOutputs(log);

  // Original event object is untouched (safe for already-delivered live frames),
  // while the journal slot holds only the bounded preview + SHA-256 metadata.
  assert.equal(textOf(originalEvent), full);
  const compacted = defined(log.events.find((e) => e.seq === settled.event.seq));
  assert.notEqual(compacted, originalEvent);
  assert.equal(textOf(compacted)?.length, TOOL_OUTPUT_PREVIEW);
  const preview = defined(refs(compacted)[0]);
  assert.equal(preview.length, full.length);
  assert.equal(preview.bytes, Buffer.byteLength(full, "utf8"));

  // Active Turn stays full in the journal.
  const activeStored = defined(log.events.find((e) => e.seq === active.event.seq));
  assert.equal(textOf(activeStored)?.length, 90_000);
  assert.equal(refs(activeStored).length, 0);

  // Running toolOutputRecords over already-compacted events keeps existing previews intact.
  const sent = toolOutputRecords(log, [{ type: "event", event: compacted }]);
  assert.deepEqual(refs(defined(sent[0]).event), [preview]);

  // Synchronous readToolOutput never treats a compacted preview as authoritative full text.
  assert.throws(() => readToolOutput(log, preview.reference), {
    code: "session/tool-output-stale",
  });

  // resolveToolOutput reloads compacted entries and checks the SHA-256 fingerprint.
  let loads = 0;
  const loaded = await resolveToolOutput(log, preview.reference, async () => {
    loads += 1;
    return full;
  });
  assert.equal(loads, 1);
  assert.equal(loaded.text, full);

  // Tampered reference is rejected before invoking loadFull.
  await assert.rejects(
    resolveToolOutput(log, { ...preview.reference, version: "tampered" }, async () => {
      loads += 1;
      return full;
    }),
    { code: "session/tool-output-stale" },
  );
  assert.equal(loads, 1);

  // Mismatched content from reload is rejected as stale.
  await assert.rejects(
    resolveToolOutput(log, preview.reference, async () => "mutated"),
    { code: "session/tool-output-stale" },
  );
});
