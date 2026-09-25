import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DIAGNOSTIC_LOG_FILE_MAX_BYTES,
  FileDiagnosticLog,
  createDiagnosticLog,
  diagnosticLogDirectory,
  diagnosticLogLevel,
  formatDiagnosticRecord,
} from "../src/logging/diagnostic-log.js";
import { collectDiagnosticLogs } from "../src/logging/log-retention.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codexhost-log-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function readLines(filePath: string): Record<string, unknown>[] {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("diagnostic log location and level", () => {
  it("keeps logs inside the configured data directory", () => {
    expect(diagnosticLogDirectory({ CODEXHOST_DATA_DIR: path.join(os.tmpdir(), "data") })).toBe(
      path.join(path.resolve(os.tmpdir(), "data"), "logs"),
    );
    expect(diagnosticLogDirectory({})).toBe(path.join(os.homedir(), ".codexhost", "logs"));
  });

  it("defaults to info and accepts off", () => {
    expect(diagnosticLogLevel({})).toBe("info");
    expect(diagnosticLogLevel({ CODEXHOST_LOG_LEVEL: "DEBUG" })).toBe("debug");
    expect(diagnosticLogLevel({ CODEXHOST_LOG_LEVEL: "off" })).toBe("off");
    expect(diagnosticLogLevel({ CODEXHOST_LOG_LEVEL: "nonsense" })).toBe("info");
  });

  it("writes nothing when logging is off", async () => {
    const directory = temporaryDirectory();
    const log = createDiagnosticLog({
      CODEXHOST_DATA_DIR: directory,
      CODEXHOST_LOG_LEVEL: "off",
    });
    expect(log.directory).toBeNull();
    log.runtime("error", "host.diagnostic", { message: "ignored" });
    log.thread("thread-1", "pi").write("error", "turn.completed", { turnId: "turn-1" });
    await log.flush();
    expect(existsSync(path.join(directory, "logs"))).toBe(false);
  });

  it("separates Thread logs from the process log", async () => {
    const directory = temporaryDirectory();
    const log = new FileDiagnosticLog({ directory, level: "info", pid: 4242 });
    log.runtime("info", "host.started", { platform: "linux" });
    log.thread("thread-1", "pi").write("info", "turn.started", { turnId: "turn-1" });
    await log.flush();

    const threadLines = readLines(path.join(directory, "threads", "thread-1.jsonl"));
    expect(threadLines).toHaveLength(1);
    expect(threadLines[0]).toMatchObject({
      level: "info",
      event: "turn.started",
      pid: 4242,
      hostThreadId: "thread-1",
      harnessId: "pi",
      turnId: "turn-1",
    });
    const runtimeFiles = readLines(
      path.join(
        directory,
        "runtime",
        `host-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-4242.jsonl`,
      ),
    );
    expect(runtimeFiles[0]).toMatchObject({ event: "host.started", platform: "linux" });
  });

  it("drops records below the configured level", async () => {
    const directory = temporaryDirectory();
    const log = new FileDiagnosticLog({ directory, level: "warn", pid: 7 });
    const thread = log.thread("thread-1", "pi");
    thread.write("debug", "desktop.request.completed", {});
    thread.write("info", "turn.started", {});
    thread.write("error", "session.faulted", {});
    await log.flush();
    expect(
      readLines(path.join(directory, "threads", "thread-1.jsonl")).map((l) => l.event),
    ).toEqual(["session.faulted"]);
  });

  it.each(["info", "debug"] as const)(
    "omits native error content from Thread and runtime files at %s level",
    async (level) => {
      const directory = temporaryDirectory();
      const log = new FileDiagnosticLog({
        directory,
        level,
        pid: 42,
        now: () => new Date("2026-09-25T00:00:00.000Z"),
      });
      const content = "SENTINEL_PRIVATE_COMMAND";
      const credential = "SENTINEL_JSON_CREDENTIAL";
      const nativeText = `Permission denied: printf '${content}'; {"api_key":"${credential}"}`;
      const error = {
        code: "nativeFailure" as const,
        retryable: false,
        stage: "turn",
        durationMs: 12,
        message: nativeText,
        diagnostic: nativeText,
        stderrTail: nativeText,
      };
      const thread = log.thread("thread-1", "antigravity");
      thread.output({ kind: "event", event: { type: "session.faulted", error } });
      thread.write("warn", "desktop.request.failed", {
        method: "turn/start",
        code: -32073,
        message: nativeText,
      });
      thread.write("info", "turn.completed", {
        status: "cancelled",
        cancelReason: nativeText,
      });
      log.runtime("error", "host.diagnostic", { message: nativeText, cause: nativeText, error });
      await log.flush();

      const records = [
        ...readLines(path.join(directory, "threads", "thread-1.jsonl")),
        ...readLines(path.join(directory, "runtime", "host-20260925-42.jsonl")),
      ];
      expect(records).toHaveLength(4);
      expect(JSON.stringify(records)).not.toContain(content);
      expect(JSON.stringify(records)).not.toContain(credential);
      expect(records[0]?.error).toEqual({
        code: "nativeFailure",
        retryable: false,
        stage: "turn",
        durationMs: 12,
      });
      expect(records[1]).toMatchObject({ method: "turn/start", code: -32073 });
      expect(records[2]).toMatchObject({ status: "cancelled" });
      expect(records[3]?.error).toEqual(records[0]?.error);
    },
  );

  it("keeps an unexpected Thread identity out of the filesystem path", async () => {
    const directory = temporaryDirectory();
    const log = new FileDiagnosticLog({ directory, level: "info", pid: 9 });
    log.thread("../../escape", "pi").write("error", "session.faulted", {});
    await log.flush();
    expect(existsSync(path.join(directory, "threads"))).toBe(false);
    const runtime = readLines(
      path.join(
        directory,
        "runtime",
        `host-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-9.jsonl`,
      ),
    );
    expect(runtime[0]).toMatchObject({ event: "session.faulted", hostThreadId: "../../escape" });
  });

  it("rotates a full Thread log once instead of growing without bound", async () => {
    const directory = temporaryDirectory();
    const threads = path.join(directory, "threads");
    mkdirSync(threads, { recursive: true });
    const active = path.join(threads, "thread-1.jsonl");
    writeFileSync(active, "x".repeat(DIAGNOSTIC_LOG_FILE_MAX_BYTES), "utf8");
    const log = new FileDiagnosticLog({ directory, level: "info", pid: 11 });
    log.thread("thread-1", "pi").write("info", "turn.started", { turnId: "turn-1" });
    await log.flush();
    expect(readLines(active)).toHaveLength(1);
    expect(readFileSync(path.join(threads, "thread-1.1.jsonl"), "utf8")).toHaveLength(
      DIAGNOSTIC_LOG_FILE_MAX_BYTES,
    );
  });
});

