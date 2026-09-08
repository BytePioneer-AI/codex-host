import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HarnessOutput } from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessPermissionModeIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";

import type {
  HermesAcpTransport,
  HermesOpenResult,
  HermesTransportEvent,
} from "../src/acp-transport.js";
import { HermesTransportError } from "../src/acp-transport.js";
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

async function countingHermesExecutable(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-adapter-warm-test-"));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, "fake-hermes");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import readline from "node:readline";
appendFileSync(process.env.FAKE_HERMES_STARTS, "started\\n");
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
    result = { sessionId: "fake-session-" + process.pid };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
}
`,
  );
  await chmod(executable, 0o755);
  return executable;
}

async function modelSelectionHermesExecutable(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-adapter-model-counter-"));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, "fake-hermes");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
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
        availableModels: [{ modelId: "zai:glm-5-turbo", name: "GLM 5 Turbo" }],
        currentModelId: "zai:glm-5-turbo",
      },
    };
  } else if (request.method === "session/set_model") {
    appendFileSync(process.env.FAKE_HERMES_MODEL_CALLS, request.params.modelId + "\\n");
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
}
`,
  );
  await chmod(executable, 0o755);
  return executable;
}

async function permissionModeHermesExecutable(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-adapter-mode-counter-"));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, "fake-hermes");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
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
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "accept_edits", name: "Accept edits" },
        ],
      },
    };
  } else if (request.method === "session/set_mode") {
    appendFileSync(process.env.FAKE_HERMES_MODE_CALLS, request.params.modeId + "\\n");
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
}
`,
  );
  await chmod(executable, 0o755);
  return executable;
}

async function failingModelSelectionHermesExecutable(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-adapter-model-error-"));
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
        availableModels: [{ modelId: "zai:glm-5-turbo", name: "GLM 5 Turbo" }],
        currentModelId: "zai:glm-5-turbo",
      },
    };
  } else if (request.method === "session/set_model") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32603,
        message: "Internal error",
        data: { details: "No LLM provider configured for provider=openrouter" },
      },
    }) + "\\n");
    continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
}
`,
  );
  await chmod(executable, 0o755);
  return executable;
}

async function delayedHermesExecutable(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-adapter-delayed-"));
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
    await new Promise((resolve) => setTimeout(resolve, 100));
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
      result: { sessionId: "late-session" },
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

  it("surfaces actionable ACP details when create-time Model selection fails", async () => {
    const command = await failingModelSelectionHermesExecutable();
    const adapter = new HermesAdapter({ command });
    const requested = encodeHermesModelRef("openrouter:test-model");
    if (!requested) throw new Error("Expected a valid Hermes Model Ref");

    const opened = await adapter.open({ kind: "create", cwd: process.cwd(), model: requested });

    expect(opened).toMatchObject({
      ok: false,
      error: {
        code: "authenticationRequired",
        message: "No LLM provider configured for provider=openrouter",
      },
    });
    await adapter.close();
  });

  it("applies the requested permission mode while creating the native Session", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-adapter-mode-calls-"));
    temporaryDirectories.push(directory);
    const counterPath = path.join(directory, "mode-calls.log");
    const command = await permissionModeHermesExecutable();
    const adapter = new HermesAdapter({
      command,
      environment: { ...process.env, FAKE_HERMES_MODE_CALLS: counterPath },
    });
    const requestedMode = harnessPermissionModeIdSchema.parse("accept_edits");

    const opened = await adapter.open({
      kind: "create",
      cwd: process.cwd(),
      permissionModeId: requestedMode,
    });

    expect(opened.ok).toBe(true);
    expect(await readFile(counterPath, "utf8")).toBe("accept_edits\n");
    if (opened.ok) {
      expect(opened.value.initialState.effectivePermissionModeId).toBe(requestedMode);
      await opened.value.close();
    }
    await adapter.close();
  });

  it("prewarms the next ACP process after opening a Session", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-adapter-warm-counter-"));
    temporaryDirectories.push(directory);
    const counterPath = path.join(directory, "starts.log");
    const command = await countingHermesExecutable();
    const adapter = new HermesAdapter({
      command,
      environment: { ...process.env, FAKE_HERMES_STARTS: counterPath },
    });

    const first = await adapter.open({ kind: "create", cwd: process.cwd() });
    expect(first.ok).toBe(true);
    await vi.waitFor(
      async () => {
        const starts = await readFile(counterPath, "utf8");
        expect(starts.trim().split("\n")).toHaveLength(2);
      },
      { timeout: 1_000 },
    );

    const second = await adapter.open({ kind: "create", cwd: process.cwd() });
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value.initialState.nativeRef?.nativeSessionId).not.toBe(
        first.value.initialState.nativeRef?.nativeSessionId,
      );
    }
    await vi.waitFor(async () => {
      const starts = await readFile(counterPath, "utf8");
      expect(starts.trim().split("\n")).toHaveLength(3);
    });

    if (first.ok) await first.value.close();
    if (second.ok) await second.value.close();
    await adapter.close();
  });

  it("does not rebuild the Hermes Agent when the requested model is already active", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-adapter-model-calls-"));
    temporaryDirectories.push(directory);
    const counterPath = path.join(directory, "model-calls.log");
    const command = await modelSelectionHermesExecutable();
    const adapter = new HermesAdapter({
      command,
      environment: { ...process.env, FAKE_HERMES_MODEL_CALLS: counterPath },
    });
    const requested = encodeHermesModelRef("zai:glm-5-turbo");
    if (!requested) throw new Error("Expected a valid Hermes Model Ref");

    const opened = await adapter.open({ kind: "create", cwd: process.cwd(), model: requested });

    expect(opened.ok).toBe(true);
    expect(await readFile(counterPath, "utf8").catch(() => "")).toBe("");
    if (opened.ok) await opened.value.close();
    await adapter.close();
  });

  it("does not return a Session when the Adapter closes during open", async () => {
    const command = await delayedHermesExecutable();
    const adapter = new HermesAdapter({ command });

    const opening = adapter.open({ kind: "create", cwd: process.cwd() });
    await adapter.close();
    const opened = await opening;

    expect(opened).toMatchObject({ ok: false, error: { code: "invalidState" } });
  });
});

