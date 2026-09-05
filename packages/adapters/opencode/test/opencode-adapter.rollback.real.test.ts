import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  comparableHistoricalTurn,
  type HarnessOutput,
  type HarnessSession,
} from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { OpenCodeAdapter } from "../src/index.js";

const command = process.env.CODEXHOST_OPENCODE_REAL_COMMAND;
const MODEL_ID = "rollback-model";
const PROVIDER_ID = "codexhost-test";
const execFileAsync = promisify(execFile);

interface ModelRequest {
  messages?: Array<{ role?: string }>;
  model?: string;
  stream?: boolean;
  tools?: Array<{ function?: { name?: string }; type?: string }>;
}

interface TestModelServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

const openServers = new Set<TestModelServer>();

afterEach(async () => {
  await Promise.all([...openServers].map((server) => server.close()));
  openServers.clear();
});

async function readJson(request: IncomingMessage): Promise<ModelRequest> {
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request) body += chunk;
  return JSON.parse(body) as ModelRequest;
}

function writeJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function completionChunk(input: {
  delta: Record<string, unknown>;
  finishReason: "stop" | "tool_calls" | null;
  usage?: { completion_tokens: number; prompt_tokens: number; total_tokens: number };
}) {
  return {
    id: "chatcmpl-codexhost",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL_ID,
    choices: [
      {
        index: 0,
        delta: input.delta,
        finish_reason: input.finishReason,
      },
    ],
    ...(input.usage ? { usage: input.usage } : {}),
  };
}

function streamCompletion(
  response: ServerResponse,
  chunks: Array<ReturnType<typeof completionChunk>>,
): void {
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function startModelServer(filePath: string): Promise<TestModelServer> {
  const server = http.createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        writeJson(response, {
          object: "list",
          data: [{ id: MODEL_ID, object: "model", created: 0, owned_by: PROVIDER_ID }],
        });
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const input = await readJson(request);
      const editTool = input.tools?.find(({ function: candidate }) => candidate?.name === "edit");
      const shouldEdit = Boolean(editTool) && !input.messages?.some(({ role }) => role === "tool");
      const toolArguments = JSON.stringify({
        filePath,
        oldString: "before\n",
        newString: "after\n",
      });
      if (input.stream === false) {
        writeJson(response, {
          id: "chatcmpl-codexhost",
          object: "chat.completion",
          created: 0,
          model: input.model ?? MODEL_ID,
          choices: [
            {
              index: 0,
              finish_reason: shouldEdit ? "tool_calls" : "stop",
              message: shouldEdit
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_edit",
                        type: "function",
                        function: { name: "edit", arguments: toolArguments },
                      },
                    ],
                  }
                : { role: "assistant", content: "done" },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        });
        return;
      }
      if (shouldEdit) {
        streamCompletion(response, [
          completionChunk({
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_edit",
                  type: "function",
                  function: { name: "edit", arguments: toolArguments },
                },
              ],
            },
            finishReason: null,
          }),
          completionChunk({
            delta: {},
            finishReason: "tool_calls",
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          }),
        ]);
        return;
      }
      streamCompletion(response, [
        completionChunk({ delta: { role: "assistant", content: "done" }, finishReason: null }),
        completionChunk({
          delta: {},
          finishReason: "stop",
          usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
        }),
      ]);
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test Model Server has no port");
  let closed = false;
  const result: TestModelServer = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
  openServers.add(result);
  return result;
}

async function nextOutput(
  iterator: AsyncIterator<HarnessOutput>,
  timeoutMs = 30_000,
): Promise<HarnessOutput> {
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    iterator.next(),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Timed out waiting for Harness output")),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  if (result.done) throw new Error("Harness output ended before Turn completion");
  return result.value;
}

async function waitForTurn(
  session: HarnessSession,
  iterator: AsyncIterator<HarnessOutput>,
  turnId: string,
  text: string,
): Promise<HarnessOutput[]> {
  const outputs: HarnessOutput[] = [];
  const started = await session.execute({
    type: "turn.start",
    turnId: hostTurnIdSchema.parse(turnId),
    input: [{ type: "text", text }],
  });
  if (!started.ok) throw new Error(started.error.message);
  for (let index = 0; index < 100; index += 1) {
    const output = await nextOutput(iterator);
    outputs.push(output);
    if (
      output.kind === "event" &&
      output.event.type === "turn.completed" &&
      output.event.turnId === turnId
    ) {
      return outputs;
    }
  }
  throw new Error("OpenCode Turn emitted too many outputs without completing");
}

