import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  CodeBuddyStreamProcess,
  codebuddySpawnArgs,
  codebuddyUserFrame,
  initInfoFromFrame,
  parseCodeBuddyStreamFrame,
  type CodeBuddyStreamFrame,
  type SpawnDependency,
} from "../src/stream-protocol.js";

describe("codebuddySpawnArgs", () => {
  it("always requests the bidirectional stream-json print mode", () => {
    expect(codebuddySpawnArgs({})).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
    ]);
  });

  it("appends model, permission mode, and resume options when provided", () => {
    expect(
      codebuddySpawnArgs({
        model: "gpt-5.6-sol",
        permissionMode: "acceptEdits",
        resumeSessionId: "abc",
      }),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--model",
      "gpt-5.6-sol",
      "--permission-mode",
      "acceptEdits",
      "--resume",
      "abc",
    ]);
  });
});

describe("codebuddyUserFrame", () => {
  it("wraps plain text into a stream-json user frame", () => {
    const frame = JSON.parse(codebuddyUserFrame("hi")) as Record<string, unknown>;
    expect(frame).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
  });
});

describe("parseCodeBuddyStreamFrame", () => {
  it("parses JSON objects that carry a string type", () => {
    const frame = parseCodeBuddyStreamFrame('{"type":"system","subtype":"init"}');
    expect(frame).toEqual({ type: "system", subtype: "init" });
  });

  it("rejects blank lines, malformed JSON, arrays, and objects without a type", () => {
    expect(parseCodeBuddyStreamFrame("")).toBeNull();
    expect(parseCodeBuddyStreamFrame("   \n")).toBeNull();
    expect(parseCodeBuddyStreamFrame("{not json")).toBeNull();
    expect(parseCodeBuddyStreamFrame("[1,2]")).toBeNull();
    expect(parseCodeBuddyStreamFrame('{"subtype":"init"}')).toBeNull();
  });
});

describe("initInfoFromFrame", () => {
  it("extracts session identity from a system/init frame", () => {
    const info = initInfoFromFrame({
      type: "system",
      subtype: "init",
      session_id: "s-1",
      model: "gpt-5.6-sol",
      permissionMode: "default",
    });
    expect(info).toEqual({
      sessionId: "s-1",
      model: "gpt-5.6-sol",
      permissionMode: "default",
    });
  });

  it("returns null for non-init frames and init frames without a session id", () => {
    expect(initInfoFromFrame({ type: "result" })).toBeNull();
    expect(initInfoFromFrame({ type: "system", subtype: "other", session_id: "s-1" })).toBeNull();
    expect(initInfoFromFrame({ type: "system", subtype: "init" })).toBeNull();
  });
});

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  #closed = false;

  kill(signal?: NodeJS.Signals): boolean {
    if (this.#closed) return false;
    this.emit("close", signal === "SIGKILL" ? null : 0, signal ?? "SIGTERM");
    return true;
  }

  emitStdout(chunk: string): void {
    this.stdout.write(chunk);
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    this.#closed = true;
    this.emit("close", code, signal);
  }
}

function frameLine(frame: Record<string, unknown>): string {
  return `${JSON.stringify(frame)}\n`;
}

function makeProcess() {
  const child = new FakeChild();
  const frames: CodeBuddyStreamFrame[] = [];
  const exits: Array<{ code: number | null; signal: NodeJS.Signals | null; stderrTail: string }> =
    [];
  const spawn = vi.fn(() => child) as unknown as SpawnDependency;
  const process = new CodeBuddyStreamProcess(
    { cwd: "/tmp", executable: "codebuddy", args: ["-p"], environment: {}, spawn },
    {
      onFrame: (frame) => frames.push(frame),
      onExit: (exit) => exits.push(exit),
    },
  );
  return { child, frames, exits, process };
}

describe("CodeBuddyStreamProcess", () => {
  it("buffers partial lines and dispatches complete frames", () => {
    const { child, frames } = makeProcess();
    const init = frameLine({ type: "system", subtype: "init", session_id: "s-1" });
    child.emitStdout(init.slice(0, 20));
    child.emitStdout(init.slice(20));
    child.emitStdout(frameLine({ type: "result" }));
    expect(frames).toEqual([
      { type: "system", subtype: "init", session_id: "s-1" },
      { type: "result" },
    ]);
  });

  it("collects stderr into a sanitized tail and reports it on close", () => {
    const { child, exits } = makeProcess();
    child.stderr.write("boom\n");
    child.close(1, null);
    expect(exits).toHaveLength(1);
    expect(exits[0]?.code).toBe(1);
    expect(exits[0]?.stderrTail).toContain("boom");
  });

  it("reports exit exactly once even if the child closes twice", () => {
    const { child, exits } = makeProcess();
    child.close(0, null);
    child.close(0, null);
    expect(exits).toHaveLength(1);
  });

  it("writes user frames to stdin while alive and refuses after close", () => {
    const { child, process } = makeProcess();
    const written: string[] = [];
    child.stdin.on("data", (chunk: Buffer) => written.push(chunk.toString("utf-8")));
    expect(process.writeTurnInput("hi")).toBe(true);
    expect(written[0]).toContain('"type":"user"');
    child.close(0, null);
    expect(process.writeTurnInput("again")).toBe(false);
  });

  it("kill() terminates the process and is idempotent", () => {
    const { child, exits, process } = makeProcess();
    process.kill();
    process.kill();
    expect(exits).toHaveLength(1);
    expect(child.kill).toBeDefined();
  });
});
