import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { spawn, ChildProcessWithoutNullStreams } from "node:child_process";

import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "@codexhost/adapter-claude-code";
import {
  CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
  type ExternalHarnessId,
  type JsonObject,
} from "@codexhost/protocol-core";

import { AppServerHost } from "../src/index.js";

const RUN_REAL = process.env.CODEXHOST_RUN_CLAUDE_HOST_REAL === "1";
const REAL_TIMEOUT_MS = 180_000;

class OfficialProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor() {
    super();
    this.stdin.once("finish", () => {
      this.exitCode = 0;
      this.stdout.end();
      this.stderr.end();
      this.emit("exit", 0, null);
    });
  }

  kill(): boolean {
    this.exitCode = 0;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", 0, null);
    return true;
  }
}

class JsonCollector {
  readonly messages: JsonObject[] = [];
  readonly #waiters: Array<{
    predicate: (message: JsonObject) => boolean;
    resolve(message: JsonObject): void;
  }> = [];
  #buffer = "";

  constructor(stream: PassThrough) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      this.#buffer += chunk;
      for (;;) {
        const newline = this.#buffer.indexOf("\n");
        if (newline < 0) return;
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line) as JsonObject;
        this.messages.push(message);
        for (const waiter of [...this.#waiters]) {
          if (!waiter.predicate(message)) continue;
          this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    });
  }

  waitFor(predicate: (message: JsonObject) => boolean): Promise<JsonObject> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return Promise.race([
      new Promise<JsonObject>((resolve) => this.#waiters.push({ predicate, resolve })),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("Timed out waiting for real Claude Host output")),
          120_000,
        ),
      ),
    ]);
  }
}

function requestId(message: JsonObject, id: number): boolean {
  return message.id === id;
}

function method(message: JsonObject, name: string): boolean {
  return message.method === name;
}

function writeRequest(input: PassThrough, request: JsonObject): void {
  input.write(`${JSON.stringify(request)}\n`);
}

describe.skipIf(!RUN_REAL)("AppServerHost real Claude projection", () => {
  it(
    "projects one real Claude text Turn through the registered external Harness path",
    async () => {
      const workspace = path.resolve(".codexhost", "claude-host-real", "workspace");
      await fs.mkdir(workspace, { recursive: true });
      const prompt = "Reply with exactly CODEXHOST_CLAUDE_HOST_OK.";
      await fs.writeFile(path.join(workspace, "prompt.local.txt"), `${prompt}\n`, "utf8");

      const desktopInput = new PassThrough();
      const desktopOutput = new PassThrough();
      const diagnosticOutput = new PassThrough();
      const collector = new JsonCollector(desktopOutput);
      const official = new OfficialProcess();
      const claudeAdapter = new ClaudeCodeAdapter({ closeTimeoutMs: 10_000 });
      const externalAdapters = new Map<ExternalHarnessId, ClaudeCodeAdapter>([
        ["claude-code", claudeAdapter],
      ]);
      const host = new AppServerHost({
        stockCodexPath: "/synthetic/codex",
        arguments: [],
        defaultAgent: "codex",
        desktopInput,
        desktopOutput,
        diagnosticOutput,
        externalAdapters,
        spawnOfficial: (() =>
          official as unknown as ChildProcessWithoutNullStreams) as unknown as typeof spawn,
      });
      const running = host.run();

      try {
        writeRequest(desktopInput, {
          id: 1,
          method: "thread/start",
          params: { model: CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID, cwd: workspace },
        });
        const startResponse = await collector.waitFor((message) => requestId(message, 1));
        const result = startResponse.result as JsonObject;
        const thread = result.thread as JsonObject;
        expect(result.model).toBe(CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID);
        const threadId = thread.id;
        if (typeof threadId !== "string") throw new Error("Host returned no Thread ID");

        writeRequest(desktopInput, {
          id: 2,
          method: "turn/start",
          params: { threadId, input: [{ type: "text", text: prompt }] },
        });
        await collector.waitFor((message) => requestId(message, 2));
        await expect(
          collector.waitFor((message) => method(message, "item/agentMessage/delta")),
        ).resolves.toMatchObject({ params: { delta: expect.any(String) } });
        await expect(
          collector.waitFor((message) => method(message, "turn/completed")),
        ).resolves.toMatchObject({ params: { turn: { status: "completed" } } });

        const responseIndex = collector.messages.findIndex((message) => requestId(message, 2));
        const turnStartedIndex = collector.messages.findIndex((message) =>
          method(message, "turn/started"),
        );
        expect(turnStartedIndex).toBeGreaterThan(responseIndex);
      } finally {
        desktopInput.end();
        await running;
        await claudeAdapter.close();
      }
    },
    REAL_TIMEOUT_MS,
  );
});
