import { describe, expect, it, vi } from "vitest";
import {
  harnessCommandCatalogSchema,
  hostTurnIdSchema,
  type JsonObject,
} from "@codexhost/shared-contracts";
import type { HarnessOutput } from "@codexhost/harness-adapter";

import { QoderAdapter } from "../src/qoder-adapter.js";
import {
  findQoderCommandDescriptor,
  humanize,
  mapQoderSlashCommands,
  parseAndFormatQoderCommand,
  parseQoderCommandInvocation,
  QODER_COMMANDS,
  QODER_COMMAND_CATALOG,
  QODER_FALLBACK_COMMAND_CATALOG,
  QODER_VERIFIED_HEADLESS_COMMAND_IDS,
} from "../src/qoder-slash-commands.js";
import { QoderSession } from "../src/qoder-sdk-transport.js";
import { mapQoderSnapshot } from "../src/qoder-history.js";
import type {
  QoderQuery,
  QoderQueryFactory,
  QoderSlashCommand,
  SDKMessage,
  SDKUserMessage,
  SessionMessage,
} from "../src/qoder-sdk-types.js";

class FakeQoderQuery implements QoderQuery {
  readonly interrupt = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  });
  readonly setModel = vi.fn(async () => undefined);
  readonly setPermissionMode = vi.fn(async () => undefined);
  readonly request = vi.fn(async () => ({}));
  supportedCommands?: () => Promise<QoderSlashCommand[]>;
  readonly pushedMessages: SDKUserMessage[] = [];

  #closed = false;
  #messageQueue: SDKMessage[] = [];
  #waiters: Array<(result: IteratorResult<SDKMessage>) => void> = [];
  #errorToThrow: Error | undefined = undefined;
  #rejectWaiter: ((reason?: unknown) => void) | undefined = undefined;

  throwInIterator(err: Error): void {
    if (this.#waiters.length > 0) {
      this.#waiters.shift();
      this.#rejectWaiter?.(err);
    } else {
      this.#errorToThrow = err;
    }
  }

  deliverMessage(msg: SDKMessage): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value: msg });
    } else {
      this.#messageQueue.push(msg);
    }
  }

  attachPrompt(prompt: string | AsyncIterable<SDKUserMessage>): void {
    if (typeof prompt === "object" && prompt !== null && Symbol.asyncIterator in prompt) {
      void (async () => {
        try {
          for await (const msg of prompt) {
            this.pushedMessages.push(msg);
          }
        } catch {
          // Pushable input closed
        }
      })();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        if (this.#errorToThrow) {
          const err = this.#errorToThrow;
          this.#errorToThrow = undefined;
          return Promise.reject(err);
        }
        const msg = this.#messageQueue.shift();
        if (msg !== undefined) return Promise.resolve({ done: false, value: msg });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<SDKMessage>>((resolve, reject) => {
          this.#rejectWaiter = reject;
          this.#waiters.push(resolve);
        });
      },
    };
  }
}

class OutputCollector {
  readonly outputs: HarnessOutput[] = [];
  constructor(stream: AsyncIterable<HarnessOutput>) {
    void (async () => {
      try {
        for await (const out of stream) {
          this.outputs.push(out);
        }
      } catch {
        // Output stream ended
      }
    })();
  }
}

async function flushTicks(ms = 10): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createSession(customSupportedCommands?: QoderSlashCommand[]): {
  session: QoderSession;
  fakeQuery: FakeQoderQuery;
} {
  const fakeQuery = new FakeQoderQuery();
  if (customSupportedCommands) {
    fakeQuery.supportedCommands = vi.fn(async () => customSupportedCommands);
  }
  const factory: QoderQueryFactory = ({ prompt }) => {
    fakeQuery.attachPrompt(prompt);
    return fakeQuery;
  };

  const session = new QoderSession({
    sessionId: "test-cmd-session",
    cwd: "/test/cwd",
    queryFactory: factory,
  });

  return { session, fakeQuery };
}

