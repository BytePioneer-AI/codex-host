import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDelegationCli } from "../src/delegation-cli.js";
import { delegationCliHelp } from "../src/delegation-cli-help.js";
import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import { startDelegationControlServer } from "../src/delegation-control-server.js";
import {
  exportDelegationThread,
  type FullDelegationThread,
} from "../src/delegation-thread-export.js";
import type { DelegationControlRegistration } from "../src/delegation-types.js";

const source: FullDelegationThread = {
  threadId: "thread-1",
  harnessId: "pi",
  thread: {
    id: "thread-1",
    cwd: "/workspace",
    title: "Debug",
    status: { type: "idle" },
    extra: true,
  },
  running: false,
  turns: [
    {
      id: "turn-1",
      status: "completed",
      items: [
        { id: "u1", type: "userMessage", content: [{ type: "text", text: "input-body" }] },
        { id: "r1", type: "reasoning", summary: ["reasoning-body"], content: ["full-reasoning"] },
        { id: "c1", type: "commandExecution", command: "ls", aggregatedOutput: "tool-output" },
        { id: "f1", type: "fileChange", changes: [{ path: "a.ts", diff: "+code" }] },
        { id: "m1", type: "mcpToolCall", server: "test", tool: "lookup", result: { value: 42 } },
        { id: "a1", type: "agentMessage", text: "answer-body", phase: "final" },
      ],
      extraTurnField: { preserved: true },
    },
    { id: "turn-2", status: "completed", items: [] },
  ],
};

function registration(directory: string): DelegationControlRegistration {
  return {
    listHarnesses: vi.fn(),
    inspect: vi.fn(),
    answer: vi.fn(),
    start: vi.fn(),
    send: vi.fn(),
    cancel: vi.fn(),
    read: vi.fn(),
    wait: vi.fn(),
    list: vi.fn(),
    canHandleStart: () => true,
    ownsThread: (id) => id === source.threadId,
    exportThread: (input) =>
      exportDelegationThread(input, source, { CODEXHOST_DATA_DIR: directory }),
  };
}

async function cli(arguments_: string[], endpoint: string) {
  const output = new PassThrough();
  const diagnosticOutput = new PassThrough();
  const code = await runDelegationCli({
    arguments: arguments_,
    environment: { CODEXHOST_RUNTIME_ENDPOINT: endpoint, CODEXHOST_RUNTIME_TOKEN: "export-test" },
    output,
    diagnosticOutput,
  });
  return {
    code,
    output: (output.read() as Buffer | null)?.toString() ?? "",
    errors: (diagnosticOutput.read() as Buffer | null)?.toString() ?? "",
  };
}

