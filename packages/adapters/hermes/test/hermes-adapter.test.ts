import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { HarnessOutput } from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";

import type {
  HermesAcpTransport,
  HermesOpenResult,
  HermesTransportEvent,
} from "../src/acp-transport.js";
import { HermesAdapter } from "../src/hermes-adapter.js";
import { encodeHermesModelRef } from "../src/hermes-models.js";
import { HermesSession } from "../src/hermes-session.js";

class FakeTurnTransport {
  onFault = () => undefined;

  async runTurn(
    _text: string,
    onEvent: (event: HermesTransportEvent) => void,
  ): Promise<{ stopReason: "end_turn" }> {
    onEvent({ type: "agent.thought", text: "think " });
    onEvent({ type: "agent.thought", text: "carefully" });
    onEvent({ type: "agent.text", text: "hello " });
    onEvent({ type: "agent.text", text: "world" });
    return { stopReason: "end_turn" };
  }

  async close(): Promise<void> {}
  async cancel(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function openResult(): HermesOpenResult {
  return {
    initialize: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    },
    session: {
      sessionId: "native-session-1",
      models: null,
      modes: null,
    },
    sessionId: "native-session-1",
    replay: [],
  };
}

async function collectUntilTurnCompleted(
  outputs: AsyncIterable<HarnessOutput>,
): Promise<HarnessOutput[]> {
  const collected: HarnessOutput[] = [];
  for await (const output of outputs) {
    collected.push(output);
    if (output.kind === "event" && output.event.type === "turn.completed") return collected;
  }
  throw new Error("Hermes output ended before turn.completed");
}

async function fakeHermesExecutable(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-adapter-test-"));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, "fake-hermes");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  let result = {};
  if (request.method === "initialize") {
    result = {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: "fake-hermes", version: "1.0.0" },
      authMethods: [],
    };
  } else if (request.method === "session/new") {
    result = {
      sessionId: "fake-session",
      models: {
        availableModels: [
          { modelId: "zai:glm-5-turbo", name: "GLM 5 Turbo" },
          { modelId: "minimax-oauth:MiniMax-M3", name: "MiniMax M3" },
        ],
        currentModelId: "zai:glm-5-turbo",
      },
    };
  } else if (request.method === "session/set_model") {
    result = {};
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
}
`,
  );
  await chmod(executable, 0o755);
  return executable;
}

async function failingHermesExecutable(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-adapter-error-test-"));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, "fake-hermes");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: "fake-hermes", version: "1.0.0" },
        authMethods: [],
      },
    }) + "\\n");
  } else if (request.method === "session/new") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32603,
        message: "Internal error",
        data: { details: "Hermes provider is not configured" },
      },
    }) + "\\n");
  }
}
`,
  );
  await chmod(executable, 0o755);
  return executable;
}

describe("HermesSession text projection", () => {
  it("completes streamed text with exactly the text sent through append updates", async () => {
    const session = new HermesSession({
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: harnessIdSchema.parse("hermes"),
        nativeSessionId: "native-session-1",
        formatVersion: 1,
      }),
      transport: new FakeTurnTransport() as unknown as HermesAcpTransport,
      open: openResult(),
      onSettle: () => undefined,
    });

    const outputsPromise = collectUntilTurnCompleted(session.outputs);
    const started = await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-1"),
      input: [{ type: "text", text: "go" }],
    });
    expect(started.ok).toBe(true);

    const outputs = await outputsPromise;
    const events = outputs.flatMap((output) => (output.kind === "event" ? [output.event] : []));
    const starts = events.filter((event) => event.type === "item.started");
    const completions = events.filter((event) => event.type === "item.completed");

    expect(
      starts.map((event) => (event.type === "item.started" ? event.item : null)),
    ).toMatchObject([
      { type: "reasoning", text: "" },
      { type: "agentMessage", text: "" },
    ]);
    expect(
      completions.map((event) => (event.type === "item.completed" ? event.snapshot.item : null)),
    ).toMatchObject([
      { type: "reasoning", text: "think carefully" },
      { type: "agentMessage", text: "hello world" },
    ]);

    await session.close();
  });
});

describe("HermesAdapter model selection", () => {
  it("applies the requested model while creating the native Session", async () => {
    const command = await fakeHermesExecutable();
    const adapter = new HermesAdapter({ command });
    const requested = encodeHermesModelRef("minimax-oauth:MiniMax-M3");
    expect(requested).not.toBeNull();
    if (!requested) throw new Error("Expected a valid Hermes Model Ref");

    const opened = await adapter.open({
      kind: "create",
      cwd: process.cwd(),
      model: requested,
    });

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.initialState.effectiveModel).toEqual(requested);
    expect(opened.value.initialState.resolvedModelLabel).toBe("MiniMax M3");

    await opened.value.close();
    await adapter.close();
  });

  it("surfaces the actionable ACP error details when Session creation fails", async () => {
    const command = await failingHermesExecutable();
    const adapter = new HermesAdapter({ command });

    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });

    expect(opened).toMatchObject({
      ok: false,
      error: {
        code: "authenticationRequired",
        message: "Hermes provider is not configured",
      },
    });
    await adapter.close();
  });
});
