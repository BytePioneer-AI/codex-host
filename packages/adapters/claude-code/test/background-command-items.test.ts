import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostEvent } from "@codexhost/harness-adapter";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";

import { ClaudeBackgroundCommandItems } from "../src/background-command-items.js";

const turnId = hostTurnIdSchema.parse("turn-1");
const itemId = hostItemIdSchema.parse("bash-item-1");
let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function outputFile(): Promise<string> {
  directory = await mkdtemp(path.join(tmpdir(), "claude-bg-"));
  const file = path.join(directory, "task-1.output");
  await writeFile(file, "");
  return file;
}

function follow(liveOutputFile: string | undefined, outputLimit = 1_000) {
  const events: HostEvent[] = [];
  const items = new ClaudeBackgroundCommandItems({ outputLimit, emit: (e) => events.push(e) });
  items.follow({
    turnId,
    callId: "bash-1",
    taskId: "task-1",
    item: { type: "commandExecution", itemId, command: "sleep 3; false", cwd: "/w" },
    startedAtMs: Date.now(),
    ...(liveOutputFile ? { outputFile: liveOutputFile } : {}),
  });
  return { events, items };
}

function notification(
  status: "completed" | "failed" | "interrupted",
  outputFile?: string,
  callId = "bash-1",
) {
  return {
    type: "subagent.settled" as const,
    nativeSubagentId: "task-1",
    callId,
    status,
    ...(outputFile ? { outputFile } : {}),
  };
}

async function completion(events: HostEvent[]) {
  await vi.waitFor(() => expect(events.some((e) => e.type === "item.completed")).toBe(true));
  const completed = events.find((e) => e.type === "item.completed");
  if (completed?.type !== "item.completed") throw new Error("Item did not complete");
  return completed;
}

describe("Claude background command Items", () => {
  it("streams the live output file and completes once on the task notification", async () => {
    const file = await outputFile();
    const { events, items } = follow(file);
    await appendFile(file, "héllo ");
    await appendFile(file, "wörld\n");

    expect(items.settle(notification("failed", file))).toBe(true);
    expect(items.settle(notification("completed", file))).toBe(false);
    const completed = await completion(events);

    const appended = events
      .flatMap((e) =>
        e.type === "item.updated" && e.update.type === "output.append" ? [e.update.text] : [],
      )
      .join("");
    expect(appended).toBe("héllo wörld\n");
    expect(completed).toMatchObject({
      turnId,
      snapshot: { item: { itemId, output: "héllo wörld\n" }, outcome: { status: "failed" } },
    });
    expect(events.filter((e) => e.type === "item.completed")).toHaveLength(1);
  });

  it("reads the notification's output file when the live path was unknown", async () => {
    const file = await outputFile();
    await appendFile(file, "done\n");
    const { events, items } = follow(undefined);
    items.settle(notification("completed", file));
    expect(await completion(events)).toMatchObject({
      snapshot: { item: { output: "done\n" }, outcome: { status: "succeeded" } },
    });
  });

  it("leaves notifications it does not follow to the caller", () => {
    const { events, items } = follow(undefined);
    expect(items.settle(notification("completed", undefined, "agent-call"))).toBe(false);
    expect(events).toEqual([]);
  });

  it("bounds output and reports a stopped task as cancelled", async () => {
    const file = await outputFile();
    await appendFile(file, "abcdefgh");
    const { events, items } = follow(file, 4);
    items.settle(notification("interrupted", file));
    expect(await completion(events)).toMatchObject({
      snapshot: {
        item: { output: "abcd", outputTruncated: true },
        outcome: { status: "cancelled", reason: "Background command stopped" },
      },
    });
  });

  it("says so when no output file could be read", async () => {
    const { events, items } = follow(undefined);
    items.settle(notification("completed", path.join(tmpdir(), "claude-bg-missing", "x.output")));
    expect(await completion(events)).toMatchObject({
      snapshot: { item: { output: "Native output is unavailable." } },
    });
  });

  it("cancels commands whose native process is gone", () => {
    const { events, items } = follow(undefined);
    items.abandonAll("closed");
    expect(items.taskIds()).toEqual([]);
    expect(events).toMatchObject([
      { type: "item.completed", snapshot: { outcome: { status: "cancelled", reason: "closed" } } },
    ]);
  });
});
