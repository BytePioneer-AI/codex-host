import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type {
  HarnessModelRef,
  HarnessOutput,
  HarnessPermissionModeId,
  HarnessThinkingOptionId,
  HostInteraction,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  KiroTransportError,
  type KiroOpenInput,
  type KiroOpenResult,
  type KiroTransportEvent,
} from "../src/acp-transport.js";
import { KiroExecutableError } from "../src/command.js";
import {
  KiroAdapter,
  type KiroAcpTransportLike,
} from "../src/kiro-adapter.js";
import type {
  KiroUserInputParams,
  KiroUserInputResult,
} from "../src/projection.js";

class FakeKiroTransport implements KiroAcpTransportLike {
  sessionId = "test-session-kiro";
  stderrTail?: string;

  readonly openCalls: KiroOpenInput[] = [];
  readonly configCalls: Array<{ id: string; value: string }> = [];
  readonly extensionRequests: Array<{ method: string; params: Record<string, unknown> }> = [];
  cancelled = false;
  closed = false;
  compactCalled = false;

  inspectResult: unknown = {
    configOptions: [
      {
        id: "model",
        currentValue: "claude-sonnet-4.5",
        options: [
          { value: "claude-haiku-4.5", label: "Haiku" },
          { value: "claude-sonnet-4.5", label: "Sonnet" },
        ],
      },
    ],
  };

  openResult: KiroOpenResult = {
    sessionId: "test-session-kiro",
    configOptions: [
      {
        id: "model",
        currentValue: "claude-sonnet-4.5",
        options: [
          { value: "claude-haiku-4.5", label: "Haiku" },
          { value: "claude-sonnet-4.5", label: "Sonnet" },
        ],
      },
    ],
  };

  inspectError?: Error;
  openError?: Error;
  eventsToEmit: KiroTransportEvent[] = [];
  permissionToRequest?: RequestPermissionRequest;
  questionToRequest?: KiroUserInputParams;
  blockRunTurn = false;

  async inspect(): Promise<unknown> {
    if (this.inspectError) throw this.inspectError;
    return this.inspectResult;
  }

  async open(input: KiroOpenInput): Promise<KiroOpenResult> {
    this.openCalls.push(input);
    if (this.openError) throw this.openError;
    return this.openResult;
  }

  async setConfigOption(configId: string, value: string): Promise<unknown> {
    this.configCalls.push({ id: configId, value });
    return { status: "ok" };
  }

  async runTurn(
    _text: string,
    onEvent: (event: KiroTransportEvent) => void,
    onPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
    onQuestion: (params: KiroUserInputParams) => Promise<KiroUserInputResult>,
  ): Promise<unknown> {
    for (const event of this.eventsToEmit) {
      onEvent(event);
    }
    if (this.permissionToRequest) {
      await onPermission(this.permissionToRequest);
    }
    if (this.questionToRequest) {
      await onQuestion(this.questionToRequest);
    }
    if (this.blockRunTurn) {
      await new Promise((resolve) => {
        const interval = setInterval(() => {
          if (this.cancelled) {
            clearInterval(interval);
            resolve(undefined);
          }
        }, 10);
      });
    }
    return { stopReason: "end_turn" };
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }

  async compact(): Promise<unknown> {
    this.compactCalled = true;
    return { ok: true };
  }

