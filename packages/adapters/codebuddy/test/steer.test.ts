import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { CodeBuddyAdapter } from "../src/codebuddy-adapter.js";
import type { CodeBuddyClient, CodeBuddyClientFactory } from "../src/acp-client.js";
import { CodeBuddyError } from "../src/common.js";
import { configOptions } from "./fixtures.js";
import {
  codeBuddySupportsSteer,
  codeBuddyVersionProbeArguments,
  parseCodeBuddyProductVersion,
  probeCodeBuddyProductVersion,
} from "../src/steer.js";

class SteerClient implements CodeBuddyClient {
  readonly calls: { sessionId: string; text: string }[] = [];
  steered = true;
  reason: string | undefined;
  /** Extra user rows written when a steer is accepted. `0` leaves history unchanged. */
  persistedSteers = 1;
  readonly history: Record<string, unknown>[] = [];
  #pending: { resolve(value: Record<string, unknown>): void; id: string } | undefined;
  constructor(
    readonly nativeVersion: string | null,
    readonly context: Parameters<CodeBuddyClientFactory>[0],
  ) {}
  async initialize() {
    return { protocolVersion: 1 };
  }
  async open(_cwd: string, sessionId?: string) {
    return { sessionId: sessionId ?? "native-session", configOptions: configOptions() };
  }
  async configure() {
    return { configOptions: configOptions() };
  }
  async prompt(_sessionId: string, input: string) {
    const id = "user-original";
    this.history.push(userRow(id, undefined, input));
    return new Promise<Record<string, unknown>>((resolve) => {
      this.#pending = { resolve, id };
    });
  }
  finish() {
    const id = this.#pending?.id ?? "user-original";
    const parentId = textId(this.history.at(-1)?.id) || id;
    this.history.push({
      id: `assistant-${id}`,
      parentId,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "done" }],
    });
    this.#pending?.resolve({
      stopReason: "end_turn",
      userMessageId: id,
      _meta: { "codebuddy.ai/outcome": "SUCCESS" },
    });
    this.#pending = undefined;
  }
  async cancel() {}
  async answer() {}
  async close() {
    this.#pending?.resolve({ stopReason: "cancelled", userMessageId: this.#pending.id });
    this.#pending = undefined;
  }
  update(update: unknown) {
    this.context.handlers.update({
      sessionId: "native-session",
      update,
    } as SessionNotification);
  }
  async steer(sessionId: string, text: string) {
    this.calls.push({ sessionId, text });
    this.update({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text },
    });
    if (this.steered)
      for (let index = 0; index < this.persistedSteers; index += 1) {
        const parentId = textId(this.history.at(-1)?.id);
        this.history.push(userRow(`user-steer-${this.calls.length}-${index}`, parentId, text));
      }
    return { steered: this.steered, ...(this.reason ? { reason: this.reason } : {}) };
  }
}

function userRow(id: string, parentId: string | undefined, text: string) {
  return {
    type: "message",
    role: "user",
    id,
    ...(parentId ? { parentId } : {}),
    content: [{ type: "input_text", text }],
  };
}

function textId(value: unknown) {
  return typeof value === "string" ? value : "";
}

function adapterFor(version: string | null) {
  let sessionClient: SteerClient | undefined;
  const adapter = new CodeBuddyAdapter({
    clientFactory: (options) => {
      const created = new SteerClient(version, options);
      sessionClient ??= created;
      return created;
    },
    readHistory: async () => {
      const rows = sessionClient?.history ?? [];
      if (!rows.length) throw new CodeBuddyError("sessionNotFound", "Missing fixture history");
      return rows.map((row) => JSON.stringify(row)).join("\n");
    },
  });
  return {
    adapter,
    client: () => {
      if (!sessionClient) throw new Error("client was not created");
      return sessionClient;
    },
  };
}

async function open(version: string | null) {
  const { adapter, client } = adapterFor(version);
  const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
  if (!opened.ok) throw new Error(opened.error.message);
  return { adapter, session: opened.value, client: client() };
}

