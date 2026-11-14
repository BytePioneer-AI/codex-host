import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HostEvent, HostItemSnapshot } from "@codexhost/harness-adapter";
import { hostItemIdSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeBrainDirPath, nativeConversationSummariesDbPath } from "../src/fork.js";
import { AntigravitySubagents, readNativeSubagentStatus } from "../src/subagents.js";
import { parseSubagentTranscript, readSubagentTranscript } from "../src/subagent-transcript.js";
const homes: string[] = [];
const observers: AntigravitySubagents[] = [];
afterEach(async () => {
  await Promise.all(observers.splice(0).map((observer) => observer.close()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  vi.useRealTimers();
});
const transcript = (text: string) =>
  [
    {
      step_index: 0,
      source: "USER",
      type: "USER_INPUT",
      status: "DONE",
      content: "<USER_REQUEST>\ntask\n</USER_REQUEST>",
    },
    {
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      thinking: "public summary",
      content: text,
    },
  ]
    .map((step) => JSON.stringify(step))
    .join("\n") + "\n";
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "agy-subagents-"));
  homes.push(home);
  const parentId = randomUUID();
  const childId = randomUUID();
  await mkdir(path.dirname(nativeConversationSummariesDbPath(home)), { recursive: true });
  const db = new DatabaseSync(nativeConversationSummariesDbPath(home));
  db.exec(
    "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT, status TEXT)",
  );
  db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, 'CASCADE_RUN_STATUS_RUNNING')").run(
    childId,
    parentId,
  );
  db.close();
  const log = path.join(
    nativeBrainDirPath(childId, home),
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
  await mkdir(path.dirname(log), { recursive: true });
  await writeFile(log, transcript("progress"));
  const events: HostEvent[] = [];
  const observer = new AntigravitySubagents({
    parentId: () => parentId,
    home,
    cwd: home,
    outputLimit: 1000,
    pollIntervalMs: 100,
    emit: (event) => events.push(event),
  });
  observers.push(observer);
  const item: HostItemSnapshot = {
    item: {
      type: "subagentDelegation",
      itemId: hostItemIdSchema.parse("spawn"),
      operation: "spawn",
      subagents: [
        {
          subagentId: childId,
          nativeSubagentId: childId,
          description: "research",
          model: "gemini",
          background: true,
          status: "running",
        },
      ],
    },
    outcome: { status: "succeeded" },
  };
  return { home, parentId, childId, log, events, observer, item };
}
describe("native ACP Subagent observation", () => {
  it("observes background status/transcript changes without adding Items to a completed parent Turn", async () => {
    const f = await fixture();
    f.observer.track(f.childId, f.item);
    await f.observer.refresh();
    expect(f.observer.running).toBe(true);
    expect(f.events).toContainEqual({
      type: "subagent.transcript.changed",
      nativeSubagentId: f.childId,
    });
    expect(f.observer.state(f.childId)).toMatchObject({
      model: "gemini",
      resultSummary: "progress",
      status: "running",
    });
    const db = new DatabaseSync(nativeConversationSummariesDbPath(f.home));
    db.prepare(
      "UPDATE conversation_summaries SET status = 'CASCADE_RUN_STATUS_IDLE' WHERE conversation_id = ?",
    ).run(f.childId);
    db.close();
    await writeFile(f.log, transcript("finished"));
    await f.observer.refresh();
    expect(f.observer.running).toBe(false);
    expect(f.events).toContainEqual({
      type: "subagent.state.changed",
      nativeSubagentId: f.childId,
      status: "completed",
      resultSummary: "finished",
    });
    expect(
      f.events.every((event) => !event.type.startsWith("item.") && !event.type.startsWith("turn.")),
    ).toBe(true);
    const count = f.events.length;
    await f.observer.refresh();
    expect(f.events).toHaveLength(count);
  });
  it("reports a terminal transcript error as failed rather than successful idle", async () => {
    const f = await fixture();
    const db = new DatabaseSync(nativeConversationSummariesDbPath(f.home));
    db.prepare(
      "UPDATE conversation_summaries SET status = 'CASCADE_RUN_STATUS_IDLE' WHERE conversation_id = ?",
    ).run(f.childId);
    db.close();
    await writeFile(
      f.log,
      transcript("progress") +
        JSON.stringify({
          step_index: 2,
          source: "MODEL",
          type: "ERROR",
          status: "ERROR",
          content: "native error",
        }) +
        "\n",
    );
    f.observer.track(f.childId, f.item);
    await f.observer.refresh();
    expect(f.observer.state(f.childId)?.status).toBe("failed");
    expect(f.observer.running).toBe(false);
  });
  it("does not invent completion when native status is unavailable or belongs to another parent", async () => {
    const f = await fixture();
    f.observer.track(f.childId, f.item);
    await f.observer.refresh();
    expect(await readNativeSubagentStatus(f.home, randomUUID(), f.childId)).toBeNull();
    await rm(nativeConversationSummariesDbPath(f.home));
    await f.observer.refresh();
    expect(f.observer.running).toBe(true);
  });
  it("stops polling and publishing on close, including an in-flight refresh", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.observer.track(f.childId, f.item);
    await f.observer.refresh();
    expect(vi.getTimerCount()).toBe(1);
    const refresh = f.observer.refresh();
    await f.observer.close();
    await refresh;
    expect(vi.getTimerCount()).toBe(0);
    const count = f.events.length;
    await writeFile(f.log, transcript("late"));
    await f.observer.refresh();
    expect(f.events).toHaveLength(count);
  });
  it("reads stable native transcript identities and real child status", async () => {
    const f = await fixture();
    const input = {
      parentId: f.parentId,
      childId: f.childId,
      status: "completed" as const,
      cwd: f.home,
      outputLimit: 1000,
      home: f.home,
    };
    const first = await readSubagentTranscript(input);
    expect(first).toEqual(await readSubagentTranscript(input));
    expect(first).toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            input: [{ type: "text", text: "task" }],
            outcome: { status: "succeeded" },
            items: [
              { item: { type: "reasoning", text: "public summary" } },
              { item: { type: "agentMessage", text: "progress" } },
            ],
          },
        ],
      },
    });
  });
  it("rejects traversal and logs redirected outside their native location", async () => {
    const f = await fixture();
    expect(
      await readSubagentTranscript({
        parentId: f.parentId,
        childId: "../escape",
        status: "running",
        cwd: f.home,
        outputLimit: 1000,
        home: f.home,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await rm(f.log);
    const outside = path.join(f.home, "outside.jsonl");
    await writeFile(outside, transcript("secret"));
    await symlink(outside, f.log);
    expect(
      await readSubagentTranscript({
        parentId: f.parentId,
        childId: f.childId,
        status: "running",
        cwd: f.home,
        outputLimit: 1000,
        home: f.home,
      }),
    ).toMatchObject({ ok: false, error: { code: "protocolError" } });
  });
  it("ignores an incomplete final line but rejects duplicate native steps", () => {
    const parent = randomUUID();
    const child = randomUUID();
    expect(
      parseSubagentTranscript(
        transcript("text") + '{"step_index":2',
        parent,
        child,
        "running",
        "/cwd",
        100,
      ).turns[0]?.outcome.status,
    ).toBe("unknown");
    expect(() =>
      parseSubagentTranscript(
        transcript("text") + transcript("duplicate"),
        parent,
        child,
        "completed",
        "/cwd",
        100,
      ),
    ).toThrow("Duplicate");
  });
});