describe.runIf(Boolean(command))("OpenCode Adapter real rollback", () => {
  it("preserves a real Edit Tool change while deriving exact rollback history", async () => {
    if (!command) throw new Error("CODEXHOST_OPENCODE_REAL_COMMAND is required");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexhost-opencode-rollback-"));
    const workspace = path.join(root, "workspace");
    const fixture = path.join(workspace, "fixture.txt");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(fixture, "before\n", "utf8");
    await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
    await execFileAsync("git", ["add", "fixture.txt"], { cwd: workspace });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=codexhost Test",
        "-c",
        "user.email=codexhost-test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "test: establish rollback baseline",
      ],
      { cwd: workspace },
    );
    const modelServer = await startModelServer(fixture);
    const configuration = {
      $schema: "https://opencode.ai/config.json",
      enabled_providers: [PROVIDER_ID],
      model: `${PROVIDER_ID}/${MODEL_ID}`,
      small_model: `${PROVIDER_ID}/${MODEL_ID}`,
      permission: "ask",
      provider: {
        [PROVIDER_ID]: {
          npm: "@ai-sdk/openai-compatible",
          name: "codexhost Test Provider",
          options: { apiKey: "test-only", baseURL: modelServer.baseUrl },
          models: {
            [MODEL_ID]: {
              name: "Rollback Model",
              tool_call: true,
              limit: { context: 32_000, output: 4_000 },
            },
          },
        },
      },
    };
    const adapterOptions = {
      command,
      startupTimeoutMs: 20_000,
      commandTimeoutMs: 30_000,
      environment: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(configuration),
        OPENCODE_CONFIG_DIR: path.join(root, "config"),
        OPENCODE_DISABLE_PROJECT_CONFIG: "true",
        OPENCODE_TEST_HOME: path.join(root, "home"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
      },
    };
    let adapter = new OpenCodeAdapter(adapterOptions);
    try {
      const inspection = await adapter.inspect({ cwd: workspace, refresh: true });
      if (inspection.status !== "ready") {
        throw new Error(`OpenCode inspection failed: ${JSON.stringify(inspection)}`);
      }
      const opened = await adapter.open({
        kind: "create",
        cwd: workspace,
        executionPolicy: "unattended-full-access",
      });
      if (!opened.ok) throw new Error(opened.error.message);
      const sourceRef = opened.value.initialState.nativeRef;
      if (!sourceRef) throw new Error("OpenCode Session did not expose a Native Ref");
      expect(sourceRef.locator).toMatchObject({ executionPolicy: "unattended-full-access" });
      const sourceOutputs = opened.value.outputs[Symbol.asyncIterator]();
      const editOutputs = await waitForTurn(
        opened.value,
        sourceOutputs,
        "real-edit",
        "Edit the fixture exactly once, then finish.",
      );
      expect(editOutputs).toContainEqual(
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "turn.completed",
            outcome: expect.objectContaining({ status: "succeeded" }),
          }),
        }),
      );
      const followupOutputs = await waitForTurn(
        opened.value,
        sourceOutputs,
        "real-followup",
        "Confirm that the edit is complete without changing any files.",
      );
      expect(followupOutputs).toContainEqual(
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({
            type: "turn.completed",
            outcome: expect.objectContaining({ status: "succeeded" }),
          }),
        }),
      );
      expect(await fs.readFile(fixture, "utf8")).toBe("after\n");
      const sourceBefore = await opened.value.readSnapshot();
      if (!sourceBefore.ok) throw new Error(sourceBefore.error.message);
      expect(sourceBefore.value.turns).toHaveLength(2);
      const sourceFirstTurn = sourceBefore.value.turns[0];
      if (!sourceFirstTurn) throw new Error("OpenCode source is missing its first Turn");
      expect(sourceFirstTurn.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ item: expect.objectContaining({ type: "toolExecution" }) }),
          expect.objectContaining({ item: expect.objectContaining({ type: "fileChange" }) }),
        ]),
      );
      expect(sourceBefore.value.turns[1]?.outcome).toMatchObject({ status: "succeeded" });
      const checkpoint = sourceFirstTurn.checkpoint;
      if (!checkpoint) throw new Error("OpenCode Edit Turn did not expose a Checkpoint");
      await opened.value.close();

      const forked = await adapter.open({ kind: "fork", sourceRef, checkpoint, cwd: workspace });
      if (!forked.ok) throw new Error(forked.error.message);
      const forkedSnapshot = await forked.value.readSnapshot();
      if (!forkedSnapshot.ok) throw new Error(forkedSnapshot.error.message);
      expect(forkedSnapshot.value.turns).toHaveLength(1);
      const forkedTurn = forkedSnapshot.value.turns[0];
      if (!forkedTurn) throw new Error("OpenCode Fork is missing its retained Turn");
      expect(comparableHistoricalTurn(forkedTurn)).toEqual(
        comparableHistoricalTurn(sourceFirstTurn),
      );
      await forked.value.close();

      const rolledBack = await adapter.open({
        kind: "rollbackLastTurn",
        sourceRef,
        cwd: workspace,
      });
      if (!rolledBack.ok) throw new Error(rolledBack.error.message);
      const rolledBackRef = rolledBack.value.initialState.nativeRef;
      if (!rolledBackRef) throw new Error("OpenCode rollback did not expose a Native Ref");
      expect(rolledBackRef.nativeSessionId).not.toBe(sourceRef.nativeSessionId);
      expect(await fs.readFile(fixture, "utf8")).toBe("after\n");
      const rolledBackSnapshot = await rolledBack.value.readSnapshot();
      if (!rolledBackSnapshot.ok) throw new Error(rolledBackSnapshot.error.message);
      expect(rolledBackSnapshot.value.turns).toHaveLength(1);
      const rolledBackTurn = rolledBackSnapshot.value.turns[0];
      if (!rolledBackTurn) throw new Error("OpenCode rollback is missing its retained Turn");
      expect(comparableHistoricalTurn(rolledBackTurn)).toEqual(
        comparableHistoricalTurn(sourceFirstTurn),
      );
      expect(rolledBackTurn.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ item: expect.objectContaining({ type: "toolExecution" }) }),
          expect.objectContaining({ item: expect.objectContaining({ type: "fileChange" }) }),
        ]),
      );
      await rolledBack.value.close();

      const sourceAfterRollback = await adapter.open({
        kind: "resume",
        nativeRef: sourceRef,
        cwd: workspace,
      });
      if (!sourceAfterRollback.ok) throw new Error(sourceAfterRollback.error.message);
      const sourceAfter = await sourceAfterRollback.value.readSnapshot();
      if (!sourceAfter.ok) throw new Error(sourceAfter.error.message);
      expect(sourceAfter.value).toEqual(sourceBefore.value);
      expect(await fs.readFile(fixture, "utf8")).toBe("after\n");
      await sourceAfterRollback.value.close();

      await adapter.close();
      adapter = new OpenCodeAdapter(adapterOptions);
      const resumed = await adapter.open({
        kind: "resume",
        nativeRef: rolledBackRef,
        cwd: workspace,
      });
      if (!resumed.ok) throw new Error(resumed.error.message);
      expect(resumed.value.initialState.nativeRef?.locator).toMatchObject({
        executionPolicy: "unattended-full-access",
      });
      const resumedBefore = await resumed.value.readSnapshot();
      if (!resumedBefore.ok) throw new Error(resumedBefore.error.message);
      expect(resumedBefore.value.turns).toHaveLength(1);
      const resumedFirstTurn = resumedBefore.value.turns[0];
      if (!resumedFirstTurn) throw new Error("Restarted OpenCode Session lost its retained Turn");
      expect(comparableHistoricalTurn(resumedFirstTurn)).toEqual(
        comparableHistoricalTurn(sourceFirstTurn),
      );
      const resumedOutputs = resumed.value.outputs[Symbol.asyncIterator]();
      await waitForTurn(
        resumed.value,
        resumedOutputs,
        "after-restart",
        "Confirm again that no further changes are needed.",
      );
      expect(await fs.readFile(fixture, "utf8")).toBe("after\n");
      const resumedAfter = await resumed.value.readSnapshot();
      if (!resumedAfter.ok) throw new Error(resumedAfter.error.message);
      expect(resumedAfter.value.turns).toHaveLength(2);
      await resumed.value.close();

      const rolledBackAgain = await adapter.open({
        kind: "rollbackLastTurn",
        sourceRef: rolledBackRef,
        cwd: workspace,
      });
      if (!rolledBackAgain.ok) throw new Error(rolledBackAgain.error.message);
      expect(rolledBackAgain.value.initialState.nativeRef?.nativeSessionId).not.toBe(
        rolledBackRef.nativeSessionId,
      );
      expect(await fs.readFile(fixture, "utf8")).toBe("after\n");
      const rolledBackAgainRef = rolledBackAgain.value.initialState.nativeRef;
      if (!rolledBackAgainRef) {
        throw new Error("Second OpenCode rollback did not expose a Native Ref");
      }
      const rolledBackAgainSnapshot = await rolledBackAgain.value.readSnapshot();
      if (!rolledBackAgainSnapshot.ok) throw new Error(rolledBackAgainSnapshot.error.message);
      expect(rolledBackAgainSnapshot.value.turns).toHaveLength(1);
      const rolledBackAgainTurn = rolledBackAgainSnapshot.value.turns[0];
      if (!rolledBackAgainTurn) throw new Error("Second OpenCode rollback lost its retained Turn");
      expect(comparableHistoricalTurn(rolledBackAgainTurn)).toEqual(
        comparableHistoricalTurn(sourceFirstTurn),
      );
      await rolledBackAgain.value.close();

      const emptyPrefixRollback = await adapter.open({
        kind: "rollbackLastTurn",
        sourceRef: rolledBackAgainRef,
        cwd: workspace,
      });
      if (!emptyPrefixRollback.ok) throw new Error(emptyPrefixRollback.error.message);
      expect(emptyPrefixRollback.value.initialState.nativeRef?.nativeSessionId).not.toBe(
        rolledBackAgainRef.nativeSessionId,
      );
      await expect(emptyPrefixRollback.value.readSnapshot()).resolves.toMatchObject({
        ok: true,
        value: { turns: [] },
      });
      expect(await fs.readFile(fixture, "utf8")).toBe("after\n");
      await emptyPrefixRollback.value.close();
    } finally {
      await adapter.close();
      await modelServer.close();
      openServers.delete(modelServer);
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