async function outputsUntil(session: { outputs: AsyncIterable<HarnessOutput> }, count: number) {
  const outputs: HarnessOutput[] = [];
  for await (const output of session.outputs) {
    outputs.push(output);
    const completed = outputs.filter(
      (item) => item.kind === "event" && item.event.type === "turn.completed",
    );
    if (completed.length >= count) break;
  }
  return outputs;
}

describe("CodeBuddy steer version gate", () => {
  it("accepts an unprefixed product version at the acceptance-receipt threshold", () => {
    expect(parseCodeBuddyProductVersion("2.157.0\n")).toBe("2.157.0");
    expect(parseCodeBuddyProductVersion("v22.14.0")).toBeNull();
    expect(parseCodeBuddyProductVersion("v28.0.0")).toBeNull();
    expect(codeBuddySupportsSteer("2.134.0")).toBe(false);
    expect(codeBuddySupportsSteer("2.143.0")).toBe(false);
    expect(codeBuddySupportsSteer("2.143.1")).toBe(true);
    expect(codeBuddySupportsSteer(null)).toBe(false);
    expect(codeBuddyVersionProbeArguments(["--acp", "--no-session-persistence"])).toEqual([
      "--version",
    ]);
    expect(codeBuddyVersionProbeArguments(["/cli/bin/codebuddy", "--acp"])).toEqual([
      "/cli/bin/codebuddy",
      "--version",
    ]);
    expect(codeBuddyVersionProbeArguments(["fixtures/acp.mjs", "normal"])).toBeNull();
  });

  it("probes only ACP invocations and ignores a leading v", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codebuddy-steer-"));
    try {
      const script = path.join(dir, "codebuddy.js");
      await writeFile(script, "console.log('2.157.0')\n");
      await expect(
        probeCodeBuddyProductVersion(process.execPath, [script, "--acp"], process.env, dir),
      ).resolves.toBe("2.157.0");
      await writeFile(script, "console.log('v28.0.0')\n");
      await expect(
        probeCodeBuddyProductVersion(process.execPath, [script, "--acp"], process.env, dir),
      ).resolves.toBeNull();
      await expect(
        probeCodeBuddyProductVersion(process.execPath, [script], process.env, dir),
      ).resolves.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("CodeBuddy session steer", () => {
  it("declares steer from 2.143.1 and calls session/steer without publishing userMessage", async () => {
    const { adapter, session, client } = await open("2.157.0");
    try {
      expect(session.capabilities.steer).toBe(true);
      const inspected = await adapter.inspect({ cwd: process.cwd() });
      expect(inspected.status === "ready" && inspected.capabilities.steer).toBe(true);
      const turnId = hostTurnIdSchema.parse("turn-steer");
      expect(
        await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "go" }],
        }),
      ).toMatchObject({ ok: true });
      expect(
        await session.execute({
          type: "turn.steer",
          turnId,
          input: [{ type: "text", text: "   " }],
        }),
      ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
      expect(
        await session.execute({
          type: "turn.steer",
          turnId: hostTurnIdSchema.parse("other"),
          input: [{ type: "text", text: "now" }],
        }),
      ).toMatchObject({ ok: false, error: { code: "invalidState" } });
      const seen = outputsUntil(session, 1);
      expect(
        await session.execute({
          type: "turn.steer",
          turnId,
          input: [{ type: "text", text: "now" }],
        }),
      ).toEqual({ ok: true, value: { accepted: true } });
      expect(client.calls).toEqual([{ sessionId: "native-session", text: "now" }]);
      expect(
        await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("next"),
          input: [{ type: "text", text: "again" }],
        }),
      ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
      client.finish();
      const outputs = await seen;
      expect(
        outputs.some(
          (output) =>
            output.kind === "event" &&
            "item" in output.event &&
            output.event.item.type === "userMessage",
        ),
      ).toBe(false);
      expect(outputs.at(-1)).toMatchObject({
        kind: "event",
        event: {
          type: "turn.completed",
          turnId,
          outcome: { status: "succeeded" },
          nativeTurnRef: { nativeTurnKey: "user-original" },
        },
      });
    } finally {
      await adapter.close();
    }
  });

  it("binds the original prompt when accepted steers add that many native turns", async () => {
    const { adapter, session, client } = await open("2.143.1");
    try {
      const turnId = hostTurnIdSchema.parse("turn-two");
      client.persistedSteers = 1;
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "go" }],
      });
      const seen = outputsUntil(session, 1);
      await session.execute({
        type: "turn.steer",
        turnId,
        input: [{ type: "text", text: "first" }],
      });
      await session.execute({
        type: "turn.steer",
        turnId,
        input: [{ type: "text", text: "second" }],
      });
      client.finish();
      const outputs = await seen;
      expect(outputs.at(-1)).toMatchObject({
        event: {
          type: "turn.completed",
          outcome: { status: "succeeded" },
          nativeTurnRef: { nativeTurnKey: "user-original" },
        },
      });
    } finally {
      await adapter.close();
    }
  });

  it("still rejects a native turn count that is not 1 plus the accepted steers", async () => {
    const { adapter, session, client } = await open("2.157.0");
    try {
      const turnId = hostTurnIdSchema.parse("turn-mismatch");
      client.persistedSteers = 2;
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "go" }],
      });
      const seen = outputsUntil(session, 1);
      await session.execute({
        type: "turn.steer",
        turnId,
        input: [{ type: "text", text: "now" }],
      });
      client.finish();
      expect((await seen).at(-1)).toMatchObject({
        event: {
          type: "turn.completed",
          outcome: { status: "failed", error: { code: "protocolError" } },
        },
      });
    } finally {
      await adapter.close();
    }
  });

  it("hides steer below 2.143.1 and does not call the native method", async () => {
    const blocked = await open("2.143.0");
    try {
      expect(blocked.session.capabilities.steer).toBeUndefined();
      const inspected = await blocked.adapter.inspect({ cwd: process.cwd() });
      expect(inspected.status === "ready" && inspected.capabilities.steer).toBeUndefined();
      const turnId = hostTurnIdSchema.parse("turn-blocked");
      await blocked.session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "go" }],
      });
      expect(
        await blocked.session.execute({
          type: "turn.steer",
          turnId,
          input: [{ type: "text", text: "now" }],
        }),
      ).toMatchObject({ ok: false, error: { code: "unsupported" } });
      expect(blocked.client.calls).toEqual([]);
      expect(
        await blocked.session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("busy"),
          input: [{ type: "text", text: "again" }],
        }),
      ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    } finally {
      await blocked.adapter.close();
    }
  });

  it("returns invalidState when the native reports idle or stale and does not count them", async () => {
    const { adapter, session, client } = await open("2.157.0");
    try {
      const turnId = hostTurnIdSchema.parse("turn-idle");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "go" }],
      });
      client.steered = false;
      client.reason = "idle";
      expect(
        await session.execute({
          type: "turn.steer",
          turnId,
          input: [{ type: "text", text: "now" }],
        }),
      ).toMatchObject({ ok: false, error: { code: "invalidState" } });
      client.reason = "stale";
      expect(
        await session.execute({
          type: "turn.steer",
          turnId,
          input: [{ type: "text", text: "later" }],
        }),
      ).toMatchObject({
        ok: false,
        error: { code: "invalidState", message: expect.stringContaining("different request") },
      });
      client.persistedSteers = 0;
      const seen = outputsUntil(session, 1);
      client.finish();
      expect((await seen).at(-1)).toMatchObject({
        event: {
          type: "turn.completed",
          outcome: { status: "succeeded" },
          nativeTurnRef: { nativeTurnKey: "user-original" },
        },
      });
    } finally {
      await adapter.close();
    }
  });
});