describe("Thread export", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "thread-export-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("exports every Turn/item unchanged to the default private file", async () => {
    const result = await exportDelegationThread({ threadId: source.threadId }, source, {
      CODEXHOST_DATA_DIR: directory,
    });
    expect(path.dirname(result.path)).toBe(path.join(directory, "exports"));
    expect(path.basename(result.path)).toMatch(
      /^thread-1-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z\.json$/u,
    );
    const bytes = await readFile(result.path);
    expect(result).toEqual({
      threadId: "thread-1",
      harnessId: "pi",
      path: result.path,
      bytes: bytes.length,
      turns: 2,
      complete: true,
    });
    expect(JSON.parse(bytes.toString())).toEqual({
      exportedAt: expect.any(String),
      thread: { ...source.thread, harnessId: "pi" },
      turns: source.turns,
    });
    if (process.platform !== "win32") expect((await stat(result.path)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.dirname(result.path))).toEqual([path.basename(result.path)]);
  });

  it("uses ~/.codexhost when no data directory is configured", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(directory);
    const result = await exportDelegationThread({ threadId: source.threadId }, source, {});
    expect(path.dirname(result.path)).toBe(path.join(directory, ".codexhost", "exports"));
  });

  it("creates directories and atomically overwrites --out with private permissions", async () => {
    const out = path.join(directory, "nested", "snapshot.json");
    await exportDelegationThread({ threadId: source.threadId, out }, source, {});
    await writeFile(out, "existing content");
    if (process.platform !== "win32") await chmod(out, 0o644);
    const result = await exportDelegationThread(
      { threadId: source.threadId, out },
      { ...source, running: true },
      {},
    );
    expect(result.path).toBe(out);
    expect(result.complete).toBe(false);
    expect(JSON.parse(await readFile(out, "utf8")).turns).toEqual(source.turns);
    if (process.platform !== "win32") expect((await stat(out)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.dirname(out))).toEqual(["snapshot.json"]);
  });

  it("cleans the temporary file if rename fails", async () => {
    await expect(
      exportDelegationThread({ threadId: source.threadId, out: directory }, source, {}),
    ).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  it("does not paginate large histories or duplicate embedded Turns", async () => {
    const turns = Array.from({ length: 150 }, (_, index) => ({
      id: `turn-${index}`,
      items: [{ type: "reasoning", text: "x".repeat(2048) }],
    }));
    const result = await exportDelegationThread(
      { threadId: source.threadId },
      { ...source, thread: { ...source.thread, turns }, turns },
      { CODEXHOST_DATA_DIR: directory },
    );
    const document = JSON.parse(await readFile(result.path, "utf8"));
    expect(result.turns).toBe(150);
    expect(document.turns).toEqual(turns);
    expect(document.thread).not.toHaveProperty("turns");
  });

  it.each(["json", "compact", "text"])(
    "returns only a %s summary through CLI/HTTP/Registry",
    async (format) => {
      const registry = new DelegationControlRegistry();
      registry.register(registration(directory));
      const server = await startDelegationControlServer({ token: "export-test", api: registry });
      try {
        const out = path.join(directory, `${format}.json`);
        const result = await cli(
          [
            "thread",
            "export",
            "codex://threads/thread-1",
            "--out",
            path.relative(process.cwd(), out),
            "--format",
            format,
          ],
          server.endpoint,
        );
        expect(result.code, result.errors).toBe(0);
        expect(result.errors).toBe("");
        const summary = {
          threadId: "thread-1",
          harnessId: "pi",
          path: out,
          bytes: (await stat(out)).size,
          turns: 2,
          complete: true,
        };
        if (format === "text") {
          expect(result.output).toBe(
            Object.entries(summary)
              .map(([key, value]) => `${key}: ${value}\n`)
              .join(""),
          );
        } else {
          expect(JSON.parse(result.output)).toEqual(summary);
        }
        for (const body of [
          "input-body",
          "reasoning-body",
          "tool-output",
          "answer-body",
          "extraTurnField",
        ])
          expect(result.output).not.toContain(body);
      } finally {
        await server.close();
        registry.close();
      }
    },
  );

  it("rejects remote Host exports without reading or exporting a local Thread", async () => {
    const api = registration(directory);
    const exporter = vi.spyOn(api, "exportThread");
    const registry = new DelegationControlRegistry();
    registry.register(api);
    const server = await startDelegationControlServer({ token: "export-test", api: registry });
    try {
      await expect(
        registry.exportThread({ threadId: "thread-1", hostId: "ssh:remote" }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        message: "Remote Hosts support thread read only",
      });
      const result = await cli(
        ["thread", "export", "thread://thread-1?hostId=ssh%3Aremote"],
        server.endpoint,
      );
      expect(result.code).toBe(1);
      expect(result.output).toBe("");
      expect(JSON.parse(result.errors)).toMatchObject({
        error: { code: "INVALID_ARGUMENT", message: "Remote Hosts support thread read only" },
      });
      expect(exporter).not.toHaveBeenCalled();
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await server.close();
      registry.close();
    }
  });

  it.each(["../escape", "..", "bad\\name", ""])(
    "rejects invalid Thread id %j",
    async (threadId) => {
      await expect(
        exportDelegationThread({ threadId }, source, { CODEXHOST_DATA_DIR: directory }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(await readdir(directory)).toEqual([]);
    },
  );

  it("reports unsupported registrations", async () => {
    const registry = new DelegationControlRegistry();
    const api = registration(directory);
    delete api.exportThread;
    registry.register(api);
    try {
      await expect(registry.exportThread({ threadId: "thread-1" })).rejects.toMatchObject({
        code: "UNSUPPORTED",
      });
    } finally {
      registry.close();
    }
  });

  it("keeps the debugging help to the requested short description", () => {
    const help = delegationCliHelp(["thread", "export", "--help"]);
    expect(help).toContain(
      "codexhost thread export <thread> [--out <path>] [--format json|compact|text]\nRarely needed: debugging only. Exports the full Thread to a JSON file and returns its path.\n\n",
    );
    expect(delegationCliHelp(["delegate", "--help"])).toContain(
      "codexhost thread export <thread> (rarely needed)\n",
    );
  });
});
