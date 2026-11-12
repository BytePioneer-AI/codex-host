import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { AppServerHost, startClientChannelServer } from "@codexhost/host-runtime";
import { PiAdapter } from "@codexhost/adapter-pi";
import { ClaudeCodeAdapter } from "@codexhost/adapter-claude-code";
import type { HarnessAdapter } from "@codexhost/harness-adapter";
import {
  encodeHarnessPluginRoute,
  harnessIdSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";

type PiDependencies = NonNullable<ConstructorParameters<typeof PiAdapter>[1]>;
type PiTransport = ReturnType<PiDependencies["createTransport"]>;
type ClaudeDependencies = NonNullable<ConstructorParameters<typeof ClaudeCodeAdapter>[1]>;

/** Real Adapter and Host; only native transport and its history are simulated. */
export async function skillHost(harnessId: "pi" | "claude-code") {
  const root = await mkdtemp(join(tmpdir(), "skill-host-"));
  const inputs: string[] = [];
  const records: Array<{ id: string; text: string; answer: string }> = [];
  let delta: (text: string) => void = () => {
    throw new Error("No native execution");
  };
  let finish: (status?: "completed" | "cancelled" | "failed") => void = () => {
    throw new Error("No native execution");
  };
  let pending = false;
  let sessionId = "skill-native";
  const register = (
    text: string,
    id: string,
    emit: (text: string) => void,
    settle: (status: "completed" | "cancelled" | "failed", answer: string) => void,
  ) => {
    if (pending) throw new Error("Native execution already active");
    pending = true;
    inputs.push(text);
    let answer = "";
    delta = (text) => {
      answer += text;
      emit(text);
    };
    finish = (status = "completed") => {
      pending = false;
      records.push({ id, text, answer });
      settle(status, answer);
    };
    if (text === "warm")
      queueMicrotask(() => {
        delta("Ready");
        finish();
      });
  };
  const state: PiTransport["state"] = {
    sessionId,
    sessionFile: join(root, "native.jsonl"),
    provider: "fixture",
    modelId: "fixture-model",
    thinkingLevel: harnessThinkingOptionIdSchema.parse("off"),
    contextUsage: null,
  };
  const pi = new PiAdapter(
    {},
    {
      createTransport: () => ({
        state,
        start: async () => undefined,
        setAutonomousTurnHandler: () => undefined,
        clone: async () => state,
        getCommands: async () => [
          { name: "skill:eli5", description: "Explain simply", source: "skill" },
          { name: "local", description: "Handle locally", source: "extension" },
        ],
        getAvailableModels: async () => [
          { provider: "fixture", id: "fixture-model", reasoning: false },
        ],
        getAvailableThinkingLevels: async () => [harnessThinkingOptionIdSchema.parse("off")],
        getSessionUsage: async () => null,
        getEntries: async () => ({
          entries: records.flatMap((record, index) => [
            {
              id: record.id,
              parentId: records[index - 1] ? `${records[index - 1]?.id}-answer` : null,
              type: "message",
              message: { role: "user", content: [{ type: "text", text: record.text }] },
            },
            {
              id: `${record.id}-answer`,
              parentId: record.id,
              type: "message",
              message: {
                role: "assistant",
                content: [{ type: "text", text: record.answer }],
                stopReason: "stop",
              },
            },
          ]),
          leafId: records.length ? `${records.at(-1)?.id}-answer` : null,
        }),
        runTurn: (text, onEvent) => {
          if (text.startsWith("/local")) {
            onEvent({ type: "execution.started", ephemeral: true });
            return Promise.resolve({ text: "", cancelled: false, ephemeral: true });
          }
          onEvent({ type: "execution.started" });
          return new Promise((resolve, reject) => {
            const id = `user-${records.length + 1}`;
            register(
              text,
              id,
              (delta) => onEvent({ type: "text.delta", messageId: `${id}-answer`, delta }),
              (status, answer) =>
                status === "failed"
                  ? reject(new Error("Native failure"))
                  : resolve({ text: answer, cancelled: status === "cancelled" }),
            );
          });
        },
        compact: async (_text, onEvent) => {
          onEvent({ type: "compaction.started" });
          onEvent({ type: "compaction.completed", outcome: "succeeded" });
          return { outcome: "succeeded" };
        },
        abort: async () => {
          if (pending) finish("cancelled");
        },
        respondToInteraction: async () => undefined,
        selectModel: async () => state,
        selectThinkingOption: async () => state,
        fork: async () => state,
        verifySessionCwd: async () => undefined,
        close: async () => {
          if (pending) finish("cancelled");
        },
      }),
    },
  );
  const claude = new ClaudeCodeAdapter({ closeTimeoutMs: 50 }, {
    randomUUID,
    inspectInstallation: () => undefined,
    bypassPermissionsAvailable: () => true,
    createInspector: () => ({
      inspect: async () => ({
        models: [{ value: "default", displayName: "Default" }],
        canSelectModel: true,
        canSelectPermissionMode: true,
      }),
      close: async () => undefined,
    }),
    getSessionInfo: async () => ({ cwd: root }),
    readSessionMessages: async () =>
      records.flatMap((record) => [
        {
          type: "user",
          uuid: record.id,
          session_id: sessionId,
          message: { role: "user", content: record.text },
        },
        {
          type: "assistant",
          uuid: `${record.id}-answer`,
          session_id: sessionId,
          message: {
            role: "assistant",
            content: [{ type: "text", text: record.answer }],
            stop_reason: "end_turn",
          },
        },
      ]),
    readSubagentMessages: async () => [],
    deleteSession: async () => undefined,
    forkSession: async () => ({ sessionId: "derived" }),
    createTransport: (options) => {
      sessionId = options.sessionId;
      let mode = options.permissionMode;
      return {
        sessionId,
        start: async () => undefined,
        slashCommands: () => ({
          commands: [{ name: "lead-delegation", description: "Delegate", argumentHint: "task" }],
          skillNames: new Set(["lead-delegation"]),
        }),
        getContextUsage: async () => ({ usedTokens: 10, maxTokens: 200, model: "fixture-model" }),
        getPermissionMode: () => mode,
        setModel: async () => undefined,
        setThinkingOption: async () => undefined,
        setPermissionMode: async (value) => {
          mode = value;
        },
        steer: async () => undefined,
        setAutonomousTurnHandler: () => undefined,
        setIdleTurnHandler: () => undefined,
        setThreadEventHandler: () => undefined,
        setIdleLive: () => undefined,
        hasBackgroundTasks: () => false,
        stopBackgroundTask: async () => undefined,
        stopTasks: async () => undefined,
        compact: async () => ({ status: "succeeded" }),
        init: async () => ({ status: "succeeded" }),
        recap: async () => ({ status: "succeeded" }),
        runTurn: (text, id, onEvent) =>
          new Promise((resolve, reject) => {
            register(
              text,
              id,
              (delta) => onEvent({ type: "text.delta", messageId: `${id}-answer`, delta }),
              (status) =>
                status === "failed"
                  ? reject(new Error("Native failure"))
                  : resolve(
                      status === "cancelled"
                        ? { status: "cancelled", reason: "Cancelled by user" }
                        : { status: "succeeded" },
                    ),
            );
          }),
        abort: async () => {
          if (pending) finish("cancelled");
        },
        abortContinuation: async () => undefined,
        respondToInteraction: async () => undefined,
        close: async () => {
          if (pending) finish("cancelled");
        },
      };
    },
  } satisfies ClaudeDependencies);
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  output.resume();
  diagnostics.resume();
  const adapter: HarnessAdapter = harnessId === "pi" ? pi : claude;
  const host = new AppServerHost({
    stockCodexPath: "/unused/codex",
    arguments: [],
    externalOnly: true,
    desktopInput: input,
    desktopOutput: output,
    diagnosticOutput: diagnostics,
    environment: { HOME: root, USERPROFILE: root, CODEXHOST_DATA_DIR: root },
    externalAdapters: new Map([[harnessId, adapter]]),
  });
  const ready = new Promise<void>((resolve) => {
    let buffer = "";
    const receive = (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.split("\n").some((line) => line && JSON.parse(line).id === "ready")) {
        output.off("data", receive);
        resolve();
      }
    };
    output.on("data", receive);
  });
  const running = host.run();
  input.write(JSON.stringify({ id: "ready", method: "thread/list", params: {} }) + "\n");
  await ready;
  const request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const reply = await host.handleClientRequest(method, params);
    if ("error" in reply) throw new Error(reply.error.message);
    return reply.result as T;
  };
  const { thread } = await request<{ thread: { id: string } }>("thread/start", {
    model: encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse(harnessId) }),
    cwd: root,
  });
  const channelDirectory = join(root, "client-hosts");
  const channel = await startClientChannelServer({
    target: host,
    environment: { CODEXHOST_DATA_DIR: root },
    directory: channelDirectory,
    owner: "service",
  });
  return {
    host,
    request,
    threadId: thread.id,
    root,
    channelDirectory,
    inputs,
    delta: (text: string) => delta(text),
    finish: (status?: "completed" | "cancelled" | "failed") => finish(status),
    async close() {
      if (pending) finish("cancelled");
      await channel.close();
      input.end();
      await running;
      await rm(root, { recursive: true, force: true });
    },
  };
}
