import { describe, expect, it, vi } from "vitest";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import {
  harnessInspectionSchema,
  harnessPermissionModeIdSchema,
  hostTurnIdSchema,
  jsonValueSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";

import { QoderAdapter } from "../src/qoder-adapter.js";
import {
  QODER_SDK_CUSTOM_BASE_URL_BYOK,
  QoderExecutableError,
  resolveQoderExecutable,
} from "../src/qoder-command.js";
import { mapQoderException, mapQoderExitCode, mapQoderResultError } from "../src/qoder-errors.js";
import {
  decodeQoderModelRef,
  encodeQoderModelRef,
  parseQoderModelCatalog,
} from "../src/qoder-models.js";
import type {
  QoderModelInfo,
  QoderOptions,
  QoderQuery,
  QoderQueryFactory,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "../src/qoder-sdk-types.js";
import { QoderUsageTracker } from "../src/qoder-usage.js";

class FakeQoderQuery implements QoderQuery {
  readonly interrupt = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  });
  readonly getAvailableModels = vi.fn(async (): Promise<QoderModelInfo[]> => [
    { value: "default", displayName: "Default", description: "Default Qoder model" },
    { value: "qoder-fast", displayName: "Qoder Fast", description: "Fast Qoder model" },
  ]);
  readonly getContextUsage = vi.fn(async () => ({
    contextWindow: { usedPercentage: 45 },
    totalTokens: 450,
    maxTokens: 1000,
  }));
  readonly setModel = vi.fn(async () => undefined);
  readonly setPermissionMode = vi.fn(async () => undefined);

  #closed = false;
  #messages: SDKMessage[] = [];
  #waiters: Array<(result: IteratorResult<SDKMessage>) => void> = [];

  push(message: SDKMessage): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value: message });
    } else {
      this.#messages.push(message);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const message = this.#messages.shift();
        if (message) return Promise.resolve({ done: false, value: message });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

class OutputCollector {
  readonly outputs: HarnessOutput[] = [];
  readonly #waiters: Array<(output: HarnessOutput) => void> = [];

  constructor(stream: AsyncIterable<HarnessOutput>) {
    (async () => {
      try {
        for await (const out of stream) {
          this.outputs.push(out);
          const waiter = this.#waiters.shift();
          if (waiter) waiter(out);
        }
      } catch {
        // Stream ended or errored
      }
    })();
  }

  async waitFor(
    predicate: (output: HarnessOutput) => boolean,
    timeoutMs = 2000,
  ): Promise<HarnessOutput> {
    const existing = this.outputs.find(predicate);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timeout waiting for output event")),
        timeoutMs,
      );
      const check = (out: HarnessOutput) => {
        if (predicate(out)) {
          clearTimeout(timer);
          resolve(out);
        } else {
          this.#waiters.push(check);
        }
      };
      this.#waiters.push(check);
    });
  }
}

