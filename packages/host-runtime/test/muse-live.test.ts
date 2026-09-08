import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";
import { MappingStore } from "@codexhost/mapping-store";
import type { JsonObject } from "@codexhost/protocol-core";
import {
  encodeHarnessPluginRoute,
  harnessInspectionSchema,
  harnessPluginRouteSchema,
  hostThreadIdSchema,
} from "@codexhost/shared-contracts";

import { AccountRepository, AppServerHost, ThreadAccountStore } from "../src/index.js";

// Run after build:typescript with Node 24 and a normally authenticated Muse CLI:
// CODEXHOST_MUSE_LIVE=1 npx vitest run --config tests/vitest.config.js packages/host-runtime/test/muse-live.test.ts
// Only the official Codex process is synthetic. Muse, the packaged plugin, routing,
// streamed output, persistence, shutdown and resume all use their production paths.
// Native safety defaults remain enabled. Only one explicitly checked printf
// approval is answered once; unexpected approval requests fail this gate.
const live = process.env.CODEXHOST_MUSE_LIVE === "1";
const responseTimeoutMs = 90_000;

class FakeOfficialProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  constructor() {
    super();
    this.stdin.once("finish", () => {
      this.stdout.end();
      this.emit("exit", 0, null);
    });
  }

  kill(): boolean {
    return true;
  }
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object from Host");
  }
  return value as JsonObject;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Expected a non-empty string from Host");
  }
  return value;
}

function turnEvent(message: JsonObject, method: string, turnId: string): boolean {
  if (message.method !== method) return false;
  const params = object(message.params);
  return params.turnId === turnId || object(params.turn ?? {}).id === turnId;
}

class HostOutput {
  readonly messages: JsonObject[] = [];
  readonly #waiters = new Set<{
    predicate: (message: JsonObject) => boolean;
    resolve: (message: JsonObject) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  #buffer = "";
  #failure?: Error;
  #expectedApprovals = 0;

  constructor(stream: PassThrough) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let newline = this.#buffer.indexOf("\n");
      while (newline >= 0) {
        const message = object(JSON.parse(this.#buffer.slice(0, newline)));
        this.#buffer = this.#buffer.slice(newline + 1);
        this.messages.push(message);
        if (message.id !== undefined && typeof message.method === "string") {
          if (message.method === "mcpServer/elicitation/request" && this.#expectedApprovals > 0) {
            this.#expectedApprovals -= 1;
          } else {
            this.#failure = new Error(`Unexpected Muse approval request: ${message.method}`);
          }
        }
        for (const waiter of this.#waiters) {
          if (this.#failure || waiter.predicate(message)) {
            this.#waiters.delete(waiter);
            clearTimeout(waiter.timer);
            if (this.#failure) waiter.reject(this.#failure);
            else waiter.resolve(message);
          }
        }
        newline = this.#buffer.indexOf("\n");
      }
    });
  }

  expectOneApproval(): void {
    this.#expectedApprovals = 1;
  }

  endApprovalWindow(): void {
    this.#expectedApprovals = 0;
  }

  waitFor(predicate: (message: JsonObject) => boolean): Promise<JsonObject> {
    if (this.#failure) return Promise.reject(this.#failure);
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error("Timed out waiting for live Muse Host output"));
        }, responseTimeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  close(): void {
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Live Muse Host fixture closed"));
    }
    this.#waiters.clear();
  }
}

