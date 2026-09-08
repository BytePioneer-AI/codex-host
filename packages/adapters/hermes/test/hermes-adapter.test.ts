import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

import type { HermesOpenResult, HermesTransportEvent } from "../src/acp-transport.js";
import { HermesAcpTransport, HermesTransportError } from "../src/acp-transport.js";
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

async function exitingWarmHermesExecutable(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-adapter-exiting-warm-test-"));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, "fake-hermes");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import readline from "node:readline";
const starts = readFileSync(process.env.FAKE_HERMES_STARTS, "utf8").trim().split("\\n").filter(Boolean).length + 1;
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
  if (request.method === "initialize" && starts === 2) setTimeout(() => process.exit(0), 25);
}
`,
  );
  await chmod(executable, 0o755);
  return executable;
}

async function environmentAwareHermesExecutable(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-adapter-environment-test-"));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, "fake-hermes");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import readline from "node:readline";
if (process.env.FAKE_HERMES_STARTS) appendFileSync(process.env.FAKE_HERMES_STARTS, "started\\n");
const identityVar = process.env.FAKE_HERMES_IDENTITY_VAR || "CODEXHOST_THREAD_ID";
const identity = process.env[identityVar] || "missing";
appendFileSync(process.env.FAKE_HERMES_ENVIRONMENTS, identity + "\\n");
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
    result = { sessionId: "fake-session-" + identity };
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

async function cwdAwareHermesExecutable(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-adapter-cwd-aware-"));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, "fake-hermes");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import readline from "node:readline";
if (process.env.FAKE_HERMES_STARTS) appendFileSync(process.env.FAKE_HERMES_STARTS, "started\\n");
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
    appendFileSync(process.env.FAKE_HERMES_SESSIONS, request.params.cwd + "\\n");
    result = { sessionId: "fake-session-" + Math.random().toString(36).slice(2) };
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

  it("keeps streamed text items ordered around a tool call", async () => {
    const transport = {
      onFault: () => undefined,
      runTurn: async (
        _text: string,
        onEvent: (event: HermesTransportEvent) => void,
      ): Promise<{ stopReason: "end_turn" }> => {
        onEvent({ type: "agent.text", text: "before" });
        onEvent({
          type: "tool.call",
          toolCallId: "tool-between-text",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-between-text",
            title: "Run command",
            status: "completed",
          },
        } as HermesTransportEvent);
        onEvent({ type: "agent.text", text: "after" });
        return { stopReason: "end_turn" };
      },
      close: async () => undefined,
      cancel: async () => undefined,
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

    const outputsPromise = collectUntilTurnCompleted(session.outputs);
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-text-tool-text"),
      input: [{ type: "text", text: "go" }],
    });
    const outputs = await outputsPromise;
    const completedTypes = outputs.flatMap((output) =>
      output.kind === "event" && output.event.type === "item.completed"
        ? [output.event.snapshot.item.type]
        : [],
    );
    expect(completedTypes).toEqual(["agentMessage", "toolExecution", "agentMessage"]);

    const snapshot = await session.readSnapshot();
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.value.turns[0]?.items.map(({ item }) => item.type)).toEqual([
        "agentMessage",
        "toolExecution",
        "agentMessage",
      ]);
      expect(snapshot.value.turns[0]?.items[0]?.item).toMatchObject({ text: "before" });
      expect(snapshot.value.turns[0]?.items[2]?.item).toMatchObject({ text: "after" });
    }
    await session.close();
  });

  it("merges terminal token totals with the latest context usage", async () => {
    const transport = {
      onFault: () => undefined,
      runTurn: async (_text: string, onEvent: (event: HermesTransportEvent) => void) => {
        onEvent({ type: "usage", used: 120, size: 1_000 });
        return {
          stopReason: "end_turn" as const,
          usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120 },
        };
      },
      close: async () => undefined,
      cancel: async () => undefined,
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

    const outputsPromise = collectUntilTurnCompleted(session.outputs);
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-merged-usage"),
      input: [{ type: "text", text: "go" }],
    });
    const outputs = await outputsPromise;
    const usages = outputs.flatMap((output) =>
      output.kind === "event" && output.event.type === "session.usage.changed"
        ? [output.event.usage]
        : [],
    );
    expect(usages.at(-1)).toEqual({
      contextUsedTokens: 120,
      contextWindowTokens: 1_000,
      inputTokens: 80,
      outputTokens: 40,
      totalTokens: 120,
    });
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

  it("maps unattended execution onto Hermes dont_ask mode", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-adapter-unattended-"));
    temporaryDirectories.push(directory);
    const counterPath = path.join(directory, "mode-calls.log");
    const command = await permissionModeHermesExecutable();
    const adapter = new HermesAdapter({
      command,
      environment: { ...process.env, FAKE_HERMES_MODE_CALLS: counterPath },
    });

    const opened = await adapter.open({
      kind: "create",
      cwd: process.cwd(),
      executionPolicy: "unattended-full-access",
    });

    expect(opened.ok).toBe(true);
    expect(await readFile(counterPath, "utf8")).toBe("dont_ask\n");
    if (opened.ok) {
      expect(opened.value.initialState.effectivePermissionModeId).toBe("dont_ask");
      await opened.value.close();
    }
    await adapter.close();
  });

  it("rejects a permission mode that conflicts with unattended execution", async () => {
    const command = await permissionModeHermesExecutable();
    const adapter = new HermesAdapter({ command });

    const opened = await adapter.open({
      kind: "create",
      cwd: process.cwd(),
      executionPolicy: "unattended-full-access",
      permissionModeId: harnessPermissionModeIdSchema.parse("accept_edits"),
    });

    expect(opened).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    await adapter.close();
  });

  it("does not forward Host Thread identity to the Hermes process", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-adapter-thread-id-forward-"));
    temporaryDirectories.push(directory);
    const environmentsPath = path.join(directory, "environments.log");
    const command = await environmentAwareHermesExecutable();
    const adapter = new HermesAdapter({
      command,
      environment: { ...process.env, FAKE_HERMES_ENVIRONMENTS: environmentsPath },
    });

    try {
      const opened = await adapter.open({
        kind: "create",
        cwd: process.cwd(),
        environment: { CODEXHOST_THREAD_ID: "thread-should-not-forward" },
      });
      expect(opened.ok).toBe(true);
      if (opened.ok) await opened.value.close();

      await vi.waitFor(async () => {
        const environments = (await readFile(environmentsPath, "utf8")).trim().split("\n");
        // "missing" = the Hermes process never saw CODEXHOST_THREAD_ID.
        expect(environments.length).toBeGreaterThan(0);
        expect(environments).toContain("missing");
        expect(environments).not.toContain("thread-should-not-forward");
      });
    } finally {
      await adapter.close();
    }
  });

  it("forwards and isolates per-Session environments", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-adapter-environments-"));
    temporaryDirectories.push(directory);
    const environmentsPath = path.join(directory, "environments.log");
    const command = await environmentAwareHermesExecutable();
    const adapter = new HermesAdapter({
      command,
      environment: {
        ...process.env,
        FAKE_HERMES_ENVIRONMENTS: environmentsPath,
        FAKE_HERMES_IDENTITY_VAR: "CODEXHOST_SECRET_TOKEN",
      },
    });

    const first = await adapter.open({
      kind: "create",
      cwd: process.cwd(),
      environment: { CODEXHOST_THREAD_ID: "thread-one", CODEXHOST_SECRET_TOKEN: "token-one" },
    });
    const second = await adapter.open({
      kind: "create",
      cwd: process.cwd(),
      environment: { CODEXHOST_THREAD_ID: "thread-two", CODEXHOST_SECRET_TOKEN: "token-two" },
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.initialState.nativeRef?.nativeSessionId).toBe("fake-session-token-one");
      expect(second.value.initialState.nativeRef?.nativeSessionId).toBe("fake-session-token-two");
      await first.value.close();
      await second.value.close();
    }
    await vi.waitFor(async () => {
      const environments = (await readFile(environmentsPath, "utf8")).trim().split("\n");
      expect(environments).toContain("token-one");
      expect(environments).toContain("token-two");
    });
    await adapter.close();
  });

  it("does not retain an unused warm process for a Thread-specific environment", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-adapter-thread-warm-counter-"));
    temporaryDirectories.push(directory);
    const counterPath = path.join(directory, "starts.log");
    const command = await countingHermesExecutable();
    const adapter = new HermesAdapter({
      command,
      environment: { ...process.env, FAKE_HERMES_STARTS: counterPath },
    });

    try {
      const opened = await adapter.open({
        kind: "create",
        cwd: process.cwd(),
        environment: { CODEXHOST_THREAD_ID: "thread", CODEXHOST_SECRET_TOKEN: "private" },
      });
      expect(opened.ok).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const starts = (await readFile(counterPath, "utf8")).trim().split("\n");
      expect(starts).toHaveLength(1);
    } finally {
      await adapter.close();
    }
  });

  it("reuses a warm ACP process across Host Threads", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-adapter-thread-warm-reuse-"));
    temporaryDirectories.push(directory);
    const counterPath = path.join(directory, "starts.log");
    const command = await countingHermesExecutable();
    const adapter = new HermesAdapter({
      command,
      environment: { ...process.env, FAKE_HERMES_STARTS: counterPath },
    });

    try {
      const first = await adapter.open({
        kind: "create",
        cwd: process.cwd(),
        environment: { CODEXHOST_THREAD_ID: "thread-one" },
      });
      expect(first.ok).toBe(true);
      // The open re-supplies the warm pool despite the Thread identity: process 2.
      await vi.waitFor(
        async () => {
          const starts = await readFile(counterPath, "utf8");
          expect(starts.trim().split("\n")).toHaveLength(2);
        },
        { timeout: 2_000 },
      );

      const second = await adapter.open({
        kind: "create",
        cwd: process.cwd(),
        environment: { CODEXHOST_THREAD_ID: "thread-two" },
      });
      expect(second.ok).toBe(true);
      if (first.ok && second.ok) {
        // Session 1 ran on process A, Session 2 reused the warmed process B.
        expect(first.value.initialState.nativeRef?.nativeSessionId).toMatch(/^fake-session-/);
        expect(second.value.initialState.nativeRef?.nativeSessionId).toMatch(/^fake-session-/);
        await first.value.close();
        await second.value.close();
      }
      await adapter.close();

      // The second Thread also re-arms the pool (process 3). With a per-Thread
      // sharded pool the count would stall at 2: the second open would spawn
      // its own process and never warm another.
      await vi.waitFor(
        async () => {
          const starts = await readFile(counterPath, "utf8");
          expect(starts.trim().split("\n")).toHaveLength(3);
        },
        { timeout: 2_000 },
      );
    } finally {
      await adapter.close();
    }
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

  it("reuses a warm ACP process for a Session opened in a different directory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-adapter-cwd-warm-"));
    temporaryDirectories.push(directory);
    const firstCwd = path.join(directory, "alpha");
    const secondCwd = path.join(directory, "beta");
    await mkdir(firstCwd, { recursive: true });
    await mkdir(secondCwd, { recursive: true });
    const sessionsPath = path.join(directory, "sessions.log");
    const startsPath = path.join(directory, "starts.log");
    const command = await cwdAwareHermesExecutable();
    const adapter = new HermesAdapter({
      command,
      environment: {
        ...process.env,
        FAKE_HERMES_SESSIONS: sessionsPath,
        FAKE_HERMES_STARTS: startsPath,
      },
    });

    try {
      const first = await adapter.open({ kind: "create", cwd: firstCwd });
      expect(first.ok).toBe(true);
      // open#1 arms a warm replacement: process 2.
      await vi.waitFor(
        async () => {
          const starts = await readFile(startsPath, "utf8");
          expect(starts.trim().split("\n")).toHaveLength(2);
        },
        { timeout: 2_000 },
      );

      // A Session in a different directory must reuse the warmed process and
      // receive ITS cwd in session/new — not the directory the warm process
      // was spawned for.
      const second = await adapter.open({ kind: "create", cwd: secondCwd });
      expect(second.ok).toBe(true);
      if (second.ok) await second.value.close();
      if (first.ok) await first.value.close();
      await adapter.close();

      // Reuse + re-arm: exactly three processes, and the second Session's
      // session/new carried the second cwd.
      await vi.waitFor(
        async () => {
          const starts = await readFile(startsPath, "utf8");
          expect(starts.trim().split("\n")).toHaveLength(3);
        },
        { timeout: 2_000 },
      );
      const cwds = (await readFile(sessionsPath, "utf8")).trim().split("\n");
      expect(cwds).toEqual([firstCwd, secondCwd]);
    } finally {
      await adapter.close();
    }
  });

  it("replaces a warm ACP process that exits before the next Session opens", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-adapter-warm-exit-counter-"));
    temporaryDirectories.push(directory);
    const counterPath = path.join(directory, "starts.log");
    await writeFile(counterPath, "");
    const command = await exitingWarmHermesExecutable();
    const adapter = new HermesAdapter({
      command,
      environment: { ...process.env, FAKE_HERMES_STARTS: counterPath },
    });

    const first = await adapter.open({ kind: "create", cwd: process.cwd() });
    expect(first.ok).toBe(true);
    await vi.waitFor(async () => {
      const starts = await readFile(counterPath, "utf8");
      expect(starts.trim().split("\n")).toHaveLength(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 75));

    const second = await adapter.open({ kind: "create", cwd: process.cwd() });
    expect(second.ok).toBe(true);
    await vi.waitFor(async () => {
      const starts = await readFile(counterPath, "utf8");
      expect(starts.trim().split("\n").length).toBeGreaterThanOrEqual(3);
    });

    if (first.ok) await first.value.close();
    if (second.ok) await second.value.close();
    await adapter.close();
  });

  it("resolves the post-selection label from the SessionState inventory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hermes-adapter-select-label-"));
    temporaryDirectories.push(directory);
    const counterPath = path.join(directory, "model-calls.log");
    const command = await modelSelectionHermesExecutable();
    const adapter = new HermesAdapter({
      command,
      environment: { ...process.env, FAKE_HERMES_MODEL_CALLS: counterPath },
    });

    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const stateEvents: { resolvedModelLabel?: string }[] = [];
    void (async () => {
      for await (const output of opened.value.outputs) {
        if (
          output.kind === "event" &&
          output.event.type === "session.state.changed"
        ) {
          stateEvents.push(output.event.state);
        }
      }
    })();

    const requestedRef = encodeHermesModelRef("zai:glm-5-turbo");
    if (!requestedRef) throw new Error("Expected a valid Hermes Model Ref");
    const selected = await opened.value.execute({
      type: "model.select",
      model: requestedRef,
    });
    expect(selected.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));

    // The label must come from the SessionState name (catalog-aligned), never
    // the bare native id — a differing label renders a duplicate gray chip.
    const last = stateEvents.at(-1);
    expect(last?.resolvedModelLabel).toBe("GLM 5 Turbo");
    expect(last?.resolvedModelLabel).not.toContain("zai:");

    await opened.value.close();
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

describe("HermesAdapter import probes", () => {
  it("removes a closed one-shot probe from Adapter ownership", async () => {
    const command = await fakeHermesExecutable();
    const close = vi.spyOn(HermesAcpTransport.prototype, "close");
    const adapter = new HermesAdapter({ command });

    try {
      await expect(adapter.sessionImport.listCandidates()).resolves.toEqual({
        ok: true,
        value: [],
      });
      expect(close).toHaveBeenCalledTimes(1);

      await adapter.close();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await adapter.close();
      close.mockRestore();
    }
  });
});

describe("HermesSession recovery", () => {
  it("accumulates replayed user chunks into one restored prompt", async () => {
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
          { type: "user.text", text: "first " },
          { type: "user.text", text: "second" },
          { type: "agent.text", text: "answer" },
        ],
      },
      onSettle: () => undefined,
    });

    const snapshot = await session.readSnapshot();
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.value.turns).toHaveLength(1);
      expect(snapshot.value.turns[0]?.input).toEqual([{ type: "text", text: "first second" }]);
    }
    await session.close();
  });

  it("restores replayed Turns with an unknown outcome", async () => {
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
          { type: "agent.text", text: "partial answer" },
        ],
      },
      onSettle: () => undefined,
    });

    const snapshot = await session.readSnapshot();
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.value.turns[0]?.outcome).toMatchObject({ status: "unknown" });
    }
    await session.close();
  });

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

  it("restores terminal tool output and failure from replay updates", async () => {
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
          { type: "user.text", text: "run it" },
          {
            type: "tool.call",
            toolCallId: "tool-1",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tool-1",
              title: "Run command",
              status: "pending",
              rawInput: { command: "false" },
            },
          },
          {
            type: "tool.update",
            toolCallId: "tool-1",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tool-1",
              status: "failed",
              rawOutput: "exit code 1",
            },
          },
        ] as HermesTransportEvent[],
      },
      onSettle: () => undefined,
    });

    const snapshot = await session.readSnapshot();

    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.value.turns[0]?.items[0]).toMatchObject({
        item: {
          type: "toolExecution",
          toolName: "Run command",
          output: { content: [{ type: "text", text: "exit code 1" }] },
        },
        outcome: { status: "failed" },
      });
    }
    await session.close();
  });
});

describe("HermesSession terminal events", () => {
  it("preserves partial tool output when the Turn ends without a terminal update", async () => {
    const transport = {
      onFault: () => undefined,
      runTurn: async (_text: string, onEvent: (event: HermesTransportEvent) => void) => {
        onEvent({
          type: "tool.call",
          toolCallId: "partial-tool-call",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "partial-tool-call",
            title: "Long command",
            status: "in_progress",
          },
        } as HermesTransportEvent);
        onEvent({
          type: "tool.update",
          toolCallId: "partial-tool-call",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "partial-tool-call",
            status: "in_progress",
            rawOutput: "partial output",
          },
        } as HermesTransportEvent);
        return { stopReason: "end_turn" as const };
      },
      cancel: async () => undefined,
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

    const outputsPromise = collectUntilTurnCompleted(session.outputs);
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-partial-tool-output"),
      input: [{ type: "text", text: "run" }],
    });
    const outputs = await outputsPromise;
    const completed = outputs.find(
      (output) => output.kind === "event" && output.event.type === "item.completed",
    );

    expect(completed).toMatchObject({
      kind: "event",
      event: {
        type: "item.completed",
        snapshot: {
          item: { output: { content: [{ type: "text", text: "partial output" }] } },
          outcome: { status: "cancelled" },
        },
      },
    });
    await session.close();
  });

  it("sends leading and trailing prompt whitespace to Hermes unchanged", async () => {
    let receivedText = "";
    const transport = {
      onFault: () => undefined,
      runTurn: async (text: string) => {
        receivedText = text;
        return { stopReason: "end_turn" as const };
      },
      cancel: async () => undefined,
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
    const input = "  indented prompt\n\n";

    const outputsPromise = collectUntilTurnCompleted(session.outputs);
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-preserve-whitespace"),
      input: [{ type: "text", text: input }],
    });
    await outputsPromise;

    expect(receivedText).toBe(input);
    await session.close();
  });

  it("immediately terminalizes a failed tool_call carrying its initial output", async () => {
    const transport = {
      onFault: () => undefined,
      runTurn: async (_text: string, onEvent: (event: HermesTransportEvent) => void) => {
        onEvent({
          type: "tool.call",
          toolCallId: "terminal-tool-call",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "terminal-tool-call",
            title: "Run command",
            status: "failed",
            rawOutput: "exit code 1",
          },
        } as HermesTransportEvent);
        return { stopReason: "end_turn" as const };
      },
      cancel: async () => undefined,
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

    const outputsPromise = collectUntilTurnCompleted(session.outputs);
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-initial-terminal-tool"),
      input: [{ type: "text", text: "run" }],
    });
    const outputs = await outputsPromise;
    const completed = outputs.filter(
      (output) => output.kind === "event" && output.event.type === "item.completed",
    );

    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      kind: "event",
      event: {
        type: "item.completed",
        snapshot: {
          item: { output: { content: [{ type: "text", text: "exit code 1" }] } },
          outcome: { status: "failed" },
        },
      },
    });
    await session.close();
  });

  it("emits a completed tool item only once", async () => {
    const transport = {
      onFault: () => undefined,
      runTurn: async (_text: string, onEvent: (event: HermesTransportEvent) => void) => {
        onEvent({
          type: "tool.call",
          toolCallId: "tool-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "Read file",
            status: "pending",
          },
        } as HermesTransportEvent);
        onEvent({
          type: "tool.update",
          toolCallId: "tool-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-1",
            status: "completed",
            rawOutput: "done",
          },
        } as HermesTransportEvent);
        return { stopReason: "end_turn" as const };
      },
      cancel: async () => undefined,
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

    const outputsPromise = collectUntilTurnCompleted(session.outputs);
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-tool-terminal"),
      input: [{ type: "text", text: "read" }],
    });
    const outputs = await outputsPromise;

    const completed = outputs.filter(
      (output) => output.kind === "event" && output.event.type === "item.completed",
    );
    expect(completed).toHaveLength(1);
    await session.close();
  });

  it("terminalizes the active Turn before a transport fault ends the Session", async () => {
    let fault: ((error: HermesTransportError) => void) | undefined;
    const transport = {
      set onFault(handler: (error: HermesTransportError) => void) {
        fault = handler;
      },
      runTurn: (_text: string, onEvent: (event: HermesTransportEvent) => void) => {
        onEvent({
          type: "tool.call",
          toolCallId: "tool-during-fault",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-during-fault",
            title: "Long-running command",
            status: "in_progress",
          },
        } as HermesTransportEvent);
        return new Promise<never>(() => undefined);
      },
      cancel: async () => undefined,
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

    const outputsPromise = (async () => {
      const outputs: HarnessOutput[] = [];
      for await (const output of session.outputs) outputs.push(output);
      return outputs;
    })();
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-fault"),
      input: [{ type: "text", text: "go" }],
    });
    fault?.(new HermesTransportError("processExited", "Hermes exited"));
    const outputs = await outputsPromise;
    const eventTypes = outputs
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event.type);

    expect(eventTypes).toEqual([
      "turn.started",
      "item.started",
      "item.completed",
      "turn.completed",
      "session.faulted",
    ]);
    const itemCompleted = outputs.find(
      (output) => output.kind === "event" && output.event.type === "item.completed",
    );
    expect(itemCompleted).toMatchObject({
      kind: "event",
      event: { type: "item.completed", snapshot: { outcome: { status: "cancelled" } } },
    });
    const turnCompleted = outputs.find(
      (output) => output.kind === "event" && output.event.type === "turn.completed",
    );
    expect(turnCompleted).toMatchObject({
      kind: "event",
      event: { type: "turn.completed", outcome: { status: "failed" } },
    });
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
    await expect(
      session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("turn-after-failed-cancel"),
        input: [{ type: "text", text: "must remain blocked" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
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
