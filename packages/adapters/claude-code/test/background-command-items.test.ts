import type * as FsPromises from "node:fs/promises";
import { appendFile, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostEvent } from "@codexhost/harness-adapter";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";

import { ClaudeBackgroundCommandItems } from "../src/background-command-items.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, open: vi.fn(actual.open) };
});

const turnId = hostTurnIdSchema.parse("turn-1");
const itemId = hostItemIdSchema.parse("bash-item-1");
let directory: string | undefined;

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(open).mockReset();
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
    // A duplicate notification still belongs to the command while its final read is pending.
    expect(items.settle(notification("completed", file))).toBe(true);
    expect(items.taskIds()).toEqual([]);
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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { events, items } = follow(undefined);
    items.settle(notification("completed", path.join(tmpdir(), "claude-bg-missing", "x.output")));
    expect(await completion(events)).toMatchObject({
      snapshot: { item: { output: "Native output is unavailable." } },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports an open failure once, redacts credentials and still retries", async () => {
    const file = await outputFile();
    await writeFile(file, "recovered\n");
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const denied = Object.assign(new Error("EACCES api_key=private-value"), { code: "EACCES" });
    vi.mocked(open).mockRejectedValueOnce(denied).mockRejectedValueOnce(denied);
    const { events, items } = follow(file);
    try {
      await vi.advanceTimersByTimeAsync(2_000);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("EACCES api_key=[redacted]"));
      expect(events).toEqual([]);
      items.settle(notification("completed", file));
      expect(await completion(events)).toMatchObject({
        snapshot: { item: { output: "recovered\n" }, outcome: { status: "succeeded" } },
      });
    } finally {
      items.abandonAll("test ended");
    }
  });

  it("reports a failed read and does not mistake it for successfully read empty output", async () => {
    const file = await outputFile();
    const handle = await open(file, "r");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(handle, "read").mockRejectedValueOnce(new Error("EIO reading output"));
    const close = vi.spyOn(handle, "close");
    vi.mocked(open).mockResolvedValueOnce(handle);
    const { events, items } = follow(file);
    items.settle(notification("completed", file));
    expect(await completion(events)).toMatchObject({
      snapshot: { item: { output: "Native output is unavailable." } },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EIO reading output"));
    expect(close).toHaveBeenCalledOnce();
  });

  it("cancels commands whose native process is gone", () => {
    const { events, items } = follow(undefined);
    items.abandonAll("closed");
    expect(items.taskIds()).toEqual([]);
    expect(events).toMatchObject([
      { type: "item.completed", snapshot: { outcome: { status: "cancelled", reason: "closed" } } },
    ]);
  });

  it("settles a notified task before closing even while its final output open is pending", async () => {
    const file = await outputFile();
    await writeFile(file, "late output");
    const handle = await open(file, "r");
    const close = vi.spyOn(handle, "close");
    const pendingOpen = Promise.withResolvers<FsPromises.FileHandle>();
    vi.mocked(open).mockReturnValueOnce(pendingOpen.promise);
    const { events, items } = follow(file);
    try {
      items.settle(notification("failed", file));
      await Promise.resolve();
      items.abandonAll("Session closed");
      expect(events).toMatchObject([
        { type: "item.completed", snapshot: { outcome: { status: "failed" } } },
      ]);
      pendingOpen.resolve(handle);
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(events).toHaveLength(1);
    } finally {
      items.abandonAll("test ended");
      pendingOpen.resolve(handle);
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    }
  });

  it("closes a late output handle without reading after the command is abandoned", async () => {
    const file = await outputFile();
    const handle = await open(file, "r");
    const read = vi.spyOn(handle, "read");
    const close = vi.spyOn(handle, "close");
    const pendingOpen = Promise.withResolvers<FsPromises.FileHandle>();
    vi.mocked(open).mockReturnValueOnce(pendingOpen.promise);
    vi.useFakeTimers();
    const { items } = follow(file);
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      items.abandonAll("Session closed");
      pendingOpen.resolve(handle);
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(read).not.toHaveBeenCalled();
    } finally {
      items.abandonAll("test ended");
      pendingOpen.resolve(handle);
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    }
  });

  it("stops an in-flight read after abandonment without opening queued polls", async () => {
    const file = await outputFile();
    const handle = await open(file, "r");
    const pendingRead = Promise.withResolvers<undefined>();
    const read = vi.spyOn(handle, "read").mockImplementation(async () => {
      await pendingRead.promise;
      return { bytesRead: 1, buffer: Buffer.from("x") };
    });
    const close = vi.spyOn(handle, "close");
    vi.mocked(open).mockClear().mockResolvedValueOnce(handle);
    vi.useFakeTimers();
    const { events, items } = follow(file);
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
      // A further poll and the final read are queued behind the slow read.
      await vi.advanceTimersByTimeAsync(1_000);
      items.settle(notification("completed", file));
      items.abandonAll("Session closed");
      pendingRead.resolve(undefined);
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(read).toHaveBeenCalledOnce();
      expect(open).toHaveBeenCalledOnce();
      expect(events).toMatchObject([
        { type: "item.completed", snapshot: { outcome: { status: "succeeded" } } },
      ]);
    } finally {
      items.abandonAll("test ended");
      pendingRead.resolve(undefined);
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    }
  });
});
