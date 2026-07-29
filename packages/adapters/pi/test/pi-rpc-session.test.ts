import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { PiRpcSession, type PiRpcProcessAdapter } from "../src/pi-rpc-session.js";

type Scenario = "final-only" | "empty";

class FakePiRpcProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 42_000;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  readonly #scenario: Scenario;

  constructor(scenario: Scenario) {
    super();
    this.#scenario = scenario;
    this.stdin.on("data", (chunk: Buffer) => this.#push(chunk));
    this.stdin.once("finish", () => {
      this.exitCode = 0;
      this.stdout.end();
      this.stderr.end();
      this.emit("exit", 0, null);
    });
    queueMicrotask(() => this.emit("spawn"));
  }

  #push(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    let newline = this.#buffer.indexOf(0x0a);
    while (newline >= 0) {
      const frame = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (frame.length > 0) this.#handle(JSON.parse(frame.toString("utf8")) as unknown);
      newline = this.#buffer.indexOf(0x0a);
    }
  }

  #handle(value: unknown): void {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const command = value as Record<string, unknown>;
    if (typeof command.id !== "string" || typeof command.type !== "string") return;
    if (command.type === "get_state") {
      this.#output({
        id: command.id,
        type: "response",
        command: command.type,
        success: true,
        data: {
          sessionId: "synthetic-session",
          sessionFile: null,
          model: { provider: "synthetic-provider", id: "synthetic-model" },
        },
      });
      return;
    }
    this.#output({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
    });
    if (command.type !== "prompt") return;
    if (this.#scenario === "final-only") {
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "synthetic final text" }],
      };
      this.#output({ type: "message_start", message });
      this.#output({ type: "message_end", message });
    }
    this.#output({ type: "agent_settled" });
  }

  #output(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }
}

function session(scenario: Scenario): PiRpcSession {
  const processAdapter: PiRpcProcessAdapter = {
    spawn() {
      return new FakePiRpcProcess(scenario) as unknown as ChildProcessWithoutNullStreams;
    },
  };
  return new PiRpcSession(
    {
      cwd: process.cwd(),
      commandTimeoutMs: 2_000,
      turnTimeoutMs: 2_000,
      closeTimeoutMs: 500,
    },
    processAdapter,
  );
}

describe("Pi RPC text aggregation", () => {
  it("recovers final assistant text when no streaming delta was emitted", async () => {
    const rpc = session("final-only");
    const deltas: string[] = [];
    await rpc.start();

    await expect(rpc.runTextTurn("synthetic", (delta) => deltas.push(delta))).resolves.toEqual({
      text: "synthetic final text",
    });
    expect(deltas).toEqual(["synthetic final text"]);
    await rpc.close();
  });

  it("rejects a settled Turn that has no displayable text", async () => {
    const rpc = session("empty");
    await rpc.start();

    await expect(rpc.runTextTurn("synthetic", () => undefined)).rejects.toThrow(
      "settled without text output",
    );
    await rpc.close();
  });
});
