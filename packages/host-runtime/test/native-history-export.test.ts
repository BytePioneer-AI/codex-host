import { mkdtemp, readdir, readFile, rm, appendFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storedThreadRecordV1Schema } from "@codexhost/mapping-store";
import type { JsonObject } from "@codexhost/protocol-core";
import { NativeHistoryExport, projectNativeHistory } from "../src/native-history-export.js";

const record = storedThreadRecordV1Schema.parse({
  formatVersion: 1,
  revision: 1,
  hostThreadId: "external",
  createRequestId: "create",
  harnessId: "omp",
  state: "ready",
  cwd: "/synthetic",
  title: "GLM and Luna",
  nativeSessionRef: { harnessId: "omp", nativeSessionId: "omp-session", formatVersion: 1 },
  archived: false,
  ephemeral: false,
  historyMode: "legacy",
  transportModelId: "codexhost/omp-native",
  turnMappings: [],
  createdAt: "2026-10-03T01:00:00.000Z",
  updatedAt: "2026-10-03T01:01:00.000Z",
});
const turn: JsonObject = {
  id: "turn-1",
  status: "completed",
  startedAt: 1790989200,
  completedAt: 1790989260,
  items: [
    { type: "userMessage", content: [{ type: "text", text: "Review this 🙂" }] },
    { type: "commandExecution", command: "read README.md", aggregatedOutput: "tool output" },
    { type: "agentMessage", text: "Reviewed", phase: "final_answer" },
  ],
};
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture(register?: (threadId: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-history-"));
  directories.push(root);
  const staging = path.join(root, "staging"),
    home = path.join(root, "home"),
    diagnose = vi.fn();
  const exporter = new NativeHistoryExport(staging, home, diagnose, register);
  const files = async () =>
    (await readdir(home, { recursive: true }).catch(() => []))
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => path.join(home, file));
  return { exporter, staging, home, files, diagnose };
}

describe("native history snapshots", () => {
  it("registers new and reused rollouts through the native reader, retrying failed registration", async () => {
    const register = vi
      .fn<(threadId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Native backend unavailable"))
      .mockResolvedValue(undefined);
    const f = await fixture(register);
    f.exporter.stage(record, [turn]);
    await f.exporter.exportOnExit([record]);
    const original = await f.files();
    expect(f.diagnose).toHaveBeenCalledTimes(1);
    await f.exporter.exportOnExit([record]);
    expect(await f.files()).toEqual(original);
    expect(register).toHaveBeenCalledTimes(2);
    expect(register.mock.calls[0]).toEqual(register.mock.calls[1]);
    expect(register.mock.calls[0]?.[0]).not.toBe(record.hostThreadId);
  });

  it("bounds stalled native registration while still publishing every eligible history file", async () => {
    const register = vi.fn(() => new Promise<void>(() => undefined));
    const f = await fixture(register);
    const second = storedThreadRecordV1Schema.parse({ ...record, hostThreadId: "second" });
    f.exporter.stage(record, [turn]);
    f.exporter.stage(second, [turn]);
    await f.exporter.exportOnExit([record, second]);
    expect(await f.files()).toHaveLength(2);
    expect(register).toHaveBeenCalledTimes(1);
    expect(f.diagnose).toHaveBeenCalledTimes(1);
  });

  it("publishes only on exit, reuses an identical snapshot, and preserves native continuation", async () => {
    const f = await fixture();
    f.exporter.stage(record, [turn]);
    expect(await f.files()).toEqual([]);
    await f.exporter.exportOnExit([record]);
    const files = await f.files();
    expect(files).toHaveLength(1);
    const file = files[0];
    if (!file) throw new Error("Missing exported history");
    const initial = await readFile(file, "utf8");
    await appendFile(file, "NATIVE CONTINUATION MUST SURVIVE\n");
    await f.exporter.exportOnExit([record]);
    expect(await f.files()).toEqual(files);
    expect(await readFile(file, "utf8")).toBe(initial + "NATIVE CONTINUATION MUST SURVIVE\n");
    expect(f.diagnose).not.toHaveBeenCalled();
    expect((await readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("coalesces staged history and gives changed snapshots independent native IDs", async () => {
    const f = await fixture();
    f.exporter.stage(record, [turn]);
    const next = { ...turn, id: "turn-2" };
    f.exporter.stage(record, [turn, next]);
    await f.exporter.exportOnExit([record]);
    let files = await f.files();
    expect(files).toHaveLength(1);
    const file = files[0];
    if (!file) throw new Error("Missing exported history");
    expect((await readFile(file, "utf8")).match(/"type":"task_started"/g)).toHaveLength(2);
    f.exporter.stage(record, [turn]);
    await f.exporter.exportOnExit([record]);
    files = await f.files();
    expect(files).toHaveLength(2);
    expect(f.diagnose).not.toHaveBeenCalled();
  });

  it.each([
    { archived: true },
    { ephemeral: true },
    { state: "creating" as const },
    { subagent: { parentHostThreadId: "parent", nativeSubagentId: "child" } },
    { nativeSessionRef: { ...record.nativeSessionRef, nativeSessionId: "replacement" } },
  ])("does not export hidden, provisional, ephemeral, or rebound Sessions: %j", async (patch) => {
    const f = await fixture();
    f.exporter.stage(record, [turn]);
    await f.exporter.exportOnExit([storedThreadRecordV1Schema.parse({ ...record, ...patch })]);
    expect(await f.files()).toEqual([]);
  });

  it("ignores removed Threads and unfinished history", async () => {
    const f = await fixture();
    f.exporter.stage(record, [{ ...turn, status: "inProgress" }]);
    await f.exporter.exportOnExit([record]);
    expect(await f.files()).toEqual([]);
    f.exporter.stage(record, [turn]);
    await f.exporter.exportOnExit([]);
    expect(await f.files()).toEqual([]);
  });

  it("does not export corrupted staging data", async () => {
    const f = await fixture();
    f.exporter.stage(record, [turn]);
    await f.exporter.exportOnExit([]);
    await writeFile(path.join(f.staging, "external.json"), '{"hostThreadId":"other"}');
    await f.exporter.exportOnExit([record]);
    expect(await f.files()).toEqual([]);
  });

  it("preserves messages, tool observations, provenance, and terminal failures in the projection", () => {
    const projected = projectNativeHistory({
      hostThreadId: record.hostThreadId,
      harnessId: record.harnessId,
      nativeSessionId: "omp-session",
      mappingFingerprint: "fixture",
      cwd: record.cwd,
      title: record.title,
      createdAt: record.createdAt,
      turns: [
        turn,
        { ...turn, id: "failed", status: "failed", error: { message: "Quota reached" } },
        { ...turn, id: "cancelled", status: "interrupted" },
      ],
    });
    expect(projected.id).not.toBe(record.hostThreadId);
    const rows = projected.text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows[0].payload.originator).toBe("codexhost-history:omp");
    expect(projected.text).toContain("[omp history] GLM and Luna");
    expect(projected.text).toContain("tool output");
    expect(projected.text).toContain("Reviewed");
    expect(
      rows.some((row) => row.payload.type === "error" && row.payload.message === "Quota reached"),
    ).toBe(true);
    expect(rows.some((row) => row.payload.type === "turn_aborted")).toBe(true);
    expect(rows.some((row) => row.payload.type === "function_call")).toBe(false);
  });
});
