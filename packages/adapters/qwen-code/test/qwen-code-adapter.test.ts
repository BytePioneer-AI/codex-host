import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  harnessIdSchema,
  hostInteractionIdSchema,
  hostTurnIdSchema,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  QwenCodeTransportError,
  type QwenCodeOpenInput,
  type QwenCodeOpenResult,
  type QwenCodePermissionRequest,
  type QwenCodePermissionResponse,
  type QwenCodeTransportEvent,
} from "../src/sdk-transport.js";
import type { QwenCodeSdkTransportLike } from "../src/qwen-code-adapter.js";
import { QwenCodeAdapter } from "../src/qwen-code-adapter.js";

const SESSION_MODELS = {
  currentModelId: "qwen-max",
  availableModels: [{ modelId: "qwen-max", name: "Qwen Max", _meta: { contextLimit: 1_000_000 } }],
};

class FakeTransport implements QwenCodeSdkTransportLike {
  models: unknown = SESSION_MODELS;
  sessionId = "550e8400-e29b-41d4-a716-446655440000";
  readonly openCalls: QwenCodeOpenInput[] = [];
  readonly setModelCalls: string[] = [];
  readonly setModeCalls: HarnessPermissionModeId[] = [];
  closed = false;
  runTurnImplementation:
    | ((
        onEvent: (event: QwenCodeTransportEvent) => void,
        onPermission: (request: QwenCodePermissionRequest) => Promise<QwenCodePermissionResponse>,
      ) => Promise<{ status: "succeeded" | "failed" | "cancelled" }>)
    | null = null;
  cancelImplementation: (() => Promise<void>) | null = null;

  async inspect(): Promise<{ models: unknown }> {
    return { models: this.models };
  }

  async open(input: QwenCodeOpenInput): Promise<QwenCodeOpenResult> {
    this.openCalls.push(input);
    return { sessionId: this.sessionId, resumed: input.kind === "resume", models: this.models };
  }

  runTurn(
    _text: string,
    onEvent: (event: QwenCodeTransportEvent) => void,
    onPermission: (request: QwenCodePermissionRequest) => Promise<QwenCodePermissionResponse>,
  ): Promise<{ status: "succeeded" | "failed" | "cancelled" }> {
    if (!this.runTurnImplementation) throw new Error("FakeTransport has no Turn implementation");
    return this.runTurnImplementation(onEvent, onPermission);
  }

  async setModel(nativeModelId: string): Promise<void> {
    this.setModelCalls.push(nativeModelId);
  }

  async setPermissionMode(permissionModeId: HarnessPermissionModeId): Promise<void> {
    this.setModeCalls.push(permissionModeId);
  }