describe("QoderAdapter", () => {
  describe("inspect()", () => {
    it("returns notInstalled when executable is not found", async () => {
      const adapter = new QoderAdapter({
        resolveExecutable: () => {
          throw new QoderExecutableError("Qoder CLI is not installed");
        },
      });

      const inspection = await adapter.inspect();
      expect(inspection.status).toBe("notInstalled");
      if (inspection.status === "notInstalled") {
        expect(inspection.error.code).toBe("notInstalled");
      }
    });

    it("returns ready when executable is resolved and caches result", async () => {
      let resolveCalls = 0;
      const adapter = new QoderAdapter({
        resolveExecutable: () => {
          resolveCalls++;
          return "D:/tools/qodercli.exe";
        },
      });

      const inspection1 = await adapter.inspect({ cwd: "D:/project" });
      expect(inspection1.status).toBe("ready");
      if (inspection1.status === "ready") {
        expect(inspection1.catalog.models).toEqual([]);
        expect(inspection1.catalog.defaultModel).toBeUndefined();
        expect(Object.hasOwn(inspection1.catalog, "defaultModel")).toBe(false);
        expect(inspection1.capabilities.configuration.selectModel).toBe(true);
        expect(inspection1.capabilities.configuration.selectPermissionMode).toBe(true);
        expect(inspection1.capabilities.history.rollbackLastTurn).toBe(false);
        expect(inspection1.permissionModes?.modes).toHaveLength(5);
        expect(inspection1.permissionModes?.defaultModeId).toBe("default");
        expect(harnessInspectionSchema.parse(inspection1)).toEqual(inspection1);
        expect(jsonValueSchema.parse(inspection1)).toEqual(inspection1);
      }

      // Second call uses cached inspection
      const inspection2 = await adapter.inspect({ cwd: "D:/project" });
      expect(inspection2.status).toBe("ready");
      expect(resolveCalls).toBe(1);

      // Force refresh bypasses cache
      const inspection3 = await adapter.inspect({ cwd: "D:/project", refresh: true });
      expect(inspection3.status).toBe("ready");
      expect(resolveCalls).toBe(2);
    });

    it("dynamically returns models from queryFactory in inspect()", async () => {
      const fakeQuery = new FakeQoderQuery();
      let capturedOptions: QoderOptions | undefined;
      const adapter = new QoderAdapter({
        resolveExecutable: () => "D:/tools/qodercli.exe",
        queryFactory: (input) => {
          capturedOptions = input.options;
          return fakeQuery;
        },
      });

      const inspection = await adapter.inspect({ cwd: "D:/project" });
      expect(inspection.status).toBe("ready");
      if (inspection.status === "ready") {
        expect(inspection.catalog.models).toHaveLength(2);
        expect(inspection.catalog.defaultModel?.id).toBe(encodeQoderModelRef("default").id);
        expect(harnessInspectionSchema.parse(inspection)).toEqual(inspection);
      }
      expect(capturedOptions?.auth).toEqual({ type: "qodercli" });
      expect(capturedOptions?.env?.[QODER_SDK_CUSTOM_BASE_URL_BYOK]).toBe("1");
    });

    it("uses configured access-token auth for model probing", async () => {
      let capturedOptions: QoderOptions | undefined;
      const adapter = new QoderAdapter({
        environment: { QODER_PERSONAL_ACCESS_TOKEN: "token-123" },
        resolveExecutable: () => "D:/tools/qodercli.exe",
        queryFactory: (input) => {
          capturedOptions = input.options;
          return new FakeQoderQuery();
        },
      });

      await adapter.inspect({ cwd: "D:/project" });

      expect(capturedOptions?.auth).toEqual({
        type: "accessToken",
        accessToken: { envVar: "QODER_PERSONAL_ACCESS_TOKEN" },
      });
    });

    it("closes probeQuery in finally and returns empty catalog when getAvailableModels throws", async () => {
      const closeSpy = vi.fn(async () => undefined);
      const throwingQuery = {
        getAvailableModels: vi.fn(async () => {
          throw new Error("CLI connection failed");
        }),
        close: closeSpy,
      } as unknown as QoderQuery;

      const adapter = new QoderAdapter({
        resolveExecutable: () => "D:/tools/qodercli.exe",
        queryFactory: () => throwingQuery,
      });

      const inspection = await adapter.inspect({ cwd: "D:/project" });
      expect(inspection.status).toBe("ready");
      if (inspection.status === "ready") {
        expect(inspection.catalog.models).toEqual([]);
        expect(inspection.catalog.defaultModel).toBeUndefined();
      }
      expect(closeSpy).toHaveBeenCalledOnce();
    });
  });

  describe("open() session lifecycle", () => {
    it("opens session with create and resume, and rejects fork and rollbackLastTurn", async () => {
      const fakeQuery = new FakeQoderQuery();
      const adapter = new QoderAdapter({
        resolveExecutable: () => "D:/tools/qodercli.exe",
        queryFactory: () => fakeQuery,
      });

      // Create session
      const createResult = await adapter.open({
        kind: "create",
        cwd: "D:/project",
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;
      const session = createResult.value;
      expect(session.harnessId).toBe("qoder");
      expect(session.capabilities.configuration.selectModel).toBe(true);
      expect(session.capabilities.history.fork).toBe(false);

      // Resume session
      const resumeResult = await adapter.open({
        kind: "resume",
        cwd: "D:/project",
        nativeRef: nativeSessionRefSchema.parse({
          harnessId: "qoder",
          nativeSessionId: "session-12345",
          formatVersion: 1,
        }),
      });
      expect(resumeResult.ok).toBe(true);
      if (resumeResult.ok) {
        expect(resumeResult.value.initialState.nativeRef?.nativeSessionId).toBe("session-12345");
        await resumeResult.value.close();
      }

      // Fork session: typed unsupported error
      const forkResult = await adapter.open({
        kind: "fork",
        cwd: "D:/project",
        sourceRef: nativeSessionRefSchema.parse({
          harnessId: "qoder",
          nativeSessionId: "source-1",
          formatVersion: 1,
        }),
        checkpoint: nativeCheckpointRefSchema.parse({
          harnessId: "qoder",
          nativeSessionId: "source-1",
          checkpointId: "cp-1",
          formatVersion: 1,
        }),
      });
      expect(forkResult.ok).toBe(false);
      if (!forkResult.ok) {
        expect(forkResult.error.code).toBe("unsupported");
      }

      // RollbackLastTurn session: typed unsupported error
      const rollbackResult = await adapter.open({
        kind: "rollbackLastTurn",
        cwd: "D:/project",
        sourceRef: nativeSessionRefSchema.parse({
          harnessId: "qoder",
          nativeSessionId: "source-1",
          formatVersion: 1,
        }),
      });
      expect(rollbackResult.ok).toBe(false);
      if (!rollbackResult.ok) {
        expect(rollbackResult.error.code).toBe("unsupported");
      }

      await session.close();
      await adapter.close();
    });
  });

  describe("Multi-turn streaming & query persistence", () => {
    it("drives multiple turns through the same long-lived query instance", async () => {
      const fakeQuery = new FakeQoderQuery();
      let capturedOptions: QoderOptions | undefined;
      const queryFactory: QoderQueryFactory = (input) => {
        capturedOptions = input.options;
        return fakeQuery;
      };

      const adapter = new QoderAdapter({
        resolveExecutable: () => "D:/tools/qodercli.exe",
        queryFactory,
      });

      const openResult = await adapter.open({
        kind: "create",
        cwd: "D:/test-cwd",
      });
      expect(openResult.ok).toBe(true);
      if (!openResult.ok) return;
      const session = openResult.value;
      const collector = new OutputCollector(session.outputs);

      // Turn 1
      const turnId1 = hostTurnIdSchema.parse("turn-1");
      const startRes1 = await session.execute({
        type: "turn.start",
        turnId: turnId1,
        input: [{ type: "text", text: "Hello Qoder" }],
      });
      expect(startRes1.ok).toBe(true);

      fakeQuery.push({
        type: "system",
        subtype: "init",
        session_id: "qoder-session-real",
      } as unknown as SDKMessage);

      fakeQuery.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello user!" }],
        },
      } as SDKAssistantMessage);

      fakeQuery.push({
        type: "result",
        subtype: "success",
        total_credits: 1.2,
      } as SDKResultMessage);

      await collector.waitFor(
        (o) =>
          o.kind === "event" && o.event.type === "turn.completed" && o.event.turnId === turnId1,
      );

      // Turn 2 on the SAME session and query!
      const turnId2 = hostTurnIdSchema.parse("turn-2");
      const startRes2 = await session.execute({
        type: "turn.start",
        turnId: turnId2,
        input: [{ type: "text", text: "Tell me more" }],
      });
      expect(startRes2.ok).toBe(true);

      fakeQuery.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is more info." }],
        },
      } as SDKAssistantMessage);

      fakeQuery.push({
        type: "result",
        subtype: "success",
        total_credits: 2.5,
      } as SDKResultMessage);

      await collector.waitFor(
        (o) =>
          o.kind === "event" && o.event.type === "turn.completed" && o.event.turnId === turnId2,
      );

      // Verify query was NOT closed between turns
      expect(fakeQuery.close).not.toHaveBeenCalled();
      expect(capturedOptions?.sessionId).toBeDefined();

      await session.close();
      expect(fakeQuery.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("Partial delta deduplication", () => {
    it("deduplicates streamed text deltas when assistant message arrives", async () => {
      const fakeQuery = new FakeQoderQuery();
      const adapter = new QoderAdapter({
        resolveExecutable: () => "D:/tools/qodercli.exe",
        queryFactory: () => fakeQuery,
      });

      const openResult = await adapter.open({ kind: "create", cwd: "D:/workspace" });
      if (!openResult.ok) throw new Error("open failed");
      const session = openResult.value;
      const collector = new OutputCollector(session.outputs);

      const turnId = hostTurnIdSchema.parse("turn-stream");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Stream test" }],
      });

      // Emit deltas: "Hello " then "world"
      fakeQuery.push({
        type: "stream_event",
        text_delta: "Hello ",
      } as unknown as SDKMessage);

      fakeQuery.push({
        type: "stream_event",
        text_delta: "world",
      } as unknown as SDKMessage);

      // Now assistant message confirms "Hello world"
      fakeQuery.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
        },
      } as SDKAssistantMessage);

      fakeQuery.push({
        type: "result",
        subtype: "success",
      } as SDKResultMessage);

      await collector.waitFor((o) => o.kind === "event" && o.event.type === "turn.completed");

      // Verify that deltas were appended and final message did NOT duplicate
      const updates = collector.outputs.filter(
        (o) => o.kind === "event" && o.event.type === "item.updated",
      );
      const appends = updates.map((u) =>
        u.kind === "event" &&
        u.event.type === "item.updated" &&
        u.event.update.type === "text.append"
          ? u.event.update.text
          : undefined,
      );
      expect(appends).toEqual(["Hello ", "world"]);

      const completed = collector.outputs.find(
        (o) => o.kind === "event" && o.event.type === "item.completed",
      );
      expect(completed).toBeDefined();
      if (
        completed?.kind === "event" &&
        completed.event.type === "item.completed" &&
        completed.event.snapshot.item.type === "agentMessage"
      ) {
        expect(completed.event.snapshot.item.text).toBe("Hello world");
      }

      await session.close();
    });
  });

  describe("Cancellation via interrupt()", () => {
    it("invokes query.interrupt() and marks turn cancelled without closing session", async () => {
      const fakeQuery = new FakeQoderQuery();
      const adapter = new QoderAdapter({
        resolveExecutable: () => "D:/tools/qodercli.exe",
        queryFactory: () => fakeQuery,
      });

      const openResult = await adapter.open({ kind: "create", cwd: "D:/workspace" });
      if (!openResult.ok) throw new Error("open failed");
      const session = openResult.value;
      const collector = new OutputCollector(session.outputs);

      const turnId = hostTurnIdSchema.parse("turn-cancel");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Long operation" }],
      });

      // Cancel turn
      const cancelResult = await session.execute({
        type: "turn.cancel",
        turnId,
      });
      expect(cancelResult.ok).toBe(true);

      expect(fakeQuery.interrupt).toHaveBeenCalledTimes(1);

      await collector.waitFor(
        (o) =>
          o.kind === "event" &&
          o.event.type === "turn.completed" &&
          o.event.outcome.status === "cancelled",
      );

      // Session is still open and can run another turn!
      const turnId2 = hostTurnIdSchema.parse("turn-after-cancel");
      const start2 = await session.execute({
        type: "turn.start",
        turnId: turnId2,
        input: [{ type: "text", text: "Proceed again" }],
      });
      expect(start2.ok).toBe(true);

      fakeQuery.push({
        type: "result",
        subtype: "success",
      } as SDKResultMessage);

      await collector.waitFor(
        (o) =>
          o.kind === "event" && o.event.type === "turn.completed" && o.event.turnId === turnId2,
      );

      await session.close();
    });

    it("completes active streaming message and reasoning items on turn.cancel", async () => {
      const fakeQuery = new FakeQoderQuery();
      const adapter = new QoderAdapter({
        resolveExecutable: () => "D:/tools/qodercli.exe",
        queryFactory: () => fakeQuery,
      });

      const openResult = await adapter.open({ kind: "create", cwd: "D:/workspace" });
      if (!openResult.ok) throw new Error("open failed");
      const session = openResult.value;
      const collector = new OutputCollector(session.outputs);

      const turnId = hostTurnIdSchema.parse("turn-streaming-cancel");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Start streaming" }],
      });

      // Stream thinking delta
      fakeQuery.push({
        type: "stream_event",
        thinking_delta: "Thinking in progress...",
      } as unknown as SDKMessage);

      // Stream text delta
      fakeQuery.push({
        type: "stream_event",
        text_delta: "Generating text...",
      } as unknown as SDKMessage);

      await collector.waitFor(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.updated" &&
          o.event.update.type === "text.append",
      );

      // Cancel turn while streaming items are active
      const cancelResult = await session.execute({
        type: "turn.cancel",
        turnId,
      });
      expect(cancelResult.ok).toBe(true);

      const reasoningCompleted = await collector.waitFor(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.completed" &&
          o.event.snapshot.item.type === "reasoning",
      );
      if (
        reasoningCompleted.kind === "event" &&
        reasoningCompleted.event.type === "item.completed" &&
        reasoningCompleted.event.snapshot.item.type === "reasoning"
      ) {
        expect(reasoningCompleted.event.snapshot.outcome.status).toBe("cancelled");
        expect(reasoningCompleted.event.snapshot.item.text).toBe("Thinking in progress...");
      }

      const messageCompleted = await collector.waitFor(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.completed" &&
          o.event.snapshot.item.type === "agentMessage",
      );
      if (
        messageCompleted.kind === "event" &&
        messageCompleted.event.type === "item.completed" &&
        messageCompleted.event.snapshot.item.type === "agentMessage"
      ) {
        expect(messageCompleted.event.snapshot.outcome.status).toBe("cancelled");
        expect(messageCompleted.event.snapshot.item.text).toBe("Generating text...");
      }

      await collector.waitFor(
        (o) =>
          o.kind === "event" &&
          o.event.type === "turn.completed" &&
          o.event.outcome.status === "cancelled",
      );

      await session.close();
      await adapter.close();
    });
  });

  describe("Tool approval interaction", () => {
    it("bridges tool approval to HostApprovalInteraction with allow and deny", async () => {
      let canUseToolCb: NonNullable<QoderOptions["canUseTool"]> | undefined;
      const fakeQuery = new FakeQoderQuery();
      const adapter = new QoderAdapter({
        resolveExecutable: () => "D:/tools/qodercli.exe",
        queryFactory: (input) => {
          canUseToolCb = input.options?.canUseTool;
          return fakeQuery;
        },
      });

      const openResult = await adapter.open({ kind: "create", cwd: "D:/workspace" });
      if (!openResult.ok) throw new Error("open failed");
      const session = openResult.value;
      const collector = new OutputCollector(session.outputs);

      const turnId = hostTurnIdSchema.parse("turn-approval");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Run command" }],
      });

      if (!canUseToolCb) throw new Error("canUseToolCb not set");

      // Trigger canUseTool from SDK
      const abortController = new AbortController();
      const permPromise = canUseToolCb(
        "Bash",
        { command: "rm -rf /" },
        { signal: abortController.signal, toolUseID: "tool-bash-1" },
      );

      const interactionEvent = await collector.waitFor(
        (o) => o.kind === "interaction" && o.interaction.type === "approval",
      );
      if (interactionEvent.kind !== "interaction") throw new Error("Expected interaction");
      const interactionId = interactionEvent.interaction.interactionId;

      // Respond allowOnce
      const respondRes = await session.execute({
        type: "interaction.respond",
        interactionId,
        response: {
          type: "approval",
          actionId: "allowOnce",
        },
      });
      expect(respondRes.ok).toBe(true);

      const permResult = await permPromise;
      expect(permResult.behavior).toBe("allow");

      await collector.waitFor(
        (o) =>
          o.kind === "event" &&
          o.event.type === "interaction.closed" &&
          o.event.reason === "responded",
      );

      await session.close();
    });
  });

  describe("AskUserQuestion interaction with full question prompt keying", () => {
    it("bridges AskUserQuestion and formats answers dictionary keyed by full question text", async () => {
      let canUseToolCb: NonNullable<QoderOptions["canUseTool"]> | undefined;
      const fakeQuery = new FakeQoderQuery();
      const adapter = new QoderAdapter({
        resolveExecutable: () => "D:/tools/qodercli.exe",
        queryFactory: (input) => {
          canUseToolCb = input.options?.canUseTool;
          return fakeQuery;
        },
      });

      const openResult = await adapter.open({ kind: "create", cwd: "D:/workspace" });
      if (!openResult.ok) throw new Error("open failed");
      const session = openResult.value;
      const collector = new OutputCollector(session.outputs);

      const turnId = hostTurnIdSchema.parse("turn-question");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Help me choose" }],
      });

      const questionPrompt = "Which environment would you like to deploy to?";
      const abortController = new AbortController();

      if (!canUseToolCb) throw new Error("canUseToolCb not set");

      const questionPromise = canUseToolCb(
        "AskUserQuestion",
        {
          questions: [
            {
              question: questionPrompt,
              options: ["Production", "Staging"],
              multiSelect: false,
            },
          ],
        },
        { signal: abortController.signal, toolUseID: "tool-question-1" },
      );

      const interactionEvent = await collector.waitFor(
        (o) => o.kind === "interaction" && o.interaction.type === "question",
      );
      if (
        interactionEvent.kind !== "interaction" ||
        interactionEvent.interaction.type !== "question"
      ) {
        throw new Error("Expected question interaction");
      }
      const interaction = interactionEvent.interaction;
      expect(interaction.questions[0]?.prompt).toBe(questionPrompt);

      // Respond with selected answer
      const respondRes = await session.execute({
        type: "interaction.respond",
        interactionId: interaction.interactionId,
        response: {
          type: "question",
          answers: {
            [questionPrompt]: ["Production"],
          },
        },
      });
      expect(respondRes.ok).toBe(true);

      const result = await questionPromise;
      expect(result.behavior).toBe("allow");
      if (result.behavior === "allow") {
        expect(result.updatedInput?.answers).toEqual({
          [questionPrompt]: "Production",
        });
      }

      await session.close();
    });
  });

  describe("Error classification", () => {
    it("maps result error_code correctly", () => {
      const authErr = mapQoderResultError({
        type: "result",
        subtype: "error_during_execution",
        error_code: 105,
      } as unknown as SDKResultMessage);
      expect(authErr.code).toBe("authenticationRequired");
      expect(authErr.retryable).toBe(false);

      const unsuppErr = mapQoderResultError({
        type: "result",
        subtype: "error_during_execution",
        error_code: 430,
        errors: ["Feature not available"],
      } as unknown as SDKResultMessage);
      expect(unsuppErr.code).toBe("unsupported");

      const retryableErr = mapQoderResultError({
        type: "result",
        subtype: "error_during_execution",
        error_code: 500,
      } as unknown as SDKResultMessage);
      expect(retryableErr.code).toBe("nativeFailure");
      expect(retryableErr.retryable).toBe(true);

      const limitErr = mapQoderResultError({
        type: "result",
        subtype: "error_during_execution",
        error_code: 47902,
      } as unknown as SDKResultMessage);
      expect(limitErr.code).toBe("invalidState");
    });

    it("maps CLI exit codes correctly", () => {
      expect(mapQoderExitCode(41).code).toBe("authenticationRequired");
      expect(mapQoderExitCode(42).code).toBe("invalidRequest");
      expect(mapQoderExitCode(44).code).toBe("nativeFailure");
      expect(mapQoderExitCode(52).code).toBe("nativeFailure");
      expect(mapQoderExitCode(53).code).toBe("invalidState");
    });

    it("maps SDK exceptions correctly", () => {
      expect(mapQoderException(new Error("Login required: missing auth token")).code).toBe(
        "authenticationRequired",
      );
      expect(mapQoderException(new Error("Session not found with id 123")).code).toBe(
        "sessionNotFound",
      );
      expect(mapQoderException(new Error("Unsupported method call")).code).toBe("unsupported");
      expect(mapQoderException(new Error("Protocol mismatch version")).code).toBe("protocolError");
    });
  });

  describe("Usage credit snapshot mapping", () => {
    it("retains latest total_credits snapshot without accumulating across turns", () => {
      const tracker = new QoderUsageTracker();

      tracker.observeResult({
        type: "result",
        subtype: "success",
        total_credits: 5.5,
        usage: { input_tokens: 100, output_tokens: 50 },
      } as unknown as SDKResultMessage);

      const snap1 = tracker.snapshot();
      expect(snap1?.totalCredits).toBe(5.5);
      expect(snap1?.inputTokens).toBe(100);

      // Turn 2 result comes in with cumulative credits of 8.2
      tracker.observeResult({
        type: "result",
        subtype: "success",
        total_credits: 8.2,
        usage: { input_tokens: 120, output_tokens: 60 },
      } as unknown as SDKResultMessage);

      const snap2 = tracker.snapshot();
      // Must NOT be 13.7! Must be latest snapshot 8.2!
      expect(snap2?.totalCredits).toBe(8.2);
      expect(snap2?.inputTokens).toBe(120);
    });
  });

  describe("Executable discovery", () => {
    it("resolves the Windows npm shim to Qoder's JavaScript entrypoint", () => {
      const shim = String.raw`C:\npm\qodercli.cmd`;
      const entrypoint = String.raw`C:\npm\node_modules\@qoder-ai\qodercli\bundle\qodercli.js`;

      expect(
        resolveQoderExecutable(
          { command: shim, environment: {}, platform: "win32" },
          { isExecutable: (candidate) => candidate === entrypoint },
        ),
      ).toBe(entrypoint);
    });
  });

  describe("Model catalog encoding and decoding", () => {
    it("encodes and decodes model refs to opaque transport-safe strings", () => {
      const modelRef = encodeQoderModelRef("claude-3-7-sonnet@20250219/thinking");
      expect(/^[A-Za-z0-9._~-]+$/.test(modelRef.id)).toBe(true);

      const decoded = decodeQoderModelRef(modelRef);
      expect(decoded).toBe("claude-3-7-sonnet@20250219/thinking");
    });

    it("parses model catalog from dynamic model list", () => {
      const catalog = parseQoderModelCatalog([
        { value: "qoder-1", displayName: "Qoder Model 1" },
        { value: "qoder-2", displayName: "Qoder Model 2" },
      ]);
      expect(catalog.models.length).toBe(2);
      expect(catalog.defaultModel?.id).toBe(encodeQoderModelRef("qoder-1").id);
      expect(catalog.thinkingOptions).toEqual([]);
    });

    it("preserves native groups, availability, and server default", () => {
      const catalog = parseQoderModelCatalog([
        {
          value: "qoder-default",
          displayName: "Default model",
          source: "system",
          isEnabled: false,
        },
        {
          value: "qoder-new",
          displayName: "New model",
          source: "system",
          isNew: true,
          isDefault: true,
          isEnabled: true,
        },
        {
          value: "qoder-custom/provider-model",
          displayName: "Custom model",
          source: "custom",
          tags: ["custom-provider"],
          isEnabled: true,
        },
      ]);

      expect(catalog.models).toMatchObject([
        { label: "Default model", group: "default", selectable: false },
        { label: "New model", group: "new", selectable: true },
        { label: "Custom model", group: "custom", selectable: true },
      ]);
      expect(catalog.defaultModel).toEqual(encodeQoderModelRef("qoder-new"));
    });

    it("returns empty catalog when dynamic models are unavailable or empty", () => {
      const catalogEmpty = parseQoderModelCatalog([]);
      expect(catalogEmpty.models).toEqual([]);
      expect(catalogEmpty.defaultModel).toBeUndefined();
      expect(Object.hasOwn(catalogEmpty, "defaultModel")).toBe(false);

      const catalogUndefined = parseQoderModelCatalog(undefined);
      expect(catalogUndefined.models).toEqual([]);
      expect(catalogUndefined.defaultModel).toBeUndefined();
      expect(Object.hasOwn(catalogUndefined, "defaultModel")).toBe(false);
    });
  });

  describe("Session configuration forwarding", () => {
    it("forwards environment, model, permissionMode, and resume options to SDK", async () => {
      let capturedOptions: QoderOptions | undefined;
      const fakeQuery = new FakeQoderQuery();
      const adapter = new QoderAdapter({
        resolveExecutable: () => "D:/tools/qodercli.exe",
        queryFactory: (input) => {
          capturedOptions = input.options;
          return fakeQuery;
        },
      });

      const yoloMode = harnessPermissionModeIdSchema.parse("yolo");
      const modelRef = encodeQoderModelRef("ultimate");

      // Test create with environment, model, permissionMode
      const createRes = await adapter.open({
        kind: "create",
        cwd: "D:/workspace",
        environment: {
          CUSTOM_VAR: "custom_value",
          QODER_PERSONAL_ACCESS_TOKEN: "token-123",
        },
        model: modelRef,
        permissionModeId: yoloMode,
      });

      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;

      expect(capturedOptions?.env).toEqual({
        CUSTOM_VAR: "custom_value",
        QODER_PERSONAL_ACCESS_TOKEN: "token-123",
        [QODER_SDK_CUSTOM_BASE_URL_BYOK]: "1",
      });
      expect(capturedOptions?.model).toBe("ultimate");
      expect(capturedOptions?.permissionMode).toBe("yolo");
      expect(capturedOptions?.allowDangerouslySkipPermissions).toBe(true);
      await createRes.value.close();

      // Test resume forwards resume sessionId
      const resumeRes = await adapter.open({
        kind: "resume",
        cwd: "D:/workspace",
        nativeRef: nativeSessionRefSchema.parse({
          harnessId: "qoder",
          nativeSessionId: "session-resume-abc",
          formatVersion: 1,
        }),
      });

      expect(resumeRes.ok).toBe(true);
      if (!resumeRes.ok) return;
      expect(capturedOptions?.resume).toBe("session-resume-abc");
      await resumeRes.value.close();
      await adapter.close();
    });
  });

  describe("Thinking delta streaming & isolation", () => {
    it("routes thinking stream events to reasoning item instead of agentMessage", async () => {
      const fakeQuery = new FakeQoderQuery();
      const adapter = new QoderAdapter({
        resolveExecutable: () => "D:/tools/qodercli.exe",
        queryFactory: () => fakeQuery,
      });

      const openResult = await adapter.open({ kind: "create", cwd: "D:/workspace" });
      if (!openResult.ok) throw new Error("open failed");
      const session = openResult.value;
      const collector = new OutputCollector(session.outputs);

      const turnId = hostTurnIdSchema.parse("turn-thinking");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Reason about this" }],
      });

      // Stream thinking delta
      fakeQuery.push({
        type: "stream_event",
        thinking_delta: "I am analyzing ",
      } as unknown as SDKMessage);

      fakeQuery.push({
        type: "stream_event",
        thinking_delta: "the codebase.",
      } as unknown as SDKMessage);

      // Stream text delta
      fakeQuery.push({
        type: "stream_event",
        text_delta: "Here is the answer.",
      } as unknown as SDKMessage);

      // Assistant message confirmation
      fakeQuery.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I am analyzing the codebase." },
            { type: "text", text: "Here is the answer." },
          ],
        },
      } as SDKAssistantMessage);

      fakeQuery.push({
        type: "result",
        subtype: "success",
      } as SDKResultMessage);

      await collector.waitFor((o) => o.kind === "event" && o.event.type === "turn.completed");

      const reasoningStarted = collector.outputs.find(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.started" &&
          o.event.item.type === "reasoning",
      );
      expect(reasoningStarted).toBeDefined();

      const reasoningCompleted = collector.outputs.find(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.completed" &&
          o.event.snapshot.item.type === "reasoning",
      );
      expect(reasoningCompleted).toBeDefined();
      if (
        reasoningCompleted?.kind === "event" &&
        reasoningCompleted.event.type === "item.completed" &&
        reasoningCompleted.event.snapshot.item.type === "reasoning"
      ) {
        expect(reasoningCompleted.event.snapshot.item.text).toBe("I am analyzing the codebase.");
      }

      const messageCompleted = collector.outputs.find(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.completed" &&
          o.event.snapshot.item.type === "agentMessage",
      );
      expect(messageCompleted).toBeDefined();
      if (
        messageCompleted?.kind === "event" &&
        messageCompleted.event.type === "item.completed" &&
        messageCompleted.event.snapshot.item.type === "agentMessage"
      ) {
        expect(messageCompleted.event.snapshot.item.text).toBe("Here is the answer.");
      }

      await session.close();
      await adapter.close();
    });
  });

  describe("Tool use & tool result lifecycle", () => {
    it("waits for tool_result before completing toolExecution item and reflects failure", async () => {
      const fakeQuery = new FakeQoderQuery();
      const adapter = new QoderAdapter({
        resolveExecutable: () => "D:/tools/qodercli.exe",
        queryFactory: () => fakeQuery,
      });

      const openResult = await adapter.open({ kind: "create", cwd: "D:/workspace" });
      if (!openResult.ok) throw new Error("open failed");
      const session = openResult.value;
      const collector = new OutputCollector(session.outputs);

      const turnId = hostTurnIdSchema.parse("turn-tools");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Execute tool" }],
      });

      // Assistant requests tool_use
      fakeQuery.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_abc_1",
              name: "ReadFile",
              input: { path: "src/index.ts" },
            },
          ],
        },
      } as SDKAssistantMessage);

      await collector.waitFor(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.started" &&
          o.event.item.type === "toolExecution",
      );

      // Crucial check: tool is NOT completed yet!
      const prematureCompleted = collector.outputs.find(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.completed" &&
          o.event.snapshot.item.type === "toolExecution",
      );
      expect(prematureCompleted).toBeUndefined();

      // Subsequent user message brings tool_result
      fakeQuery.push({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_abc_1",
              content: "file content here",
              is_error: false,
            },
          ],
        },
      } as unknown as SDKUserMessage);

      const toolCompletedEvent = await collector.waitFor(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.completed" &&
          o.event.snapshot.item.type === "toolExecution" &&
          o.event.snapshot.item.itemId === "call_abc_1",
      );
      expect(toolCompletedEvent).toBeDefined();
      if (
        toolCompletedEvent.kind === "event" &&
        toolCompletedEvent.event.type === "item.completed"
      ) {
        const item = toolCompletedEvent.event.snapshot.item;
        if (item.type === "toolExecution") {
          expect(toolCompletedEvent.event.snapshot.outcome.status).toBe("succeeded");
          const firstOutput = item.output?.content[0];
          if (firstOutput?.type === "text") {
            expect(firstOutput.text).toBe("file content here");
          }
        }
      }

      // Now test failing tool execution
      fakeQuery.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_abc_2",
              name: "Bash",
              input: { command: "exit 1" },
            },
          ],
        },
      } as SDKAssistantMessage);

      await collector.waitFor(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.started" &&
          o.event.item.itemId === "call_abc_2",
      );

      fakeQuery.push({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_abc_2",
              content: "command failed with error",
              is_error: true,
            },
          ],
        },
      } as unknown as SDKUserMessage);

      const failedCompletedEvent = await collector.waitFor(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.completed" &&
          o.event.snapshot.item.type === "toolExecution" &&
          o.event.snapshot.item.itemId === "call_abc_2",
      );
      expect(failedCompletedEvent).toBeDefined();
      if (
        failedCompletedEvent.kind === "event" &&
        failedCompletedEvent.event.type === "item.completed"
      ) {
        const item = failedCompletedEvent.event.snapshot.item;
        if (item.type === "toolExecution") {
          const outcome = failedCompletedEvent.event.snapshot.outcome;
          expect(outcome.status).toBe("failed");
          if (outcome.status === "failed") {
            expect(outcome.error.message).toBe("command failed with error");
          }
        }
      }

      fakeQuery.push({
        type: "result",
        subtype: "success",
      } as SDKResultMessage);

      await collector.waitFor((o) => o.kind === "event" && o.event.type === "turn.completed");

      await session.close();
      await adapter.close();
    });
  });

  describe("permissionMode.select command", () => {
    it("calls query.setPermissionMode and notifies session state changed", async () => {
      const fakeQuery = new FakeQoderQuery();
      const adapter = new QoderAdapter({
        resolveExecutable: () => "D:/tools/qodercli.exe",
        queryFactory: () => fakeQuery,
      });

      const openResult = await adapter.open({ kind: "create", cwd: "D:/workspace" });
      if (!openResult.ok) throw new Error("open failed");
      const session = openResult.value;
      const collector = new OutputCollector(session.outputs);

      const acceptEditsMode = harnessPermissionModeIdSchema.parse("acceptEdits");
      const selectResult = await session.execute({
        type: "permissionMode.select",
        permissionModeId: acceptEditsMode,
      });

      expect(selectResult.ok).toBe(true);
      expect(fakeQuery.setPermissionMode).toHaveBeenCalledWith("acceptEdits");

      await collector.waitFor(
        (o) =>
          o.kind === "event" &&
          o.event.type === "session.state.changed" &&
          o.event.state.effectivePermissionModeId === acceptEditsMode,
      );

      await session.close();
      await adapter.close();
    });
  });

  describe("close() cleanup", () => {
    it("closes open sessions and terminates queries cleanly", async () => {
      const fakeQuery = new FakeQoderQuery();
      const adapter = new QoderAdapter({
        resolveExecutable: () => "D:/tools/qodercli.exe",
        queryFactory: () => fakeQuery,
      });

      const openResult = await adapter.open({ kind: "create", cwd: "D:/workspace" });
      if (!openResult.ok) throw new Error("open failed");
      const session = openResult.value;

      await adapter.close();
      expect(fakeQuery.close).toHaveBeenCalledTimes(1);

      // Subsequent execute after close fails with invalidState
      const res = await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("turn-after-close"),
        input: [{ type: "text", text: "Should fail" }],
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("invalidState");
      }
    });
  });

  describe("Native Turn identity persistence", () => {
    it("emits turn.completed with valid nativeTurnRef on success", async () => {
      const fakeQuery = new FakeQoderQuery();
      const adapter = new QoderAdapter({
        resolveExecutable: () => "D:/tools/qodercli.exe",
        queryFactory: () => fakeQuery,
      });

      const openResult = await adapter.open({ kind: "create", cwd: "D:/workspace" });
      if (!openResult.ok) throw new Error("open failed");
      const session = openResult.value;
      const collector = new OutputCollector(session.outputs);

      const turnId = hostTurnIdSchema.parse("turn-persist-1");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Hello" }],
      });

      fakeQuery.push({
        type: "result",
        subtype: "success",
        uuid: "qoder-result-uuid-1234",
      } as unknown as SDKResultMessage);

      const completed = await collector.waitFor(
        (o) =>
          o.kind === "event" && o.event.type === "turn.completed" && o.event.turnId === turnId,
      );

      if (completed.kind === "event" && completed.event.type === "turn.completed") {
        expect(completed.event.nativeTurnRef).toBeDefined();
        const parsed = nativeTurnRefSchema.parse(completed.event.nativeTurnRef);
        expect(parsed.harnessId).toBe("qoder");
        expect(parsed.nativeTurnKey).toBe("qoder-result-uuid-1234");
        expect(parsed.nativeSessionId).toBe(session.initialState.nativeRef?.nativeSessionId);
        expect(parsed.formatVersion).toBe(1);
      }

      await session.close();
    });

    it("falls back to user message UUID when result has no uuid", async () => {
      const fakeQuery = new FakeQoderQuery();
      const adapter = new QoderAdapter({
        resolveExecutable: () => "D:/tools/qodercli.exe",
        queryFactory: () => fakeQuery,
      });

      const openResult = await adapter.open({ kind: "create", cwd: "D:/workspace" });
      if (!openResult.ok) throw new Error("open failed");
      const session = openResult.value;
      const collector = new OutputCollector(session.outputs);

      const turnId = hostTurnIdSchema.parse("turn-persist-2");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Hello without result uuid" }],
      });

      fakeQuery.push({
        type: "result",
        subtype: "success",
      } as SDKResultMessage);

      const completed = await collector.waitFor(
        (o) =>
          o.kind === "event" && o.event.type === "turn.completed" && o.event.turnId === turnId,
      );

      if (completed.kind === "event" && completed.event.type === "turn.completed") {
        expect(completed.event.nativeTurnRef).toBeDefined();
        const parsed = nativeTurnRefSchema.parse(completed.event.nativeTurnRef);
        expect(parsed.harnessId).toBe("qoder");
        expect(parsed.nativeTurnKey).toMatch(/^qoder-msg-/);
        expect(parsed.formatVersion).toBe(1);
      }

      await session.close();
    });

    it("attaches nativeTurnRef when turn is cancelled", async () => {
      const fakeQuery = new FakeQoderQuery();
      const adapter = new QoderAdapter({
        resolveExecutable: () => "D:/tools/qodercli.exe",
        queryFactory: () => fakeQuery,
      });

      const openResult = await adapter.open({ kind: "create", cwd: "D:/workspace" });
      if (!openResult.ok) throw new Error("open failed");
      const session = openResult.value;
      const collector = new OutputCollector(session.outputs);

      const turnId = hostTurnIdSchema.parse("turn-persist-3");
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Cancel me" }],
      });

      await session.execute({
        type: "turn.cancel",
        turnId,
      });

      const completed = await collector.waitFor(
        (o) =>
          o.kind === "event" && o.event.type === "turn.completed" && o.event.turnId === turnId,
      );

      if (completed.kind === "event" && completed.event.type === "turn.completed") {
        expect(completed.event.outcome.status).toBe("cancelled");
        expect(completed.event.nativeTurnRef).toBeDefined();
        const parsed = nativeTurnRefSchema.parse(completed.event.nativeTurnRef);
        expect(parsed.harnessId).toBe("qoder");
        expect(parsed.nativeTurnKey).toMatch(/^qoder-msg-/);
      }

      await session.close();
    });
  });
});
