import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { FileDiagnosticLog } from "../src/logging/diagnostic-log.js";
import { exportDiagnosticLogs, listDiagnosticLogs } from "../src/logging/log-export.js";

const directories: string[] = [];
function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codexhost-log-export-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("diagnostic log export", () => {
  it("exports one Harness including rotated logs and keeps runtime and other Harnesses separate", async () => {
    const directory = temporaryDirectory();
    const source = path.join(directory, "logs");
    const log = new FileDiagnosticLog({ directory: source, level: "info" });
    log.thread("pi-thread", "pi").write("info", "turn.started", { turnId: "pi-turn" });
    log
      .thread("claude-thread", "claude-code")
      .write("info", "turn.started", { turnId: "claude-turn" });
    log.runtime("info", "host.started");
    await log.flush();
    copyFileSync(
      path.join(source, "threads", "pi-thread.jsonl"),
      path.join(source, "threads", "pi-thread.1.jsonl"),
    );
    writeFileSync(path.join(source, "threads", "credentials.txt"), "SENTINEL_SECRET");
    mkdirSync(path.join(source, "unrelated"));
    writeFileSync(path.join(source, "unrelated", "private.jsonl"), "SENTINEL_PRIVATE");
    expect(await listDiagnosticLogs(source)).toEqual([
      { kind: "harness", harnessId: "claude-code" },
      { kind: "harness", harnessId: "pi" },
      { kind: "runtime" },
    ]);
    const result = await exportDiagnosticLogs(source, { kind: "harness", harnessId: "pi" });
    expect(result.fileCount).toBe(2);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.fileName).toContain("harness-pi-");
    const contents = gunzipSync(Buffer.from(result.data, "base64")).toString("utf8");
    const records = contents
      .trim()
      .split(/\n+/)
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.harnessId === "pi")).toBe(true);
    expect(contents).not.toMatch(/claude-turn|host.started|SENTINEL/);
    const runtime = await exportDiagnosticLogs(source, { kind: "runtime" });
    expect(runtime.fileCount).toBe(1);
    expect(gunzipSync(Buffer.from(runtime.data, "base64")).toString("utf8")).toContain(
      "host.started",
    );
    expect(gunzipSync(Buffer.from(runtime.data, "base64")).toString("utf8")).not.toContain(
      "pi-turn",
    );
  });

  it("reports missing logs without creating an empty archive", async () => {
    const directory = temporaryDirectory();
    expect(await listDiagnosticLogs(path.join(directory, "missing"))).toEqual([]);
    await expect(
      exportDiagnosticLogs(directory, { kind: "harness", harnessId: "pi" }),
    ).rejects.toThrow("No diagnostic logs");
  });
});