describe("HermesSession recovery", () => {
  it("reuses known native Turn refs when replaying the same history", async () => {
    const knownTurnRef = nativeTurnRefSchema.parse({
      harnessId: "hermes",
      nativeSessionId: "native-session-1",
      nativeTurnKey: "stable-native-turn-1",
      formatVersion: 1,
    });
    const session = new HermesSession({
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "hermes",
        nativeSessionId: "native-session-1",
        formatVersion: 1,
      }),
      transport: new FakeTurnTransport() as unknown as HermesAcpTransport,
      open: {
        ...openResult(),
        replay: [
          { type: "user.text", text: "hello" },
          { type: "agent.text", text: "world" },
        ],
      },
      knownTurnRefs: [knownTurnRef],
      onSettle: () => undefined,
    });

    const snapshot = await session.readSnapshot();
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) expect(snapshot.value.turns[0]?.nativeTurnRef).toEqual(knownTurnRef);
    await session.close();
  });
});

describe("HermesSession cancellation", () => {
  it("reports cancellation failure instead of claiming it was requested", async () => {
    let rejectTurn: ((error: Error) => void) | undefined;
    const transport = {
      onFault: () => undefined,
      runTurn: () =>
        new Promise<never>((_resolve, reject) => {
          rejectTurn = reject;
        }),
      cancel: async () => {
        throw new Error("cancel RPC failed");
      },
      close: async () => undefined,
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
    } as unknown as HermesAcpTransport;
    const session = new HermesSession({
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "hermes",
        nativeSessionId: "native-session-1",
        formatVersion: 1,
      }),
      transport,
      open: openResult(),
      onSettle: () => undefined,
    });
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-cancel"),
      input: [{ type: "text", text: "go" }],
    });

    const cancelled = await session.execute({
      type: "turn.cancel",
      turnId: hostTurnIdSchema.parse("turn-cancel"),
    });

    expect(cancelled).toMatchObject({ ok: false, error: { message: "cancel RPC failed" } });
    rejectTurn?.(new Error("cancelled by test"));
    await session.close();
  });
});

describe("HermesSession live configuration errors", () => {
  it("preserves authentication details from Model selection", async () => {
    const transport = new FakeTurnTransport();
    transport.setModel = async () => {
      throw new HermesTransportError(
        "authenticationRequired",
        "No LLM provider configured for provider=openrouter",
      );
    };
    const session = new HermesSession({
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "hermes",
        nativeSessionId: "native-session-1",
        formatVersion: 1,
      }),
      transport: transport as unknown as HermesAcpTransport,
      open: openResult(),
      onSettle: () => undefined,
    });
    const model = encodeHermesModelRef("openrouter:test-model");
    if (!model) throw new Error("Expected a valid Hermes Model Ref");

    const selected = await session.execute({ type: "model.select", model });

    expect(selected).toMatchObject({
      ok: false,
      error: {
        code: "authenticationRequired",
        message: "No LLM provider configured for provider=openrouter",
      },
    });
    await session.close();
  });
});
