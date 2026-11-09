import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HarnessAdapter, HarnessOutput, HostEvent } from "@codexhost/harness-adapter";
import { harnessCommandCatalogSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { AntigravityAdapter } from "../src/antigravity-adapter.js";
import {
  ANTIGRAVITY_COMMAND_CATALOG,
  findAntigravityCommandDescriptor,
} from "../src/slash-commands.js";

async function fakeStreamingAgy(streamLines: readonly string[]): Promise<{
  command: string;
  cwd: string;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-cmd-test-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-cmd-cwd-"));
  const cleanup = async (): Promise<void> => {
    for (const target of [directory, cwd]) {
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  };
  const scriptContent = `
const lines = ${JSON.stringify(streamLines)};
if (process.argv.includes("models")) {
  process.stdout.write("gemini-3.7-flash\\tGemini 3.7 Flash\\n");
  process.exit(0);
}
for (const line of lines) {
  process.stdout.write(line + "\\n");
}
`;
  const jsPath = path.join(directory, "agy.cjs");
  await writeFile(jsPath, scriptContent);
  if (process.platform === "win32") {
    const command = path.join(directory, "agy.cmd");
    await writeFile(command, `@node "${jsPath}" %*\r\n`);
    return { command, cwd, cleanup };
  }
  const command = path.join(directory, "agy");
  await writeFile(command, `#!/usr/bin/env node\n${scriptContent}`);
  await chmod(command, 0o755);
  return { command, cwd, cleanup };
}

async function drainEvents(outputs: AsyncIterable<HarnessOutput>): Promise<HostEvent[]> {
  const events: HostEvent[] = [];
  for await (const output of outputs) {
    if (output.kind === "event") {
      events.push(output.event);
      if (output.event.type === "turn.completed") break;
    }
  }
  return events;
}

describe("Antigravity Slash Commands Capability", () => {
  describe("Catalog Definition", () => {
    it("exposes the command catalog before inspection or Session creation", async () => {
      const adapter: HarnessAdapter = new AntigravityAdapter({ environment: { PATH: "" } });
      try {
        expect(adapter.commandCatalog).toEqual(ANTIGRAVITY_COMMAND_CATALOG);
      } finally {
        await adapter.close();
      }
    });

    it("conforms to harnessCommandCatalogSchema and includes all required commands", () => {
      const parsed = harnessCommandCatalogSchema.safeParse(ANTIGRAVITY_COMMAND_CATALOG);
      expect(parsed.success).toBe(true);

      const commandInvocations = ANTIGRAVITY_COMMAND_CATALOG.commands.map((c) => c.invocation);
      const expectedInvocations = [
        "/plan",
        "/goal",
        "/browser",
        "/grill-me",
        "/boost",
        "/learn",
        "/schedule",
        "/compact",
        "/help",
      ];
      for (const expected of expectedInvocations) {
        expect(commandInvocations).toContain(expected);
      }

      for (const command of ANTIGRAVITY_COMMAND_CATALOG.commands) {
        expect(command.id).toMatch(/^antigravity\./);
        expect(command.argumentMode).toBe("text");
        expect(command.label.length).toBeGreaterThan(0);
        expect(command.description?.length).toBeGreaterThan(0);
      }
    });

    it("finds commands by ID, invocation, or suffix", () => {
      expect(findAntigravityCommandDescriptor("antigravity.plan")?.invocation).toBe("/plan");
      expect(findAntigravityCommandDescriptor("/plan")?.id).toBe("antigravity.plan");
      expect(findAntigravityCommandDescriptor("plan")?.id).toBe("antigravity.plan");
      expect(findAntigravityCommandDescriptor("/grill-me")?.id).toBe("antigravity.grill-me");
      expect(findAntigravityCommandDescriptor("compact")?.invocation).toBe("/compact");
      expect(findAntigravityCommandDescriptor("unknown")).toBeUndefined();
    });
  });

  describe("Session Commands Execution", () => {
    it("lists command catalog via session.commands.list()", async () => {
      const { command, cwd, cleanup } = await fakeStreamingAgy([]);
      const adapter = new AntigravityAdapter({ command });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;

        const session = opened.value;
        expect(session.commands).toBeDefined();
        if (!session.commands) return;

        const catalogResult = await session.commands.list();
        expect(catalogResult.ok).toBe(true);
        if (catalogResult.ok) {
          expect(catalogResult.value.commands).toEqual(ANTIGRAVITY_COMMAND_CATALOG.commands);
        }
        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("executes slash command with argument text and delegates to turn.start", async () => {
      const streamLines = [
        JSON.stringify({
          event: "init",
          init: { permission_mode: "configured" },
          conversation_id: "conv-cmd-1",
        }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-cmd-1",
            status: "SUCCESS",
            num_turns: 1,
            response: "Plan created.",
          },
        }),
      ];
      const { command, cwd, cleanup } = await fakeStreamingAgy(streamLines);
      const adapter = new AntigravityAdapter({ command });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;

        const session = opened.value;
        expect(session.commands).toBeDefined();
        if (!session.commands) return;
        const turnId = hostTurnIdSchema.parse("turn-cmd-1");

        const drainPromise = drainEvents(session.outputs);
        const executeResult = await session.commands.execute({
          turnId,
          commandId: "antigravity.plan",
          arguments: { text: "refactor authentication module" },
        });

        expect(executeResult).toEqual({ ok: true, value: { turnId } });
        await drainPromise;

        const snapshot = await session.readSnapshot();
        expect(snapshot.ok).toBe(true);
        if (snapshot.ok) {
          expect(snapshot.value.turns).toHaveLength(1);
          expect(snapshot.value.turns[0]?.input).toEqual([
            { type: "text", text: "/plan refactor authentication module" },
          ]);
        }
        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("executes bare slash command without arguments", async () => {
      const streamLines = [
        JSON.stringify({
          event: "init",
          init: { permission_mode: "configured" },
          conversation_id: "conv-cmd-2",
        }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-cmd-2",
            status: "SUCCESS",
            num_turns: 1,
            response: "Showing help.",
          },
        }),
      ];
      const { command, cwd, cleanup } = await fakeStreamingAgy(streamLines);
      const adapter = new AntigravityAdapter({ command });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;

        const session = opened.value;
        expect(session.commands).toBeDefined();
        if (!session.commands) return;
        const turnId = hostTurnIdSchema.parse("turn-cmd-2");

        const drainPromise = drainEvents(session.outputs);
        const executeResult = await session.commands.execute({
          turnId,
          commandId: "/help",
        });

        expect(executeResult).toEqual({ ok: true, value: { turnId } });
        await drainPromise;

        const snapshot = await session.readSnapshot();
        expect(snapshot.ok).toBe(true);
        if (snapshot.ok) {
          expect(snapshot.value.turns[0]?.input).toEqual([{ type: "text", text: "/help" }]);
        }
        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("executes slash command with trailing whitespace in argument text", async () => {
      const streamLines = [
        JSON.stringify({
          event: "init",
          init: { permission_mode: "configured" },
          conversation_id: "conv-cmd-3",
        }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-cmd-3",
            status: "SUCCESS",
            num_turns: 1,
            response: "Boosted.",
          },
        }),
      ];
      const { command, cwd, cleanup } = await fakeStreamingAgy(streamLines);
      const adapter = new AntigravityAdapter({ command });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;

        const session = opened.value;
        expect(session.commands).toBeDefined();
        if (!session.commands) return;
        const turnId = hostTurnIdSchema.parse("turn-cmd-3");

        const drainPromise = drainEvents(session.outputs);
        const executeResult = await session.commands.execute({
          turnId,
          commandId: "antigravity.boost",
          arguments: { text: "   " },
        });

        expect(executeResult).toEqual({ ok: true, value: { turnId } });
        await drainPromise;

        const snapshot = await session.readSnapshot();
        expect(snapshot.ok).toBe(true);
        if (snapshot.ok) {
          expect(snapshot.value.turns[0]?.input).toEqual([{ type: "text", text: "/boost" }]);
        }
        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("rejects unknown command ID with unsupported error", async () => {
      const { command, cwd, cleanup } = await fakeStreamingAgy([]);
      const adapter = new AntigravityAdapter({ command });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;

        const session = opened.value;
        expect(session.commands).toBeDefined();
        if (!session.commands) return;
        const turnId = hostTurnIdSchema.parse("turn-cmd-4");

        const result = await session.commands.execute({
          turnId,
          commandId: "antigravity.unknown",
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("unsupported");
          expect(result.error.message).toContain("Antigravity does not expose Harness command");
        }
        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("rejects invalid argument types with invalidRequest error", async () => {
      const { command, cwd, cleanup } = await fakeStreamingAgy([]);
      const adapter = new AntigravityAdapter({ command });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;

        const session = opened.value;
        expect(session.commands).toBeDefined();
        if (!session.commands) return;
        const turnId = hostTurnIdSchema.parse("turn-cmd-5");

        // Non-string text
        const nonStringResult = await session.commands.execute({
          turnId,
          commandId: "antigravity.plan",
          arguments: { text: 123 as unknown as string },
        });
        expect(nonStringResult.ok).toBe(false);
        if (!nonStringResult.ok) {
          expect(nonStringResult.error.code).toBe("invalidRequest");
        }

        // Unknown argument keys
        const unknownArgResult = await session.commands.execute({
          turnId,
          commandId: "antigravity.plan",
          arguments: { text: "ok", extra: "nope" } as unknown as { text: string },
        });
        expect(unknownArgResult.ok).toBe(false);
        if (!unknownArgResult.ok) {
          expect(unknownArgResult.error.code).toBe("invalidRequest");
        }

        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("rejects execution on closed session with invalidState error", async () => {
      const { command, cwd, cleanup } = await fakeStreamingAgy([]);
      const adapter = new AntigravityAdapter({ command });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;

        const session = opened.value;
        expect(session.commands).toBeDefined();
        if (!session.commands) return;
        await session.close();

        const turnId = hostTurnIdSchema.parse("turn-cmd-6");
        const result = await session.commands.execute({
          turnId,
          commandId: "/plan",
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("invalidState");
        }
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("rejects execution when another turn is already active with sessionBusy error", async () => {
      const streamLines = [JSON.stringify({ event: "init", conversation_id: "conv-cmd-busy" })];
      const { command, cwd, cleanup } = await fakeStreamingAgy(streamLines);
      const adapter = new AntigravityAdapter({ command });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;

        const session = opened.value;
        expect(session.commands).toBeDefined();
        if (!session.commands) return;
        const turn1 = hostTurnIdSchema.parse("turn-cmd-busy-1");
        const turn2 = hostTurnIdSchema.parse("turn-cmd-busy-2");

        // Start turn 1 without resolving result
        const started1 = await session.execute({
          type: "turn.start",
          turnId: turn1,
          input: [{ type: "text", text: "first turn" }],
        });
        expect(started1.ok).toBe(true);

        // Attempt command execute while turn 1 is running
        const result2 = await session.commands.execute({
          turnId: turn2,
          commandId: "/plan",
        });

        expect(result2.ok).toBe(false);
        if (!result2.ok) {
          expect(result2.error.code).toBe("sessionBusy");
          expect(result2.error.retryable).toBe(true);
        }

        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });
  });

  describe("Context Compaction", () => {
    const step = (
      conversationId: string,
      stepIndex: number,
      stepType: string,
      state: string,
      extra: Record<string, unknown> = {},
    ): string =>
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: conversationId,
          step_index: stepIndex,
          state,
          step_type: stepType,
          ...extra,
        },
      });
    const result = (conversationId: string, response: string, status = "SUCCESS"): string =>
      JSON.stringify({
        event: "result",
        result: { conversation_id: conversationId, status, num_turns: 1, response },
      });

    it("runs /compact through agy and projects its checkpoint as a Context Compaction", async () => {
      // Recorded from agy 1.4.12 answering `/compact` in stream-json print mode.
      const streamLines = [
        JSON.stringify({ event: "init", conversation_id: "conv-compact-1" }),
        step("conv-compact-1", 2, "user_input", "DONE"),
        step("conv-compact-1", 3, "system_message", "DONE"),
        step("conv-compact-1", 4, "checkpoint", "DONE", { duration_seconds: 3.3 }),
        result("conv-compact-1", ""),
      ];
      const { command, cwd, cleanup } = await fakeStreamingAgy(streamLines);
      const adapter = new AntigravityAdapter({ command });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const session = opened.value;
        const commands = session.commands;
        expect(commands).toBeDefined();
        if (!commands) return;
        const turnId = hostTurnIdSchema.parse("turn-compact-1");

        const drainPromise = drainEvents(session.outputs);
        const executed = await commands.execute({
          turnId,
          commandId: "antigravity.compact",
        });
        expect(executed).toEqual({ ok: true, value: { turnId } });
        const events = await drainPromise;

        const started = events.find(
          (event) => event.type === "item.started" && event.item.type === "contextCompaction",
        );
        expect(started).toBeDefined();
        const completed = events.find(
          (event) =>
            event.type === "item.completed" && event.snapshot.item.type === "contextCompaction",
        );
        expect(completed).toMatchObject({ snapshot: { outcome: { status: "succeeded" } } });
        expect(
          events.some(
            (event) => event.type === "item.started" && event.item.type === "agentMessage",
          ),
        ).toBe(false);
        expect(events.at(-1)).toMatchObject({
          type: "turn.completed",
          outcome: { status: "succeeded" },
        });

        const snapshot = await session.readSnapshot();
        expect(snapshot.ok).toBe(true);
        if (snapshot.ok) {
          const turn = snapshot.value.turns[0];
          expect(turn?.input).toEqual([{ type: "text", text: "/compact" }]);
          expect(turn?.items.map(({ item }) => item.type)).toEqual(["contextCompaction"]);
        }
        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("passes /compact instructions to agy", async () => {
      const streamLines = [
        JSON.stringify({ event: "init", conversation_id: "conv-compact-2" }),
        step("conv-compact-2", 4, "checkpoint", "DONE"),
        step("conv-compact-2", 5, "agent_response", "DONE", { text_delta: "Kept the plan." }),
        result("conv-compact-2", "Kept the plan."),
      ];
      const { command, cwd, cleanup } = await fakeStreamingAgy(streamLines);
      const adapter = new AntigravityAdapter({ command });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const session = opened.value;
        const commands = session.commands;
        expect(commands).toBeDefined();
        if (!commands) return;
        const turnId = hostTurnIdSchema.parse("turn-compact-2");

        const drainPromise = drainEvents(session.outputs);
        await commands.execute({
          turnId,
          commandId: "/compact",
          arguments: { text: "keep the migration plan" },
        });
        await drainPromise;

        const snapshot = await session.readSnapshot();
        expect(snapshot.ok).toBe(true);
        if (snapshot.ok) {
          const turn = snapshot.value.turns[0];
          expect(turn?.input).toEqual([{ type: "text", text: "/compact keep the migration plan" }]);
          expect(turn?.items.map(({ item }) => item.type)).toEqual([
            "contextCompaction",
            "agentMessage",
          ]);
        }
        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("projects compaction agy starts on its own inside an ordinary Turn", async () => {
      const streamLines = [
        JSON.stringify({ event: "init", conversation_id: "conv-compact-3" }),
        step("conv-compact-3", 1, "agent_response", "ACTIVE", { text_delta: "Reading. " }),
        step("conv-compact-3", 2, "checkpoint", "ACTIVE"),
        step("conv-compact-3", 2, "checkpoint", "DONE"),
        step("conv-compact-3", 3, "agent_response", "DONE", { text_delta: "Done." }),
        result("conv-compact-3", "Reading. Done."),
      ];
      const { command, cwd, cleanup } = await fakeStreamingAgy(streamLines);
      const adapter = new AntigravityAdapter({ command });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const session = opened.value;
        const turnId = hostTurnIdSchema.parse("turn-compact-3");

        const drainPromise = drainEvents(session.outputs);
        await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "summarize the repo" }],
        });
        const events = await drainPromise;

        expect(
          events.filter(
            (event) => event.type === "item.started" && event.item.type === "contextCompaction",
          ),
        ).toHaveLength(1);
        const snapshot = await session.readSnapshot();
        expect(snapshot.ok).toBe(true);
        if (snapshot.ok) {
          const items = snapshot.value.turns[0]?.items ?? [];
          expect(items.map(({ item }) => item.type)).toEqual([
            "agentMessage",
            "contextCompaction",
            "agentMessage",
          ]);
          expect(items.every(({ outcome }) => outcome.status === "succeeded")).toBe(true);
        }
        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("fails a compaction agy reports as an error and closes one the Turn left open", async () => {
      const streamLines = [
        JSON.stringify({ event: "init", conversation_id: "conv-compact-4" }),
        step("conv-compact-4", 2, "checkpoint", "ERROR"),
        step("conv-compact-4", 3, "checkpoint", "ACTIVE"),
        result("conv-compact-4", "", "ERROR"),
      ];
      const { command, cwd, cleanup } = await fakeStreamingAgy(streamLines);
      const adapter = new AntigravityAdapter({ command });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const session = opened.value;
        const commands = session.commands;
        expect(commands).toBeDefined();
        if (!commands) return;
        const turnId = hostTurnIdSchema.parse("turn-compact-4");

        const drainPromise = drainEvents(session.outputs);
        await commands.execute({ turnId, commandId: "antigravity.compact" });
        await drainPromise;

        const snapshot = await session.readSnapshot();
        expect(snapshot.ok).toBe(true);
        if (snapshot.ok) {
          const items = snapshot.value.turns[0]?.items ?? [];
          expect(items.map(({ item, outcome }) => [item.type, outcome.status])).toEqual([
            ["contextCompaction", "failed"],
            ["contextCompaction", "failed"],
          ]);
        }
        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });
  });
});
