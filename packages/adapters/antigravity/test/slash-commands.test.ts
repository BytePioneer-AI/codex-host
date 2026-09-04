import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HarnessOutput, HostEvent } from "@codexhost/harness-adapter";
import {
  harnessCommandCatalogSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";
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
      const streamLines = [
        JSON.stringify({ event: "init", conversation_id: "conv-cmd-busy" }),
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
});