  async sendExtensionRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.extensionRequests.push({ method, params });
    return { ok: true };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe("KiroAdapter", () => {
  const dummyBin = "/fake/bin/kiro-cli";

  describe("inspect()", () => {
    it("returns notInstalled when executable cannot be resolved", async () => {
      const adapter = new KiroAdapter(
        { command: dummyBin },
        {
          inspectInstallation: () => {
            throw new KiroExecutableError("Kiro CLI is not installed");
          },
          createTransport: () => new FakeKiroTransport(),
        },
      );

      const inspection = await adapter.inspect();
      expect(inspection.status).toBe("notInstalled");
    });

    it("returns ready with catalog and capabilities when executable is present", async () => {
      const fakeTransport = new FakeKiroTransport();
      const adapter = new KiroAdapter(
        { command: dummyBin },
        {
          inspectInstallation: () => undefined,
          createTransport: () => fakeTransport,
        },
      );

      const inspection = await adapter.inspect();
      expect(inspection.status).toBe("ready");
      if (inspection.status === "ready") {
        expect(inspection.catalog.models).toHaveLength(2);
        expect(inspection.catalog.thinkingOptions).toEqual([]);
        expect(inspection.capabilities.history.fork).toBe(true);
        expect(inspection.capabilities.history.rollbackLastTurn).toBe(true);
        expect(inspection.capabilities.configuration.selectThinkingOption).toBe(false);
      }
    });

    it("returns error with code authenticationRequired when transport reports auth failure", async () => {
      const fakeTransport = new FakeKiroTransport();
      fakeTransport.inspectError = new KiroTransportError("authenticationRequired", "Login required");
      const adapter = new KiroAdapter(
        { command: dummyBin },
        {
          inspectInstallation: () => undefined,
          createTransport: () => fakeTransport,
        },
      );

      const inspection = await adapter.inspect();
      expect(inspection.status).toBe("error");
      if (inspection.status === "error") {
        expect(inspection.error.code).toBe("authenticationRequired");
      }
    });
  });

  describe("open()", () => {
    it("rejects unattended-full-access execution policy as unsupported", async () => {
      const fakeTransport = new FakeKiroTransport();
      const adapter = new KiroAdapter(
        { command: dummyBin },
        { createTransport: () => fakeTransport },
      );

      const result = await adapter.open({
        kind: "create",
        cwd: "/workspace",
        executionPolicy: "unattended-full-access",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("unsupported");
      }
    });

    it("creates a new session and initializes model and autopilot", async () => {
      const fakeTransport = new FakeKiroTransport();
      const adapter = new KiroAdapter(
        { command: dummyBin },
        { createTransport: () => fakeTransport },
      );

      const result = await adapter.open({
        kind: "create",
        cwd: "/workspace",
        model: { id: "claude-haiku-4.5" as HarnessModelRef["id"] },
        permissionModeId: "supervised" as HarnessPermissionModeId,
      });

      expect(result.ok).toBe(true);
      expect(fakeTransport.openCalls).toHaveLength(1);
      expect(fakeTransport.openCalls[0]).toEqual({
        kind: "create",
        modelId: "claude-haiku-4.5",
        autopilot: "off",
      });

      if (result.ok) {
        const session = result.value;
        expect(session.initialState.effectiveModel?.id).toBe("claude-haiku-4.5");
        expect(session.initialState.effectivePermissionModeId).toBe("supervised");
      }
    });

    it("resumes an existing session", async () => {
      const fakeTransport = new FakeKiroTransport();
      const adapter = new KiroAdapter(
        { command: dummyBin },
        { createTransport: () => fakeTransport },
      );

      const nativeRef = nativeSessionRefSchema.parse({
        harnessId: harnessIdSchema.parse("kiro-cli"),
        nativeSessionId: "existing-session-456",
        formatVersion: 1,
      });

      const result = await adapter.open({
        kind: "resume",
        cwd: "/workspace",
        nativeRef,
        permissionModeId: "autopilot" as HarnessPermissionModeId,
      });

      expect(result.ok).toBe(true);
      expect(fakeTransport.openCalls[0]).toEqual({
        kind: "resume",
        sessionId: "existing-session-456",
        autopilot: "on",
      });
    });

    it("returns sessionNotFound when source session for fork does not exist", async () => {
      const fakeTransport = new FakeKiroTransport();
      const sourceRef = nativeSessionRefSchema.parse({
        harnessId: harnessIdSchema.parse("kiro-cli"),
        nativeSessionId: "nonexistent-sess",
        formatVersion: 1,
      });
      const checkpoint = nativeCheckpointRefSchema.parse({
        harnessId: harnessIdSchema.parse("kiro-cli"),
        nativeSessionId: "nonexistent-sess",
        checkpointId: "e1",
        formatVersion: 1,
      });

      const adapter = new KiroAdapter(
        { command: dummyBin },
        {
          createTransport: () => fakeTransport,
          locateSession: async () => null,
        },
      );

      const result = await adapter.open({
        kind: "fork",
        cwd: "/workspace",
        sourceRef,
        checkpoint,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("sessionNotFound");
      }
    });
  });

  describe("KiroSession execution", () => {
    it("handles model selection, permission mode selection, and rejects thinking selection", async () => {
      const fakeTransport = new FakeKiroTransport();
      const adapter = new KiroAdapter(
        { command: dummyBin },
        { createTransport: () => fakeTransport },
      );

      const openResult = await adapter.open({
        kind: "create",
        cwd: "/workspace",
      });
      expect(openResult.ok).toBe(true);
      if (!openResult.ok) return;

      const session = openResult.value;

      // Select model
      const modelRes = await session.execute({
        type: "model.select",
        model: { id: "claude-haiku-4.5" as HarnessModelRef["id"] },
      });
      expect(modelRes.ok).toBe(true);
      expect(fakeTransport.configCalls).toContainEqual({
        id: "model",
        value: "claude-haiku-4.5",
      });

      // Select permission mode
      const permRes = await session.execute({
        type: "permissionMode.select",
        permissionModeId: "supervised" as HarnessPermissionModeId,
      });
      expect(permRes.ok).toBe(true);
      expect(fakeTransport.configCalls).toContainEqual({
        id: "autopilot",
        value: "off",
      });

      // Select thinking option -> rejected with unsupported
      const thinkingRes = await session.execute({
        type: "thinking.select",
        thinkingOptionId: "high" as HarnessThinkingOptionId,
      });
      expect(thinkingRes.ok).toBe(false);
      if (!thinkingRes.ok) {
        expect(thinkingRes.error.code).toBe("unsupported");
      }
    });

    it("cancels active turn via transport", async () => {
      const fakeTransport = new FakeKiroTransport();
      fakeTransport.blockRunTurn = true;

      const adapter = new KiroAdapter(
        { command: dummyBin },
        { createTransport: () => fakeTransport },
      );

      const openResult = await adapter.open({ kind: "create", cwd: "/workspace" });
      if (!openResult.ok) return;

      const session = openResult.value;
      const turnId = hostTurnIdSchema.parse("turn-cancel-test");

      // Start turn
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Long running task" }],
      });

      // Cancel turn while running
      const cancelRes = await session.execute({
        type: "turn.cancel",
        turnId,
      });

      expect(cancelRes.ok).toBe(true);
      expect(fakeTransport.cancelled).toBe(true);
    });

    it("executes /compact slash command via transport.compact()", async () => {
      const fakeTransport = new FakeKiroTransport();
      const adapter = new KiroAdapter(
        { command: dummyBin },
        { createTransport: () => fakeTransport },
      );

      const openResult = await adapter.open({ kind: "create", cwd: "/workspace" });
      if (!openResult.ok) return;

      const session = openResult.value;
      const cmdList = await session.commands.list();
      expect(cmdList.ok).toBe(true);

      const turnId = hostTurnIdSchema.parse("cmd-turn-1");
      const execRes = await session.commands.execute({
        turnId,
        commandId: "kiro.compact",
      });
      expect(execRes.ok).toBe(true);
      expect(fakeTransport.compactCalled).toBe(true);
    });

    it("runs turn and emits streaming events", async () => {
      const fakeTransport = new FakeKiroTransport();
      fakeTransport.eventsToEmit = [
        { type: "agent.text", text: "Hello " },
        { type: "agent.text", text: "world!" },
        {
          type: "tool.call",
          callId: "call-1",
          name: "my_tool",
          rawInput: { query: "test" },
          status: "running",
        },
        {
          type: "tool.update",
          callId: "call-1",
          name: "my_tool",
          status: "completed",
          rawOutput: "result",
        },
      ];

      const adapter = new KiroAdapter(
        { command: dummyBin },
        { createTransport: () => fakeTransport },
      );

      const openResult = await adapter.open({ kind: "create", cwd: "/workspace" });
      if (!openResult.ok) return;

      const session = openResult.value;
      const outputs: HarnessOutput[] = [];
      const outputPromise = (async () => {
        for await (const out of session.outputs) {
          outputs.push(out);
        }
      })();

      const turnId = hostTurnIdSchema.parse("turn-run-1");
      const turnRes = await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Say hello" }],
      });

      expect(turnRes.ok).toBe(true);

      // Wait a tick for background async execution
      await new Promise((resolve) => setTimeout(resolve, 50));
      await session.close();
      await outputPromise;

      const events = outputs.filter((o) => o.kind === "event").map((o) => o.event);
      const types = events.map((e) => e.type);

      expect(types).toContain("turn.started");
      expect(types).toContain("item.started");
      expect(types).toContain("item.updated");
      expect(types).toContain("turn.completed");
    });

    it("handles permission interaction response during turn", async () => {
      const fakeTransport = new FakeKiroTransport();

      fakeTransport.permissionToRequest = {
        sessionId: "sess-test",
        options: [
          { optionId: "opt-allow", name: "Allow Once", kind: "allow_once" },
          { optionId: "opt-deny", name: "Deny", kind: "reject_once" },
        ],
      };

      const adapter = new KiroAdapter(
        { command: dummyBin },
        { createTransport: () => fakeTransport },
      );

      const openResult = await adapter.open({ kind: "create", cwd: "/workspace" });
      if (!openResult.ok) return;

      const session = openResult.value;
      let capturedInteraction: HostInteraction | undefined;

      const outputPromise = (async () => {
        for await (const out of session.outputs) {
          if (out.kind === "interaction") {
            capturedInteraction = out.interaction;
            // Respond to interaction
            await session.execute({
              type: "interaction.respond",
              interactionId: out.interaction.interactionId,
              response: {
                type: "approval",
                actionId: "opt-allow",
              },
            });
          }
        }
      })();

      const turnId = hostTurnIdSchema.parse("turn-perm-1");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Execute tool requiring approval" }],
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      await session.close();
      await outputPromise;

      expect(capturedInteraction).toBeDefined();
      expect(capturedInteraction?.type).toBe("approval");
    });
  });
});