  async cancel(): Promise<void> {
    await this.cancelImplementation?.();
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function adapterFor(...transports: FakeTransport[]): {
  adapter: QwenCodeAdapter;
  createTransport: ReturnType<typeof vi.fn>;
} {
  const createTransport = vi.fn(() => {
    const transport = transports.shift();
    if (!transport) throw new Error("Missing FakeTransport");
    return transport;
  });
  return {
    adapter: new QwenCodeAdapter({}, { createTransport, randomUUID: () => "item-1" }),
    createTransport,
  };
}

async function collect(session: { outputs: AsyncIterable<unknown> }): Promise<unknown[]> {
  const output: unknown[] = [];
  void (async () => {
    for await (const event of session.outputs) output.push(event);
  })();
  return output;
}

describe("QwenCodeAdapter", () => {
  it("inspects the SDK model catalog and advertises live permission selection", async () => {
    const transport = new FakeTransport();
    const { adapter } = adapterFor(transport);
    const inspection = await adapter.inspect();
    expect(inspection).toMatchObject({
      status: "ready",
      catalog: { defaultModel: { id: "qwen-max" } },
      capabilities: { configuration: { permissionModeScope: "live" } },
    });
    expect(transport.closed).toBe(true);
  });

  it("fails open when the SDK faults before the Session owns the Transport", async () => {
    const transport = new FakeTransport();
    const open = transport.open.bind(transport);
    const adapter = new QwenCodeAdapter(
      {},
      {
        createTransport: (options) => {
          transport.open = async (input) => {
            const result = await open(input);
            options.onFault?.(
              new QwenCodeTransportError("processExited", "Qwen Code exited during open"),
            );
            return result;
          };
          return transport;
        },
        randomUUID: () => "item-1",
      },
    );

    const opened = await adapter.open({ kind: "create", cwd: "/tmp" });

    expect(opened).toMatchObject({
      ok: false,
      error: { code: "processExited", message: "Qwen Code exited during open" },
    });
    expect(transport.closed).toBe(true);
  });

  it("pins SDK creation to the advertised default Model", async () => {
    const transport = new FakeTransport();
    const { adapter } = adapterFor(transport);

    const opened = await adapter.open({ kind: "create", cwd: "/tmp" });

    if (!opened.ok) throw new Error("create failed");
    expect(transport.setModelCalls).toEqual(["qwen-max"]);
    expect(opened.value.initialState.effectiveModel?.id).toBe("qwen-max");
    await opened.value.close();
  });

  it("gives explicit mode priority over yolo and forwards it to SDK open", async () => {
    const transport = new FakeTransport();
    const { adapter } = adapterFor(transport);
    const opened = await adapter.open({
      kind: "create",
      cwd: "/tmp",
      executionPolicy: "unattended-full-access",
      permissionModeId: "plan" as HarnessPermissionModeId,
    });
    expect(opened.ok).toBe(true);
    expect(transport.openCalls).toEqual([
      expect.objectContaining({ kind: "create", permissionMode: "plan" }),
    ]);
    if (opened.ok) await opened.value.close();
  });

  it("uses yolo for unattended creation", async () => {
    const transport = new FakeTransport();
    const { adapter } = adapterFor(transport);
    const opened = await adapter.open({
      kind: "create",
      cwd: "/tmp",
      executionPolicy: "unattended-full-access",
    });
    expect(opened.ok).toBe(true);
    expect(transport.openCalls).toEqual([
      expect.objectContaining({ kind: "create", permissionMode: "yolo" }),
    ]);
    if (opened.ok) await opened.value.close();
  });

  it("merges the Adapter environment with SDK create and resume overrides", async () => {
    const transports = [new FakeTransport(), new FakeTransport()];
    const createTransport = vi.fn(() => {
      const transport = transports.shift();
      if (!transport) throw new Error("Missing FakeTransport");
      return transport;
    });
    const adapter = new QwenCodeAdapter(
      { environment: { CODEXHOST_BASE: "base", CODEXHOST_OVERRIDE: "base" } },
      { createTransport, randomUUID: () => "item-1" },
    );
    const environment = {
      CODEXHOST_DELEGATION_THREAD_ID: "child-thread-1",
      CODEXHOST_OVERRIDE: "session",
    };
    const expectedEnvironment = {
      CODEXHOST_BASE: "base",
      CODEXHOST_DELEGATION_THREAD_ID: "child-thread-1",
      CODEXHOST_OVERRIDE: "session",
    };
    const created = await adapter.open({ kind: "create", cwd: "/tmp", environment });
    if (!created.ok) throw new Error("create failed");
    const nativeRef = created.value.initialState.nativeRef;
    if (!nativeRef) throw new Error("create returned no Native Session Ref");
    await created.value.close();
    const resumed = await adapter.open({
      kind: "resume",
      cwd: "/tmp",
      environment,
      nativeRef,
    });
    if (!resumed.ok) throw new Error("resume failed");
    expect(createTransport).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ environment: expectedEnvironment }),
    );
    expect(createTransport).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ environment: expectedEnvironment }),
    );
    await resumed.value.close();
  });

  it("maps SDK permissions and streamed output into a completed Host Turn", async () => {
    const transport = new FakeTransport();
    let respondToInteraction: ((interactionId: string) => Promise<unknown>) | null = null;
    transport.runTurnImplementation = async (onEvent, onPermission) => {
      const approval = onPermission({
        toolName: "run_shell_command",
        input: { command: "git status" },
      });
      await vi.waitFor(() =>
        expect(events.some((output) => (output as { kind?: string }).kind === "interaction")).toBe(
          true,
        ),
      );
      const interaction = events.find(
        (output) => (output as { kind?: string }).kind === "interaction",
      ) as {
        interaction: { interactionId: string };
      };
      if (!respondToInteraction) throw new Error("Session interaction handler is unavailable");
      const responded = await respondToInteraction(interaction.interaction.interactionId);
      expect(responded).toEqual({ ok: true, value: { accepted: true } });
      expect(await approval).toEqual({
        behavior: "allow",
        updatedInput: { command: "git status" },
      });
      onEvent({ type: "agent.text", text: "done" });
      onEvent({
        type: "tool.call",
        callId: "tool-1",
        title: "run_shell_command",
        kind: "execute",
        rawInput: { command: "git status" },
      });
      onEvent({ type: "tool.update", callId: "tool-1", status: "completed", rawOutput: "clean" });
      onEvent({
        type: "usage",
        metadata: { usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } },
      });
      return { status: "succeeded" };
    };
    const { adapter } = adapterFor(transport);
    const opened = await adapter.open({ kind: "create", cwd: "/tmp" });
    if (!opened.ok) throw new Error("open failed");
    const session = opened.value;
    respondToInteraction = (interactionId) =>
      session.execute({
        type: "interaction.respond",
        interactionId: hostInteractionIdSchema.parse(interactionId),
        response: { type: "approval", actionId: "allow" },
      });
    const events = await collect(session);
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-1"),
      input: [{ type: "text", text: "status" }],
    });
    await vi.waitFor(async () => {
      const snapshot = await session.readSnapshot();
      expect(snapshot.ok && snapshot.value.turns).toHaveLength(1);
    });
    const snapshot = await session.readSnapshot();
    if (!snapshot.ok) throw new Error("snapshot failed");
    expect(snapshot.value.turns[0]?.outcome).toEqual({ status: "succeeded" });
    expect(
      events.some(
        (output) =>
          (output as { event?: { type?: string } }).event?.type === "session.usage.changed",
      ),
    ).toBe(true);
    await session.close();
  });
  it("maps ask_user_question answers back into the Qwen SDK input", async () => {
    const transport = new FakeTransport();
    transport.runTurnImplementation = async (_onEvent, onPermission) => {
      const answer = onPermission({
        toolName: "ask_user_question",
        input: {
          questions: [
            {
              header: "Mode",
              question: "Which modes?",
              options: [
                { label: "Safe", description: "Read only" },
                { label: "Fast", description: "Execute immediately" },
              ],
              multiSelect: true,
            },
          ],
        },
      });
      await vi.waitFor(() =>
        expect(events.some((output) => (output as { kind?: string }).kind === "interaction")).toBe(
          true,
        ),
      );
      const interaction = events.find(
        (output) => (output as { kind?: string }).kind === "interaction",
      ) as {
        interaction: {
          interactionId: string;
          type: string;
          questions: Array<{ multiple: boolean }>;
        };
      };
      expect(interaction.interaction.type).toBe("question");
      expect(interaction.interaction.questions[0]?.multiple).toBe(true);
      await session.execute({
        type: "interaction.respond",
        interactionId: hostInteractionIdSchema.parse(interaction.interaction.interactionId),
        response: { type: "question", answers: { "question-0": ["Safe", "Fast"] } },
      });
      expect(await answer).toEqual({
        behavior: "allow",
        updatedInput: expect.objectContaining({ answers: { "0": "Safe, Fast" } }),
      });
      return { status: "succeeded" };
    };
    const { adapter } = adapterFor(transport);
    const opened = await adapter.open({ kind: "create", cwd: "/tmp" });
    if (!opened.ok) throw new Error("open failed");
    const session = opened.value;
    const events = await collect(session);
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-question"),
      input: [{ type: "text", text: "ask" }],
    });
    await vi.waitFor(async () => expect((await session.readSnapshot()).ok).toBe(true));
    await session.close();
  });
  it("restores the SDK Model and Turn ordinal without known refs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-qwen-resume-"));
    const cwd = path.join(root, "workspace");
    const runtimeDir = path.join(root, "qwen-runtime");
    const projectDir = path.join(
      runtimeDir,
      "projects",
      (process.platform === "win32" ? cwd.toLowerCase() : cwd).replace(/[^a-zA-Z0-9]/g, "-"),
      "chats",
    );
    const transport = new FakeTransport();
    transport.models = {
      currentModelId: "history-model",
      availableModels: [
        { modelId: "catalog-first", name: "Catalog First" },
        { modelId: "history-model", name: "History Model" },
      ],
    };
    transport.runTurnImplementation = async (onEvent) => {
      onEvent({ type: "agent.text", text: "third reply" });
      return { status: "succeeded" };
    };
    const { adapter } = adapterFor(transport);

    try {
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        path.join(projectDir, `${transport.sessionId}.jsonl`),
        [
          { type: "user", message: { role: "user", parts: [{ text: "first" }] } },
          { type: "assistant", message: { role: "model", parts: [{ text: "reply one" }] } },
          { type: "user", message: { role: "user", parts: [{ text: "second" }] } },
          { type: "assistant", message: { role: "model", parts: [{ text: "reply two" }] } },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n"),
        "utf8",
      );
      const opened = await adapter.open({
        kind: "resume",
        cwd,
        environment: { QWEN_RUNTIME_DIR: runtimeDir },
        nativeRef: {
          harnessId: harnessIdSchema.parse("qwen-code"),
          nativeSessionId: transport.sessionId,
          formatVersion: 1,
        },
      });
      if (!opened.ok) throw new Error("resume failed");
      expect(transport.setModelCalls).toEqual(["history-model"]);
      expect(opened.value.initialState.effectiveModel?.id).toBe("history-model");

      await opened.value.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("turn-after-resume"),
        input: [{ type: "text", text: "third" }],
      });
      await vi.waitFor(async () => {
        const snapshot = await opened.value.readSnapshot();
        expect(snapshot.ok && snapshot.value.turns).toHaveLength(3);
      });
      const snapshot = await opened.value.readSnapshot();
      if (!snapshot.ok) throw new Error("snapshot failed");
      expect(snapshot.value.turns[2]?.nativeTurnRef.nativeTurnKey).toBe("qwen-turn-2");
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds session close when SDK interrupt does not settle", async () => {
    const transport = new FakeTransport();
    const { promise: never } = Promise.withResolvers<undefined>();
    transport.runTurnImplementation = () => never.then(() => ({ status: "succeeded" as const }));
    transport.cancelImplementation = () => never;
    const adapter = new QwenCodeAdapter(
      { closeTimeoutMs: 1 },
      { createTransport: () => transport, randomUUID: () => "item-1" },
    );
    const opened = await adapter.open({ kind: "create", cwd: "/tmp" });
    if (!opened.ok) throw new Error("open failed");
    await opened.value.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-close"),
      input: [{ type: "text", text: "status" }],
    });

    vi.useFakeTimers();
    try {
      const closing = opened.value.close();
      await vi.advanceTimersByTimeAsync(1);
      await expect(closing).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(transport.closed).toBe(true);
  });
});
