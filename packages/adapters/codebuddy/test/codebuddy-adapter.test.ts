import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { spawn as nodeSpawn } from "node:child_process";

import { hostTurnIdSchema } from "@codexhost/shared-contracts";

import { CodeBuddyAdapter } from "../src/codebuddy-adapter.js";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  #closed = false;

  constructor() {
    super();
    this.stdin.setEncoding("utf-8");
  }

  kill(): boolean {
    if (this.#closed) return false;
    this.emit("close", null, "SIGTERM");
    return true;
  }

  emitFrame(frame: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    this.#closed = true;
    this.emit("close", code, signal);
  }
}

function makeAdapter(childRef: { current: FakeChild | null }) {
  const spawnCalls: Array<{ command: string; args: string[] }> = [];
  const spawn = vi.fn((command: string, args: string[]) => {
    spawnCalls.push({ command, args });
    const child = new FakeChild();
    childRef.current = child;
    return child;
  });
  const adapter = new CodeBuddyAdapter({
    command: "codebuddy-fake",
    environment: { PATH: "/usr/bin" },
    spawn: spawn as unknown as typeof nodeSpawn,
  });
  return { adapter, spawnCalls, childRef };
}

async function collectOutputs(session: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  const iterator = session[Symbol.asyncIterator]();
  void (async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }
  })();
  // Give the iteration loop a tick to start before events are emitted.
  await new Promise((resolve) => setTimeout(resolve, 10));
  return events;
}

function eventType(event: unknown): string | undefined {
  return (event as { event?: { type?: string } }).event?.type;
}