function createHost(directory: string, pluginRoot: string) {
  const desktopInput = new PassThrough();
  const desktopOutput = new PassThrough();
  const diagnosticOutput = new PassThrough();
  // Drain diagnostics without printing user paths, configuration or credentials.
  diagnosticOutput.resume();
  const output = new HostOutput(desktopOutput);
  const official = new FakeOfficialProcess();
  const mappingStore = new MappingStore({ directory: path.join(directory, "mapping") });
  const accountDirectory = path.join(directory, "accounts");
  const host = new AppServerHost({
    stockCodexPath: "/synthetic/codex",
    arguments: ["app-server"],
    defaultAgent: "codex",
    desktopInput,
    desktopOutput,
    diagnosticOutput,
    mappingStore,
    environment: { ...process.env, CODEXHOST_DATA_DIR: directory },
    pluginRoots: [pluginRoot],
    externalAdapters: new Map(),
    spawnOfficial: (() =>
      official as unknown as ChildProcessWithoutNullStreams) as unknown as typeof spawn,
    accountRepository: new AccountRepository({
      directory: accountDirectory,
      defaultAccount: {
        accountId: "default",
        codexHome: path.join(directory, "codex-home"),
      },
    }),
    threadAccountStore: new ThreadAccountStore({ directory: accountDirectory }),
  });
  const running = host.run();
  // Attach a handler immediately; close() still observes the original rejection.
  void running.catch(() => undefined);
  let requestId = 0;
  let closed = false;
  return {
    output,
    mappingStore,
    respond(id: string | number, result: JsonObject): void {
      desktopInput.write(`${JSON.stringify({ id, result })}\n`);
    },
    async request(method: string, params: JsonObject): Promise<JsonObject> {
      const id = ++requestId;
      desktopInput.write(`${JSON.stringify({ id, method, params })}\n`);
      const response = await output.waitFor((message) => message.id === id);
      if (response.error) {
        throw new Error(`Host ${method} failed: ${JSON.stringify(response.error)}`);
      }
      return object(response.result);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      desktopInput.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const exitCode = await Promise.race([
          running,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Live Host shutdown exceeded 15 seconds")),
              15_000,
            );
          }),
        ]);
        expect(exitCode).toBe(0);
        expect(official.stdin.readableLength).toBe(0);
      } finally {
        clearTimeout(timer);
        output.close();
      }
    },
  };
}

type LiveHost = ReturnType<typeof createHost>;

function isBashItem(item: JsonObject): boolean {
  return item.type === "commandExecution";
}

function verifyPrintfItem(item: JsonObject, workspace: string): void {
  expect(item).toMatchObject({
    type: "commandExecution",
    command: "printf MUSE_TOOL_OK",
    cwd: workspace,
  });
}

async function startTurn(host: LiveHost, threadId: string, text: string): Promise<string> {
  const started = await host.request("turn/start", {
    threadId,
    input: [{ type: "text", text }],
  });
  const turnId = string(object(started.turn).id);
  await host.output.waitFor((message) => turnEvent(message, "turn/started", turnId));
  return turnId;
}

async function verifyAnswer(host: LiveHost, threadId: string, turnId: string, answer: string) {
  const completed = await host.output.waitFor((message) =>
    turnEvent(message, "turn/completed", turnId),
  );
  expect(completed).toMatchObject({ params: { turn: { status: "completed" } } });
  const read = await host.request("thread/read", { threadId, includeTurns: true });
  const turns = object(read.thread).turns;
  expect(Array.isArray(turns)).toBe(true);
  const persistedTurn = (turns as JsonObject[]).find((turn) => turn.id === turnId);
  expect(persistedTurn).toMatchObject({ status: "completed" });
  const items = object(persistedTurn).items as JsonObject[];
  const answers = items.filter((item) => item.type === "agentMessage");
  expect(answers.map((item) => string(item.text).trim())).toEqual([answer]);

  const events = host.output.messages;
  expect(
    events.some((message) => {
      if (message.method !== "item/started" && message.method !== "item/completed") return false;
      const item = object(object(message.params).item);
      return item.type === "dynamicToolCall" && item.tool === "userMessage";
    }),
  ).toBe(false);
  expect(events.filter((message) => turnEvent(message, "turn/completed", turnId))).toHaveLength(1);
  const completedAnswers = events
    .filter((message) => turnEvent(message, "item/completed", turnId))
    .map((message) => object(object(message.params).item))
    .filter((item) => item.type === "agentMessage");
  expect(completedAnswers.map((item) => string(item.text).trim())).toEqual([answer]);
  const deltas = events
    .filter((message) => turnEvent(message, "item/agentMessage/delta", turnId))
    .map((message) => string(object(message.params).delta))
    .join("");
  expect(deltas.trim()).toBe(answer);
  const mapping = await host.mappingStore.getThread(hostThreadIdSchema.parse(threadId));
  expect(mapping?.turnMappings.filter((turn) => turn.hostTurnId === turnId)).toHaveLength(1);
  return object(persistedTurn);
}