describe("record sanitization", () => {
  const record = (fields: Record<string, unknown>): Record<string, unknown> =>
    JSON.parse(
      formatDiagnosticRecord({
        ts: new Date("2026-09-23T10:00:00.000Z"),
        level: "error",
        event: "host.diagnostic",
        pid: 1,
        fields: fields as never,
      }),
    ) as Record<string, unknown>;

  it("redacts credential-shaped keys and inline secrets", () => {
    expect(record({ apiKey: "sk-live-1234", access_token: "abc" })).toMatchObject({
      apiKey: "[redacted]",
      access_token: "[redacted]",
    });
    expect(
      record({ modelId: "custom Authorization: Bearer sk-live-secret" }).modelId,
    ).not.toContain("sk-live-secret");
  });

  it("replaces the home directory in paths", () => {
    const home = os.homedir();
    const cwd = record({ cwd: path.join(home, "project") }).cwd as string;
    expect(cwd).not.toContain(home);
    expect(cwd.startsWith("~")).toBe(true);
  });

  it("bounds long metadata values", () => {
    const head = record({ modelId: "a".repeat(10_000) }).modelId as string;
    expect(head.length).toBeLessThan(10_000);
    expect(head).toContain("[truncated");
  });

  it("drops a record whose fields exceed the size limit", () => {
    const parsed = record(
      Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [`field${index}`, "v".repeat(1_900)]),
      ),
    );
    expect(parsed).toMatchObject({ event: "host.diagnostic", truncated: true });
    expect(parsed.field0).toBeUndefined();
  });

  it("omits undefined fields and bounds nesting", () => {
    const parsed = record({
      present: 1,
      absent: undefined,
      deep: { a: { b: { c: { d: { e: 1 } } } } },
    });
    expect("absent" in parsed).toBe(false);
    expect(parsed.present).toBe(1);
    // Scalars stay readable at any depth; only unbounded object nesting is cut off.
    expect(JSON.stringify(parsed.deep)).toBe('{"a":{"b":{"c":{"d":"[truncated]"}}}}');
  });
});

describe("log retention", () => {
  function writeLog(directory: string, name: string, bytes: number, ageMs: number): string {
    const filePath = path.join(directory, name);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "x".repeat(bytes), "utf8");
    const time = new Date(Date.now() - ageMs);
    utimesSync(filePath, time, time);
    return filePath;
  }

  it("deletes logs past the retention window and keeps recent ones", async () => {
    const directory = temporaryDirectory();
    const stale = writeLog(directory, "threads/old.jsonl", 100, 20 * 24 * 60 * 60 * 1000);
    const fresh = writeLog(directory, "threads/new.jsonl", 100, 60_000);
    const result = await collectDiagnosticLogs(directory);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(result).toMatchObject({ deletedFiles: 1, freedBytes: 100 });
  });

  it("evicts the oldest inactive logs until the total fits", async () => {
    const directory = temporaryDirectory();
    const hour = 60 * 60 * 1000;
    const oldest = writeLog(directory, "threads/a.jsonl", 600, 5 * hour);
    const middle = writeLog(directory, "threads/b.jsonl", 600, 4 * hour);
    const newest = writeLog(directory, "runtime/c.jsonl", 600, 3 * hour);
    const result = await collectDiagnosticLogs(directory, Date.now(), {
      maxAgeMs: 14 * 24 * hour,
      maxTotalBytes: 1_300,
      activeWindowMs: hour,
    });
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(true);
    expect(existsSync(newest)).toBe(true);
    expect(result.remainingBytes).toBe(1_200);
  });

  it("never evicts a file that a live Host may still be writing", async () => {
    const directory = temporaryDirectory();
    const active = writeLog(directory, "threads/active.jsonl", 5_000, 1_000);
    const result = await collectDiagnosticLogs(directory, Date.now(), {
      maxAgeMs: 14 * 24 * 60 * 60 * 1000,
      maxTotalBytes: 10,
      activeWindowMs: 60 * 60 * 1000,
    });
    expect(existsSync(active)).toBe(true);
    expect(result.deletedFiles).toBe(0);
  });

  it("ignores a missing log directory", async () => {
    const directory = temporaryDirectory();
    await expect(collectDiagnosticLogs(path.join(directory, "absent"))).resolves.toMatchObject({
      deletedFiles: 0,
      remainingBytes: 0,
    });
  });
});