describe("CodeBuddyAdapter.open", () => {
  it("rejects fork as unsupported", async () => {
    const { adapter } = makeAdapter({ current: null });
    const result = await adapter.open({
      kind: "fork",
      sourceRef: { harnessId: "codebuddy", nativeSessionId: "s-1", formatVersion: 1 } as never,
      checkpoint: {
        harnessId: "codebuddy",
        nativeSessionId: "s-1",
        nativeTurnKey: "t-1",
        formatVersion: 1,
      } as never,
      cwd: "/tmp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unsupported");
  });

  it("rejects unknown permission modes on create", async () => {
    const { adapter } = makeAdapter({ current: null });
    const result = await adapter.open({
      kind: "create",
      cwd: "/tmp",
      permissionModeId: "nonexistent" as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalidRequest");
  });

  it("rejects resume when the native ref belongs to another harness", async () => {
    const { adapter } = makeAdapter({ current: null });
    const result = await adapter.open({
      kind: "resume",
      nativeRef: { harnessId: "pi", nativeSessionId: "s-1", formatVersion: 1 } as never,
      cwd: "/tmp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("sessionNotFound");
  });
});

describe("CodeBuddySession turn lifecycle", () => {
  it("streams a scripted turn end-to-end and reports usage", async () => {
    const childRef: { current: FakeChild | null } = { current: null };
    const { adapter, spawnCalls } = makeAdapter(childRef);
    const opened = await adapter.open({ kind: "create", cwd: "/tmp/demo" });
    if (!opened.ok) throw new Error("open failed");
    const session = opened.value;

    const outputsPromise = collectOutputs(session.outputs);

    const accepted = await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-1"),
      input: [{ type: "text", text: "hi" }],
    });
    expect(accepted.ok).toBe(true);

    const child = childRef.current;
    if (!child) throw new Error("child was not spawned");
    child.emitFrame({ type: "system", subtype: "init", session_id: "s-9", model: "gpt-5.6-sol" });
    child.emitFrame({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
    });
    child.emitFrame({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
    });
    child.emitFrame({
      type: "result",
      subtype: "success",
      result: "Hello",
      session_id: "s-9",
      is_error: false,
      total_cost_usd: 0.01,
      usage: { input_tokens: 5, output_tokens: 2 },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const events = await outputsPromise;
    const types = events.map(eventType);
    expect(types).toContain("session.state.changed");
    expect(types).toContain("turn.started");
    expect(types).toContain("item.started");
    expect(types).toContain("item.updated");
    expect(types).toContain("item.completed");
    expect(types).toContain("session.usage.changed");
    expect(types).toContain("turn.completed");

    const completed = events.find((event) => eventType(event) === "turn.completed") as {
      event?: { outcome?: { status: string } };
    };
    expect(completed?.event?.outcome?.status).toBe("succeeded");

    const usage = events.find((event) => eventType(event) === "session.usage.changed") as {
      event?: { usage?: { inputTokens: number; totalCostUsd: number } };
    };
    expect(usage?.event?.usage?.inputTokens).toBe(5);
    expect(usage?.event?.usage?.totalCostUsd).toBe(0.01);

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.args).not.toContain("--resume");
    await session.close();
  }, 15_000);

  it("maps unattended-full-access execution policy to bypassPermissions", async () => {
    const childRef: { current: FakeChild | null } = { current: null };
    const { adapter, spawnCalls } = makeAdapter(childRef);
    const opened = await adapter.open({
      kind: "create",
      cwd: "/tmp/demo",
      executionPolicy: "unattended-full-access",
    });
    if (!opened.ok) throw new Error("open failed");
    const session = opened.value;
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-1"),
      input: [{ type: "text", text: "hi" }],
    });
    const modeIndex = spawnCalls[0]?.args.indexOf("--permission-mode") ?? -1;
    expect(modeIndex).toBeGreaterThan(-1);
    expect(spawnCalls[0]?.args[modeIndex + 1]).toBe("bypassPermissions");
    await session.close();
  }, 15_000);

  it("rejects a second turn while one is active", async () => {
    const childRef: { current: FakeChild | null } = { current: null };
    const { adapter } = makeAdapter(childRef);
    const opened = await adapter.open({ kind: "create", cwd: "/tmp/demo" });
    if (!opened.ok) throw new Error("open failed");
    const session = opened.value;
    const first = await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-1"),
      input: [{ type: "text", text: "hi" }],
    });
    expect(first.ok).toBe(true);
    const second = await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-2"),
      input: [{ type: "text", text: "again" }],
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("sessionBusy");
    await session.close();
  }, 15_000);

  it("cancels the active turn by killing the child process", async () => {
    const childRef: { current: FakeChild | null } = { current: null };
    const { adapter } = makeAdapter(childRef);
    const opened = await adapter.open({ kind: "create", cwd: "/tmp/demo" });
    if (!opened.ok) throw new Error("open failed");
    const session = opened.value;
    const outputsPromise = collectOutputs(session.outputs);
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-1"),
      input: [{ type: "text", text: "hi" }],
    });
    const cancelled = await session.execute({
      type: "turn.cancel",
      turnId: hostTurnIdSchema.parse("turn-1"),
    });
    expect(cancelled.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const events = await outputsPromise;
    const completed = events.find((event) => eventType(event) === "turn.completed") as {
      event?: { outcome?: { status: string } };
    };
    expect(completed?.event?.outcome?.status).toBe("cancelled");
    await session.close();
  }, 15_000);

  it("marks the turn as failed when the CLI exits mid-turn", async () => {
    const childRef: { current: FakeChild | null } = { current: null };
    const { adapter } = makeAdapter(childRef);
    const opened = await adapter.open({ kind: "create", cwd: "/tmp/demo" });
    if (!opened.ok) throw new Error("open failed");
    const session = opened.value;
    const outputsPromise = collectOutputs(session.outputs);
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-1"),
      input: [{ type: "text", text: "hi" }],
    });
    childRef.current?.close(1, null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const events = await outputsPromise;
    const completed = events.find((event) => eventType(event) === "turn.completed") as {
      event?: { outcome?: { status: string; error?: { code: string } } };
    };
    expect(completed?.event?.outcome?.status).toBe("failed");
    expect(completed?.event?.outcome?.error?.code).toBe("processExited");
    await session.close();
  }, 15_000);
});
