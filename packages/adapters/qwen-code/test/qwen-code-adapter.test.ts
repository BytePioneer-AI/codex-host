import { harnessIdSchema, hostInteractionIdSchema, hostTurnIdSchema, type HarnessPermissionModeId } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import type {
  QwenCodeOpenInput,
  QwenCodeOpenResult,
  QwenCodePermissionRequest,
  QwenCodePermissionResponse,
  QwenCodeTransportEvent,
} from "../src/sdk-transport.js";
import type { QwenCodeSdkTransportLike } from "../src/qwen-code-adapter.js";
import { QwenCodeAdapter } from "../src/qwen-code-adapter.js";

const SESSION_MODELS = {
  currentModelId: "qwen-max",
  availableModels: [{ modelId: "qwen-max", name: "Qwen Max", _meta: { contextLimit: 1_000_000 } }],
};

class FakeTransport implements QwenCodeSdkTransportLike {
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

  async inspect(): Promise<{ models: unknown }> {
    return { models: SESSION_MODELS };
  }

  async open(input: QwenCodeOpenInput): Promise<QwenCodeOpenResult> {
    this.openCalls.push(input);
    return { sessionId: this.sessionId, resumed: input.kind === "resume", models: SESSION_MODELS };
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

  async cancel(): Promise<void> {}

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

  it("forwards the delegation environment on SDK create and resume", async () => {
    const create = new FakeTransport();
    const resume = new FakeTransport();
    const { adapter, createTransport } = adapterFor(create, resume);
    const environment = { CODEXHOST_DELEGATION_THREAD_ID: "child-thread-1" };
    const created = await adapter.open({ kind: "create", cwd: "/tmp", environment });
    if (!created.ok) throw new Error("create failed");
    await created.value.close();
    const resumed = await adapter.open({
      kind: "resume",
      cwd: "/tmp",
      environment,
      nativeRef: {
        harnessId: harnessIdSchema.parse("qwen-code"),
        nativeSessionId: create.sessionId,
        formatVersion: 1,
      },
    });
    if (!resumed.ok) throw new Error("resume failed");
    expect(createTransport).toHaveBeenNthCalledWith(1, expect.objectContaining({ environment }));
    expect(createTransport).toHaveBeenNthCalledWith(2, expect.objectContaining({ environment }));
    expect(resume.openCalls).toEqual([
      expect.objectContaining({ kind: "resume", sessionId: create.sessionId }),
    ]);
    await resumed.value.close();
  });

  it("maps SDK permissions and streamed output into a completed Host Turn", async () => {
    const transport = new FakeTransport();
    transport.runTurnImplementation = async (onEvent, onPermission) => {
      const approval = onPermission({ toolName: "run_shell_command", input: { command: "git status" } });
      await vi.waitFor(() => expect(events.some((output) => (output as { kind?: string }).kind === "interaction")).toBe(true));
      const interaction = events.find((output) => (output as { kind?: string }).kind === "interaction") as {
        interaction: { interactionId: string };
      };
      const responded = await session!.execute({
        type: "interaction.respond",
        interactionId: hostInteractionIdSchema.parse(interaction.interaction.interactionId),
        response: { type: "approval", actionId: "allow" },
      });
      expect(responded).toEqual({ ok: true, value: { accepted: true } });
      expect(await approval).toEqual({ behavior: "allow", updatedInput: { command: "git status" } });
      onEvent({ type: "agent.text", text: "done" });
      onEvent({ type: "tool.call", callId: "tool-1", title: "run_shell_command", kind: "execute", rawInput: { command: "git status" } });
      onEvent({ type: "tool.update", callId: "tool-1", status: "completed", rawOutput: "clean" });
      onEvent({ type: "usage", metadata: { usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } });
      return { status: "succeeded" };
    };
    const { adapter } = adapterFor(transport);
    const opened = await adapter.open({ kind: "create", cwd: "/tmp" });
    if (!opened.ok) throw new Error("open failed");
    const session = opened.value;
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
    expect(events.some((output) => (output as { event?: { type?: string } }).event?.type === "session.usage.changed")).toBe(true);
    await session.close();
  });
});
