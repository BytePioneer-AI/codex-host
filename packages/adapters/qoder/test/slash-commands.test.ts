import { describe, expect, it, vi } from "vitest";
import {
  harnessCommandCatalogSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";

import { QoderAdapter } from "../src/qoder-adapter.js";
import {
  findQoderCommandDescriptor,
  formatQoderTurnPrompt,
  parseAndFormatQoderCommand,
  QODER_COMMAND_CATALOG,
  QODER_COMMANDS,
} from "../src/qoder-slash-commands.js";
import { QoderSession } from "../src/qoder-sdk-transport.js";
import type {
  QoderQuery,
  QoderQueryFactory,
  SDKMessage,
  SDKUserMessage,
} from "../src/qoder-sdk-types.js";

class FakeQoderQuery implements QoderQuery {
  readonly interrupt = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);
  readonly setModel = vi.fn(async () => undefined);
  readonly setPermissionMode = vi.fn(async () => undefined);
  readonly request = vi.fn(async () => ({}));
  readonly pushedMessages: SDKUserMessage[] = [];

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => new Promise(() => {}),
    };
  }
}

describe("Qoder Slash Commands Capability", () => {
  describe("Catalog Definition", () => {
    it("exposes the command catalog on the adapter before inspection or session creation", () => {
      const adapter = new QoderAdapter();
      expect(adapter.commandCatalog).toEqual(QODER_COMMAND_CATALOG);
      expect(QODER_COMMANDS).toBe(QODER_COMMAND_CATALOG.commands);
    });

    it("conforms to harnessCommandCatalogSchema and includes real Qoder CLI commands", () => {
      const parsed = harnessCommandCatalogSchema.safeParse(QODER_COMMAND_CATALOG);
      expect(parsed.success).toBe(true);

      const invocations = QODER_COMMAND_CATALOG.commands.map((c) => c.invocation);
      expect(invocations).toContain("/compact");
      expect(invocations).toContain("/plan");
      expect(invocations).toContain("/review");
      expect(invocations).toContain("/diff");
      expect(invocations).toContain("/init");
      expect(invocations).toContain("/help");
      expect(invocations).toContain("/about");
      expect(invocations).toContain("/mcp");
      expect(invocations).toContain("/skills");
      expect(invocations).toContain("/tools");
      expect(invocations).not.toContain("/boost");
      expect(invocations.length).toBe(63);

      for (const command of QODER_COMMAND_CATALOG.commands) {
        expect(command.id).toMatch(/^qoder\./);
        expect(command.label.length).toBeGreaterThan(0);
        expect(command.description?.length).toBeGreaterThan(0);
      }
    });

    it("finds commands by ID, invocation, or suffix", () => {
      expect(findQoderCommandDescriptor("qoder.compact")?.invocation).toBe("/compact");
      expect(findQoderCommandDescriptor("/compact")?.id).toBe("qoder.compact");
      expect(findQoderCommandDescriptor("compact")?.id).toBe("qoder.compact");

      expect(findQoderCommandDescriptor("qoder.plan")?.invocation).toBe("/plan");
      expect(findQoderCommandDescriptor("/plan")?.id).toBe("qoder.plan");

      expect(findQoderCommandDescriptor("/boost")).toBeUndefined();
      expect(findQoderCommandDescriptor("qoder.boost")).toBeUndefined();
      expect(findQoderCommandDescriptor("unknown")).toBeUndefined();
    });
  });

  describe("parseAndFormatQoderCommand", () => {
    const turnId = hostTurnIdSchema.parse("turn-test-1");

    it("formats /compact command with and without arguments", () => {
      const withText = parseAndFormatQoderCommand({
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
    });

    it("formats /plan command with and without arguments", () => {
      const withText = parseAndFormatQoderCommand({
        turnId,
        commandId: "qoder.plan",
        arguments: { text: "database migration" },
      });
      expect(withText.ok).toBe(true);
      if (withText.ok) {
        expect(withText.value.prompt).toBe("/plan database migration");
      }

      const bare = parseAndFormatQoderCommand({
        turnId,
        commandId: "qoder.plan",
      });
      expect(bare.ok).toBe(true);
      if (bare.ok) {
        expect(bare.value.prompt).toBe("/plan");
      }
    });

    it("formats /review, /diff, /help, /init commands", () => {
      const review = parseAndFormatQoderCommand({
        turnId,
        commandId: "qoder.review",
        arguments: { text: "staged changes" },
      });
      expect(review.ok).toBe(true);
      if (review.ok) {
        expect(review.value.prompt).toBe("/review staged changes");
      }

      const diff = parseAndFormatQoderCommand({
        turnId,
        commandId: "qoder.diff",
      });
      expect(diff.ok).toBe(true);
      if (diff.ok) {
        expect(diff.value.prompt).toBe("/diff");
      }

      const init = parseAndFormatQoderCommand({
        turnId,
        commandId: "qoder.init",
      });
      expect(init.ok).toBe(true);
      if (init.ok) {
        expect(init.value.prompt).toBe("/init");
      }

      const help = parseAndFormatQoderCommand({
        turnId,
        commandId: "qoder.help",
        arguments: { text: "mcp" },
      });
      expect(help.ok).toBe(true);
      if (help.ok) {
        expect(help.value.prompt).toBe("/help mcp");
      }
    });

    it("rejects arguments on commands with argumentMode: none", () => {
      const res = parseAndFormatQoderCommand({
        turnId,
        commandId: "qoder.init",
        arguments: { text: "extra" },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("invalidRequest");
        expect(res.error.message).toContain("does not accept arguments");
      }

      const resAbout = parseAndFormatQoderCommand({
        turnId,
        commandId: "qoder.about",
        arguments: { text: "unexpected" },
      });
      expect(resAbout.ok).toBe(false);
      if (!resAbout.ok) {
        expect(resAbout.error.code).toBe("invalidRequest");
      }
    });

    it("rejects non-object or invalid arguments", () => {
      const nonObj = parseAndFormatQoderCommand({
        turnId,
        commandId: "qoder.plan",
        arguments: "bad" as unknown as Record<string, unknown>,
      });
      expect(nonObj.ok).toBe(false);
      if (!nonObj.ok) {
        expect(nonObj.error.code).toBe("invalidRequest");
      }

      const unknownArg = parseAndFormatQoderCommand({
        turnId,
        commandId: "qoder.plan",
        arguments: { unknownField: "val" },
      });
      expect(unknownArg.ok).toBe(false);
      if (!unknownArg.ok) {
        expect(unknownArg.error.code).toBe("invalidRequest");
      }

      const nonStringText = parseAndFormatQoderCommand({
        turnId,
        commandId: "qoder.plan",
        arguments: { text: 123 as unknown as string },
      });
      expect(nonStringText.ok).toBe(false);
      if (!nonStringText.ok) {
        expect(nonStringText.error.code).toBe("invalidRequest");
      }
    });

    it("rejects unknown command ID (including fabricated /boost)", () => {
      const res = parseAndFormatQoderCommand({
        turnId,
        commandId: "qoder.nonexistent",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("unsupported");
      }

      const resBoost = parseAndFormatQoderCommand({
        turnId,
        commandId: "qoder.boost",
      });
      expect(resBoost.ok).toBe(false);
      if (!resBoost.ok) {
        expect(resBoost.error.code).toBe("unsupported");
      }
    });
  });

  describe("formatQoderTurnPrompt", () => {
    it("preserves native prompts without rewriting", () => {
      expect(formatQoderTurnPrompt("/compact")).toBe("/compact");
      expect(formatQoderTurnPrompt("/plan add payment gateway")).toBe("/plan add payment gateway");
      expect(formatQoderTurnPrompt("/review")).toBe("/review");
      expect(formatQoderTurnPrompt("/diff")).toBe("/diff");
      expect(formatQoderTurnPrompt("/init")).toBe("/init");
      expect(formatQoderTurnPrompt("/help")).toBe("/help");
      expect(formatQoderTurnPrompt("/boost")).toBe("/boost");
      expect(formatQoderTurnPrompt("Hello, can you help me write code?")).toBe(
        "Hello, can you help me write code?",
      );
    });
  });

  describe("Session Commands Execution", () => {
    function createSession(): {
      session: QoderSession;
      fakeQuery: FakeQoderQuery;
    } {
      const fakeQuery = new FakeQoderQuery();
      const factory: QoderQueryFactory = () => fakeQuery;

      const session = new QoderSession({
        sessionId: "test-cmd-session",
        cwd: "/test/cwd",
        queryFactory: factory,
      });

      return { session, fakeQuery };
    }

    it("lists command catalog via session.commands.list()", async () => {
      const { session } = createSession();
      const list = await session.commands.list();
      expect(list.ok).toBe(true);
      if (list.ok) {
        expect(list.value).toEqual(QODER_COMMAND_CATALOG);
      }
    });

    it("executes /plan command and starts turn with formatted prompt", async () => {
      const { session } = createSession();
      const turnId = hostTurnIdSchema.parse("turn-plan-1");

      const result = await session.commands.execute({
        turnId,
        commandId: "qoder.plan",
        arguments: { text: "check race conditions" },
      });

      expect(result).toEqual({ ok: true, value: { turnId } });
    });

    it("executes /compact command directly", async () => {
      const { session } = createSession();
      const turnId = hostTurnIdSchema.parse("turn-compact-1");

      const result = await session.commands.execute({
        turnId,
        commandId: "qoder.compact",
      });

      expect(result).toEqual({ ok: true, value: { turnId } });
    });

    it("rejects command when another turn is running (sessionBusy)", async () => {
      const { session } = createSession();
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
        commandId: "qoder.plan",
      });
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        expect(rejected.error.code).toBe("sessionBusy");
        expect(rejected.error.retryable).toBe(true);
      }
    });

    it("rejects command when session is closed", async () => {
      const { session } = createSession();
      await session.close();

      const result = await session.commands.execute({
        turnId: hostTurnIdSchema.parse("turn-closed-1"),
        commandId: "qoder.plan",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("invalidState");
      }
    });

    it("rejects unknown commandId and invalid arguments", async () => {
      const { session } = createSession();

      const unknown = await session.commands.execute({
        turnId: hostTurnIdSchema.parse("turn-err-1"),
        commandId: "unknown.command",
      });
      expect(unknown.ok).toBe(false);
      if (!unknown.ok) {
        expect(unknown.error.code).toBe("unsupported");
      }

      const badArgs = await session.commands.execute({
        turnId: hostTurnIdSchema.parse("turn-err-2"),
        commandId: "qoder.init",
        arguments: { text: "unexpected" },
      });
      expect(badArgs.ok).toBe(false);
      if (!badArgs.ok) {
        expect(badArgs.error.code).toBe("invalidRequest");
      }
    });
  });
});