describe.skipIf(!live)("packaged Muse plugin live Host integration", () => {
  it("streams once, persists, resumes after Host shutdown, and recovers after cancellation", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-muse-host-live-"));
    const pluginRoot = path.join(directory, "plugins");
    const workspace = path.join(directory, "workspace");
    mkdirSync(pluginRoot);
    mkdirSync(workspace);
    cpSync(path.resolve("packages/host-runtime/dist/plugins/muse"), path.join(pluginRoot, "muse"), {
      recursive: true,
    });
    writeFileSync(
      path.join(pluginRoot, "enabled.json"),
      JSON.stringify({ version: 1, enabled: ["muse"] }),
    );
    let host = createHost(directory, pluginRoot);
    const receipts: Record<string, unknown> = {
      workspace,
      safety: "native-defaults",
      firstHost: [],
    };
    let passed = false;
    const artifactDirectory = process.env.CODEXHOST_MUSE_LIVE_ARTIFACT_DIR;
    const saveReceipt = (): void => {
      if (!artifactDirectory) return;
      mkdirSync(artifactDirectory, { recursive: true });
      writeFileSync(
        path.join(artifactDirectory, "muse-host-live.json"),
        JSON.stringify({ passed, ...receipts, finalHostOutput: host.output.messages }, null, 2),
        { mode: 0o600 },
      );
    };
    const stage = (name: string): void => {
      receipts.stage = name;
      receipts.updatedAt = new Date().toISOString();
      console.info(`[muse-live] ${name}`);
      saveReceipt();
    };
    try {
      stage("plugin-and-model-inspection");
      const listed = await host.request("codexhost/harness/plugins/list", {});
      expect(listed).toMatchObject({ plugins: [{ id: "muse", name: "Meta Muse Code" }] });
      const inspection = harnessInspectionSchema.parse(
        await host.request("codexhost/harness/inspect", { harnessId: "muse", cwd: workspace }),
      );
      expect(inspection.status).toBe("ready");
      if (inspection.status !== "ready") throw new Error("Live Muse is not ready");
      expect(inspection.catalog.models.length).toBeGreaterThan(0);
      const defaultPermissionMode = inspection.permissionModes?.defaultModeId;
      expect(defaultPermissionMode).toBeTruthy();
      expect(defaultPermissionMode).not.toBe("allowAll");
      const model = encodeHarnessPluginRoute(
        harnessPluginRouteSchema.parse({
          harnessId: "muse",
          permissionModeId: defaultPermissionMode,
        }),
      );
      const created = await host.request("thread/start", { model, cwd: workspace });
      const threadId = string(object(created.thread).id);
      const initialMapping = await host.mappingStore.getThread(hostThreadIdSchema.parse(threadId));
      expect(initialMapping).toMatchObject({ harnessId: "muse", state: "ready" });
      const nativeSessionId = string(initialMapping?.nativeSessionRef?.nativeSessionId);
      receipts.threadId = threadId;
      receipts.nativeSessionId = nativeSessionId;
      receipts.modelCatalog = inspection.catalog;

      stage("first-chinese-turn");
      const firstTurn = await startTurn(
        host,
        threadId,
        "只回复这四个汉字：接入正常。不要添加标点、解释或任何其他内容，不要调用工具。",
      );
      await verifyAnswer(host, threadId, firstTurn, "接入正常");
      receipts.firstHost = host.output.messages;
      stage("first-host-shutdown");
      await host.close();

      host = createHost(directory, pluginRoot);
      stage("resume-and-memory-turn");
      const resumed = await host.request("thread/resume", { threadId });
      expect(resumed).toMatchObject({ thread: { id: threadId, turns: [{ id: firstTurn }] } });
      const resumedMapping = await host.mappingStore.getThread(hostThreadIdSchema.parse(threadId));
      expect(resumedMapping?.nativeSessionRef?.nativeSessionId).toBe(nativeSessionId);
      const secondTurn = await startTurn(
        host,
        threadId,
        "你上一轮回复的四个汉字是什么？只回复那四个字，不要添加标点或解释，不要调用工具。",
      );
      await verifyAnswer(host, threadId, secondTurn, "接入正常");

      stage("printf-tool-turn");
      host.output.expectOneApproval();
      const toolTurn = await startTurn(
        host,
        threadId,
        "请只使用 bash 工具在当前工作目录执行一次命令：printf MUSE_TOOL_OK。" +
          "命令必须逐字照写，不要读取文件，不要执行其他命令。等待审批后执行。" +
          "最后只回复工具的实际输出，不要解释。",
      );
      const approvalOrTerminal = await host.output.waitFor(
        (message) =>
          (message.method === "mcpServer/elicitation/request" &&
            object(message.params).turnId === toolTurn) ||
          turnEvent(message, "turn/completed", toolTurn),
      );
      const commandStarted = await host.output.waitFor(
        (message) =>
          turnEvent(message, "item/started", toolTurn) &&
          isBashItem(object(object(message.params).item)),
      );
      verifyPrintfItem(object(object(commandStarted.params).item), workspace);
      if (approvalOrTerminal.method === "mcpServer/elicitation/request") {
        const approval = approvalOrTerminal;
        expect(approval).toMatchObject({ params: { threadId, turnId: toolTurn, mode: "form" } });
        if (typeof approval.id !== "number" && typeof approval.id !== "string") {
          throw new Error("Muse tool approval has no Host request ID");
        }
        // This is the only approval reply in the gate. No session/persistent grant.
        host.respond(approval.id, { action: "accept", content: {}, _meta: null });
        await host.output.waitFor(
          (message) =>
            message.method === "serverRequest/resolved" &&
            object(message.params).requestId === approval.id,
        );
        receipts.approval = { status: "acceptedOnce", request: approval };
      } else {
        receipts.approval = { status: "notRequested" };
      }
      host.output.endApprovalWindow();
      const persistedToolTurn = await verifyAnswer(host, threadId, toolTurn, "MUSE_TOOL_OK");
      const commandCompleted = host.output.messages.filter(
        (message) =>
          turnEvent(message, "item/completed", toolTurn) &&
          isBashItem(object(object(message.params).item)),
      );
      expect(commandCompleted).toHaveLength(1);
      const completedItem = object(object(object(commandCompleted[0]).params).item);
      verifyPrintfItem(completedItem, workspace);
      expect(completedItem).toMatchObject({
        status: "completed",
        exitCode: 0,
      });
      const toolOutput = host.output.messages
        .filter(
          (message) =>
            turnEvent(message, "item/commandExecution/outputDelta", toolTurn) &&
            object(message.params).itemId === completedItem.id,
        )
        .map((message) => string(object(message.params).delta))
        .join("");
      expect(toolOutput).toBe("MUSE_TOOL_OK");
      const persistedTool = (persistedToolTurn.items as JsonObject[]).find(
        (item) => item.id === completedItem.id,
      );
      expect(persistedTool).toMatchObject({
        type: "commandExecution",
        command: "printf MUSE_TOOL_OK",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "MUSE_TOOL_OK",
      });
      receipts.tool = { completedItem, streamedOutput: toolOutput, persistedTool };

      stage("cancel-turn-and-persistence");
      const cancelledTurn = await startTurn(
        host,
        threadId,
        "不要调用任何工具。请写一篇详细的五千字中文文章，解释归并排序并逐步推导其复杂度。",
      );
      await host.request("turn/interrupt", { threadId, turnId: cancelledTurn });
      const interrupted = await host.output.waitFor((message) =>
        turnEvent(message, "turn/completed", cancelledTurn),
      );
      expect(interrupted).toMatchObject({ params: { turn: { status: "interrupted" } } });
      const cancelledRead = await host.request("thread/read", { threadId, includeTurns: true });
      expect(
        (object(cancelledRead.thread).turns as JsonObject[]).find(
          (turn) => turn.id === cancelledTurn,
        ),
      ).toMatchObject({ status: "interrupted" });
      const cancelledMapping = await host.mappingStore.getThread(
        hostThreadIdSchema.parse(threadId),
      );
      expect(
        cancelledMapping?.turnMappings.filter((turn) => turn.hostTurnId === cancelledTurn),
      ).toHaveLength(1);
      stage("followup-after-cancel");
      const followupTurn = await startTurn(
        host,
        threadId,
        "只回复这四个汉字：恢复正常。不要添加标点、解释或其他内容，不要调用工具。",
      );
      await verifyAnswer(host, threadId, followupTurn, "恢复正常");
      expect(
        host.output.messages.filter((message) =>
          turnEvent(message, "turn/completed", cancelledTurn),
        ),
      ).toHaveLength(1);
      receipts.mapping = await host.mappingStore.getThread(hostThreadIdSchema.parse(threadId));
      receipts.secondHost = host.output.messages;
      stage("final-host-shutdown");
      await host.close();
      passed = true;
      stage("passed");
    } catch (error) {
      receipts.error = error instanceof Error ? error.message : String(error);
      stage("failed");
      throw error;
    } finally {
      try {
        await host.close();
      } finally {
        saveReceipt();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }, 360_000);
});