describe("Qoder Slash Commands Capability", () => {
  describe("Catalog Definition & Helpers", () => {
    it("exposes the fallback command catalog on the adapter before inspection or session creation", () => {
      const adapter = new QoderAdapter();
      expect(adapter.commandCatalog).toEqual(QODER_FALLBACK_COMMAND_CATALOG);
      expect(QODER_COMMAND_CATALOG).toEqual(QODER_FALLBACK_COMMAND_CATALOG);
      expect(QODER_COMMANDS).toEqual(QODER_FALLBACK_COMMAND_CATALOG.commands);
    });

    it("restricts fallback catalog strictly to verified headless commands (/compact only)", () => {
      const parsed = harnessCommandCatalogSchema.safeParse(QODER_FALLBACK_COMMAND_CATALOG);
      expect(parsed.success).toBe(true);

      const invocations = QODER_FALLBACK_COMMAND_CATALOG.commands.map((c) => c.invocation);
      expect(invocations).toEqual(["/compact"]);
      expect(QODER_FALLBACK_COMMAND_CATALOG.commands).toHaveLength(1);

      const compactCmd = QODER_FALLBACK_COMMAND_CATALOG.commands[0];
      expect(compactCmd?.id).toBe("qoder.compact");
      expect(compactCmd?.label).toBe("Compact");
      expect(compactCmd?.argumentMode).toBe("text");
      expect(QODER_VERIFIED_HEADLESS_COMMAND_IDS.has("qoder.compact")).toBe(true);
    });

    it("humanizes command names correctly", () => {
      expect(humanize("compact")).toBe("Compact");
      expect(humanize("memory_stats")).toBe("Memory Stats");
      expect(humanize("auto-compact")).toBe("Auto Compact");
      expect(humanize("quick_fix_all")).toBe("Quick Fix All");
      expect(humanize("")).toBe("");
    });

    it("maps native QoderSlashCommand items to HarnessCommandCatalog", () => {
      const nativeCommands: QoderSlashCommand[] = [
        { name: "compact", description: "Compresses context", argumentHint: "" },
        { name: "plan", description: "Create execution plan", argumentHint: "<goal>" },
        { name: "diff", description: "Show git diff", argumentHint: "  " },
      ];

      const catalog = mapQoderSlashCommands(nativeCommands);
      expect(catalog.commands).toHaveLength(3);

      expect(catalog.commands[0]).toEqual({
        id: "qoder.compact",
        invocation: "/compact",
        label: "Compact",
        description: "Compresses context",
        argumentMode: "none",
      });
      expect(catalog.commands[1]).toEqual({
        id: "qoder.plan",
        invocation: "/plan",
        label: "Plan",
        description: "Create execution plan",
        argumentMode: "text",
      });
      expect(catalog.commands[2]).toEqual({
        id: "qoder.diff",
        invocation: "/diff",
        label: "Diff",
        description: "Show git diff",
        argumentMode: "none",
      });
    });

    it("sanitizes whitespace descriptions and caps length at 512 characters without schema errors", () => {
      const longDesc = "a".repeat(600);
      const catalog = mapQoderSlashCommands([
        { name: "whitespace_desc", description: "   ", argumentHint: "" },
        { name: "long_desc", description: longDesc, argumentHint: "" },
      ]);
      expect(catalog.commands).toHaveLength(2);
      expect(catalog.commands[0]?.description).toBeUndefined();
      expect(catalog.commands[1]?.description).toHaveLength(512);
    });

    it("supports string command names and normalizes uppercase names to lowercase", () => {
      const catalog = mapQoderSlashCommands(["/Compact", "Review"]);
      expect(catalog.commands).toHaveLength(2);
      expect(catalog.commands[0]).toEqual({
        id: "qoder.compact",
        invocation: "/compact",
        label: "Compact",
        argumentMode: "none",
      });
      expect(catalog.commands[1]).toEqual({
        id: "qoder.review",
        invocation: "/review",
        label: "Review",
        argumentMode: "none",
      });
    });

    it("finds commands by ID, invocation, or suffix in specified or fallback catalog", () => {
      expect(findQoderCommandDescriptor("qoder.compact")?.invocation).toBe("/compact");
      expect(findQoderCommandDescriptor("/compact")?.id).toBe("qoder.compact");
      expect(findQoderCommandDescriptor("compact")?.id).toBe("qoder.compact");

      expect(findQoderCommandDescriptor("/plan")).toBeUndefined();
      expect(findQoderCommandDescriptor("unknown")).toBeUndefined();

      const customCatalog = mapQoderSlashCommands([
        { name: "plan", description: "Plan", argumentHint: "<goal>" },
      ]);
      expect(findQoderCommandDescriptor("qoder.plan", customCatalog)?.invocation).toBe("/plan");
      expect(findQoderCommandDescriptor("/plan", customCatalog)?.id).toBe("qoder.plan");
    });
  });

  describe("parseQoderCommandInvocation", () => {
    const turnId = hostTurnIdSchema.parse("turn-test-1");

    it("formats /compact command with and without arguments", () => {
      const withText = parseQoderCommandInvocation({
        turnId,
        commandId: "qoder.compact",
        arguments: { text: "focus on api" },
      });
      expect(withText.ok).toBe(true);
      if (withText.ok) {
        expect(withText.value.prompt).toBe("/compact focus on api");
        expect(withText.value.descriptor.invocation).toBe("/compact");
      }

      const bare = parseAndFormatQoderCommand({
        turnId,
        commandId: "qoder.compact",
      });
      expect(bare.ok).toBe(true);
      if (bare.ok) {
        expect(bare.value.prompt).toBe("/compact");
      }

      const whitespaceText = parseQoderCommandInvocation({
        turnId,
        commandId: "qoder.compact",
        arguments: { text: "   " },
      });
      expect(whitespaceText.ok).toBe(true);
      if (whitespaceText.ok) {
        expect(whitespaceText.value.prompt).toBe("/compact");
      }
    });

    it("rejects unverified commands even if present in custom catalog", () => {
      const customCatalog = mapQoderSlashCommands([
        { name: "compact", description: "Compact", argumentHint: "" },
        { name: "plan", description: "Plan", argumentHint: "<goal>" },
        { name: "review", description: "Review", argumentHint: "" },
      ]);

      const planRes = parseQoderCommandInvocation(
        {
          turnId,
          commandId: "qoder.plan",
          arguments: { text: "database migration" },
        },
        customCatalog,
      );
      expect(planRes.ok).toBe(false);
      if (!planRes.ok) {
        expect(planRes.error.code).toBe("unsupported");
        expect(planRes.error.message).toContain("not verified for headless execution");
      }

      const reviewRes = parseQoderCommandInvocation(
        {
          turnId,
          commandId: "qoder.review",
        },
        customCatalog,
      );
      expect(reviewRes.ok).toBe(false);
      if (!reviewRes.ok) {
        expect(reviewRes.error.code).toBe("unsupported");
        expect(reviewRes.error.message).toContain("not verified for headless execution");
      }
    });

    it("rejects unknown command ID not present in catalog", () => {
      const res = parseQoderCommandInvocation({
        turnId,
        commandId: "qoder.nonexistent",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("unsupported");
        expect(res.error.message).toContain("does not expose Harness command");
      }
    });

    it("rejects non-object or invalid arguments", () => {
      const nonObj = parseQoderCommandInvocation({
        turnId,
        commandId: "qoder.compact",
        arguments: "bad" as unknown as JsonObject,
      });
      expect(nonObj.ok).toBe(false);
      if (!nonObj.ok) {
        expect(nonObj.error.code).toBe("invalidRequest");
      }

      const unknownArg = parseQoderCommandInvocation({
        turnId,
        commandId: "qoder.compact",
        arguments: { unknownField: "val" },
      });
      expect(unknownArg.ok).toBe(false);
      if (!unknownArg.ok) {
        expect(unknownArg.error.code).toBe("invalidRequest");
        expect(unknownArg.error.message).toContain("unknown argument");
      }

      const nonStringText = parseQoderCommandInvocation({
        turnId,
        commandId: "qoder.compact",
        arguments: { text: 123 as unknown as string },
      });
      expect(nonStringText.ok).toBe(false);
      if (!nonStringText.ok) {
        expect(nonStringText.error.code).toBe("invalidRequest");
        expect(nonStringText.error.message).toContain("must be a string");
      }
    });

    it("rejects arguments when command has argumentMode none", () => {
      const customCatalog = harnessCommandCatalogSchema.parse({
        commands: [
          {
            id: "qoder.compact",
            invocation: "/compact",
            label: "Compact",
            argumentMode: "none",
          },
        ],
      });

      const res = parseQoderCommandInvocation(
        {
          turnId,
          commandId: "qoder.compact",
          arguments: { text: "extra" },
        },
        customCatalog,
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("invalidRequest");
        expect(res.error.message).toContain("does not accept arguments");
      }
    });
  });

  describe("Session Commands Execution & SDK Message Delivery", () => {
    it("lists fallback command catalog via session.commands.list()", async () => {
      const { session } = createSession();
      const list = await session.commands.list();
      expect(list.ok).toBe(true);
      if (list.ok) {
        expect(list.value).toEqual(QODER_FALLBACK_COMMAND_CATALOG);
      }
    });

    it("executes /compact command with native contextCompaction item lifecycle", async () => {
      const { session, fakeQuery } = createSession();
      const collector = new OutputCollector(session.outputs);
      const turnId = hostTurnIdSchema.parse("turn-compact-1");

      const result = await session.commands.execute({
        turnId,
        commandId: "qoder.compact",
      });

      expect(result).toEqual({ ok: true, value: { turnId } });

      await flushTicks();
      expect(fakeQuery.pushedMessages).toHaveLength(1);
      const pushed = fakeQuery.pushedMessages[0];
      expect(pushed?.type).toBe("user");
      // client_composed MUST NOT be true so Qoder triggers native slash dispatcher
      expect(pushed?.client_composed).toBeUndefined();
      expect(pushed?.message.role).toBe("user");
      expect(pushed?.message.content).toEqual([{ type: "text", text: "/compact" }]);

      // Verify contextCompaction item.started is emitted so Desktop displays "正在压缩上下文"
      const started = collector.outputs.find(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.started" &&
          o.event.item.type === "contextCompaction",
      );
      expect(started).toBeDefined();

      // Send thinking_delta from LLM while generating summary - verify it is suppressed (no reasoning item)
      fakeQuery.deliverMessage({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "Internal compaction reasoning..." },
        },
      } as unknown as SDKMessage);
      await flushTicks();

      const reasoning = collector.outputs.find(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.started" &&
          o.event.item.type === "reasoning",
      );
      expect(reasoning).toBeUndefined();

      // Finish compaction with SDK result
      fakeQuery.deliverMessage({
        type: "result",
        subtype: "success",
        uuid: "result-compact-1",
      } as unknown as SDKMessage);
      await flushTicks();

      // Verify contextCompaction item.completed with succeeded is emitted so Desktop displays "上下文已压缩"
      const completed = collector.outputs.find(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.completed" &&
          o.event.snapshot.item.type === "contextCompaction" &&
          o.event.snapshot.outcome.status === "succeeded",
      );
      expect(completed).toBeDefined();
    });

    it("executes /compact command with arguments and pushes correct prompt", async () => {
      const { session, fakeQuery } = createSession();
      const turnId = hostTurnIdSchema.parse("turn-compact-args");

      const result = await session.commands.execute({
        turnId,
        commandId: "qoder.compact",
        arguments: { text: "optimize memory" },
      });

      expect(result).toEqual({ ok: true, value: { turnId } });

      await flushTicks();
      expect(fakeQuery.pushedMessages).toHaveLength(1);
      const pushed = fakeQuery.pushedMessages[0];
      expect(pushed?.client_composed).toBeUndefined();
      expect(pushed?.message.content).toEqual([{ type: "text", text: "/compact optimize memory" }]);
    });

    it("rejects unverified commands (e.g. /plan) and never pushes them to the SDK", async () => {
      const { session, fakeQuery } = createSession();
      const turnId = hostTurnIdSchema.parse("turn-unverified-plan");

      const result = await session.commands.execute({
        turnId,
        commandId: "qoder.plan",
        arguments: { text: "add payment gateway" },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("unsupported");
      }

      await flushTicks();
      // Unverified commands must NEVER be pushed as user prompts
      expect(fakeQuery.pushedMessages).toHaveLength(0);
    });

    it("dynamically loads supported commands from query.supportedCommands()", async () => {
      const customCommands: QoderSlashCommand[] = [
        { name: "compact", description: "Compact context", argumentHint: "" },
        { name: "custom_cmd", description: "A custom command", argumentHint: "<arg>" },
      ];

      const { session, fakeQuery } = createSession(customCommands);
      await flushTicks();

      const list = await session.commands.list();
      expect(list.ok).toBe(true);
      if (list.ok) {
        const invocations = list.value.commands.map((c) => c.invocation);
        expect(invocations).toContain("/compact");
        expect(invocations).toContain("/custom_cmd");
      }

      // Executing the unverified custom command must still be rejected
      const turnId = hostTurnIdSchema.parse("turn-custom-cmd");
      const result = await session.commands.execute({
        turnId,
        commandId: "qoder.custom_cmd",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("unsupported");
        expect(result.error.message).toContain("not verified for headless execution");
      }
      expect(fakeQuery.pushedMessages).toHaveLength(0);
    });

    it("updates catalog dynamically on system/init message with commands", async () => {
      const { session, fakeQuery } = createSession();

      fakeQuery.deliverMessage({
        type: "system",
        subtype: "init",
        session_id: "init-session-id",
        commands: [
          { name: "compact", description: "Init compact", argumentHint: "" },
          { name: "init_extra", description: "Init extra", argumentHint: "" },
        ],
      } as unknown as SDKMessage);

      await flushTicks();

      const list = await session.commands.list();
      expect(list.ok).toBe(true);
      if (list.ok) {
        const ids = list.value.commands.map((c) => c.id);
        expect(ids).toContain("qoder.compact");
        expect(ids).toContain("qoder.init_extra");
      }
    });

    it("preserves fallback catalog when system/init delivers empty commands array", async () => {
      const { session, fakeQuery } = createSession();

      fakeQuery.deliverMessage({
        type: "system",
        subtype: "init",
        session_id: "init-empty-id",
        commands: [],
      } as unknown as SDKMessage);

      await flushTicks();

      const list = await session.commands.list();
      expect(list.ok).toBe(true);
      if (list.ok) {
        expect(list.value).toEqual(QODER_FALLBACK_COMMAND_CATALOG);
      }
    });

    it("gracefully handles malformed commands_changed payload without aborting session", async () => {
      const { session, fakeQuery } = createSession();

      // Send malformed commands payload with an invalid object that would cause schema error
      fakeQuery.deliverMessage({
        type: "system",
        subtype: "commands_changed",
        uuid: "msg-bad-cmd",
        session_id: "test-cmd-session",
        commands: [{ name: "@@@@@" }],
      } as unknown as SDKMessage);

      await flushTicks();

      // Catalog should remain intact and session can still execute /compact
      const turnId = hostTurnIdSchema.parse("turn-after-bad-cmd");
      const result = await session.commands.execute({
        turnId,
        commandId: "qoder.compact",
      });
      expect(result.ok).toBe(true);
    });

    it("executes /compact case-insensitively", async () => {
      const { session, fakeQuery } = createSession();
      const turnId = hostTurnIdSchema.parse("turn-case-insensitive");

      const result = await session.commands.execute({
        turnId,
        commandId: "/COMPACT",
      });
      expect(result.ok).toBe(true);

      await flushTicks();
      expect(fakeQuery.pushedMessages).toHaveLength(1);
      expect(fakeQuery.pushedMessages[0]?.message.content).toEqual([
        { type: "text", text: "/compact" },
      ]);
    });

    it("fully replaces catalog snapshot on commands_changed message without merging removed commands", async () => {
      const { session, fakeQuery } = createSession();

      // Send commands_changed message containing only a new command (compact intentionally absent)
      fakeQuery.deliverMessage({
        type: "system",
        subtype: "commands_changed",
        uuid: "msg-uuid-1",
        session_id: "test-cmd-session",
        commands: [{ name: "diff", description: "Show git diff", argumentHint: "" }],
      } as unknown as SDKMessage);

      await flushTicks();

      const list = await session.commands.list();
      expect(list.ok).toBe(true);
      if (list.ok) {
        expect(list.value.commands).toHaveLength(1);
        expect(list.value.commands[0]?.invocation).toBe("/diff");
      }

      // Compact is no longer in the catalog snapshot, so executing it should now fail with unsupported
      const result = await session.commands.execute({
        turnId: hostTurnIdSchema.parse("turn-removed-compact"),
        commandId: "qoder.compact",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("unsupported");
        expect(result.error.message).toContain("does not expose Harness command");
      }
    });

    it("rejects command when another turn is running (sessionBusy)", async () => {
      const { session, fakeQuery } = createSession();
      const turn1 = hostTurnIdSchema.parse("turn-active-1");
      const turn2 = hostTurnIdSchema.parse("turn-active-2");

      const start1 = await session.execute({
        type: "turn.start",
        turnId: turn1,
        input: [{ type: "text", text: "working" }],
      });
      expect(start1.ok).toBe(true);

      const rejected = await session.commands.execute({
        turnId: turn2,
        commandId: "qoder.compact",
      });
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        expect(rejected.error.code).toBe("sessionBusy");
        expect(rejected.error.retryable).toBe(true);
      }

      await flushTicks();
      // Only the turn.start message was sent; rejected command was not pushed
      expect(fakeQuery.pushedMessages).toHaveLength(1);
      expect(fakeQuery.pushedMessages[0]?.message.content[0]).toEqual({
        type: "text",
        text: "working",
      });
    });

    it("rejects command when session is closed", async () => {
      const { session, fakeQuery } = createSession();
      await session.close();

      const result = await session.commands.execute({
        turnId: hostTurnIdSchema.parse("turn-closed-1"),
        commandId: "qoder.compact",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("invalidState");
      }
      expect(fakeQuery.pushedMessages).toHaveLength(0);
    });

    it("completes active command turn as failed when query raises an error", async () => {
      const { session, fakeQuery } = createSession();
      const collector = new OutputCollector(session.outputs);
      const turnId = hostTurnIdSchema.parse("turn-fail-1");

      const executed = await session.commands.execute({
        turnId,
        commandId: "qoder.compact",
      });
      expect(executed.ok).toBe(true);

      fakeQuery.throwInIterator(new Error("Simulated query runner disconnect"));

      await flushTicks();

      const completedEvent = collector.outputs.find(
        (o) => o.kind === "event" && o.event.type === "turn.completed",
      );
      expect(completedEvent).toBeDefined();
      if (
        completedEvent &&
        completedEvent.kind === "event" &&
        completedEvent.event.type === "turn.completed"
      ) {
        expect(completedEvent.event.turnId).toBe(turnId);
        expect(completedEvent.event.outcome.status).toBe("failed");
      }

      // Session is now idle again and can accept new commands
      const turn2 = hostTurnIdSchema.parse("turn-compact-retry");
      const retryResult = await session.commands.execute({
        turnId: turn2,
        commandId: "qoder.compact",
      });
      expect(retryResult.ok).toBe(true);
    });

    it("emits contextCompaction items on compact_boundary system message during a regular turn", async () => {
      const { session, fakeQuery } = createSession();
      const collector = new OutputCollector(session.outputs);
      const turnId = hostTurnIdSchema.parse("turn-auto-compact");

      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Regular conversation" }],
      });

      await flushTicks();

      // Qoder triggers auto-compaction and sends compact_boundary system message
      fakeQuery.deliverMessage({
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact-boundary-uuid",
        content: "Conversation compacted",
      } as unknown as SDKMessage);

      await flushTicks();

      const started = collector.outputs.find(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.started" &&
          o.event.item.type === "contextCompaction",
      );
      expect(started).toBeDefined();

      const completed = collector.outputs.find(
        (o) =>
          o.kind === "event" &&
          o.event.type === "item.completed" &&
          o.event.snapshot.item.type === "contextCompaction" &&
          o.event.snapshot.outcome.status === "succeeded",
      );
      expect(completed).toBeDefined();
    });

    it("maps /compact turns to contextCompaction items in snapshot history", () => {
      const messages: SessionMessage[] = [
        {
          type: "user",
          uuid: "user-compact-msg",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [{ type: "text", text: "/compact" }],
          },
        } as SessionMessage,
        {
          type: "assistant",
          uuid: "assistant-compact-msg",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Summary text..." }],
          },
        } as SessionMessage,
      ];

      const snapshot = mapQoderSnapshot(messages, "test-history-session");
      expect(snapshot.turns).toHaveLength(1);
      expect(snapshot.turns[0]?.items).toHaveLength(1);
      expect(snapshot.turns[0]?.items[0]?.item.type).toBe("contextCompaction");
      expect(snapshot.turns[0]?.items[0]?.outcome.status).toBe("succeeded");
    });
  });
});
