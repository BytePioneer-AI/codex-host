import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HostEvent } from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { AntigravityAdapter } from "../src/index.js";
import {
  copyNativeConversationDbIfExists,
  nativeConversationDbPath,
} from "../src/fork.js";
import { AntigravityHistory } from "../src/history.js";

const antigravityHarnessId = harnessIdSchema.parse("antigravity");

async function fakeStreamingAgy(streamLines: readonly string[]): Promise<{
  command: string;
  cwd: string;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-fork-test-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-fork-cwd-"));
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

async function fakeMultiTurnAgy(turnStreamLines: readonly (readonly string[])[]): Promise<{
  command: string;
  cwd: string;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-fork-test-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-fork-cwd-"));
  const runsDir = path.join(directory, "runs");
  const cleanup = async (): Promise<void> => {
    for (const target of [directory, cwd]) {
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  };
  const scriptContent = `
const fs = require("node:fs");
const path = require("node:path");

if (process.argv.includes("models") || process.argv.some((arg) => arg.includes("--print=/usage") || arg.includes("/usage"))) {
  if (process.argv.includes("models")) {
    process.stdout.write("gemini-3.7-flash\\tGemini 3.7 Flash\\n");
  }
  process.exit(0);
}

const runsDir = ${JSON.stringify(runsDir)};
fs.mkdirSync(runsDir, { recursive: true });
const count = fs.readdirSync(runsDir).length;
fs.writeFileSync(path.join(runsDir, "run-" + count + ".txt"), JSON.stringify(process.argv) + "\\n");

const turnStreamLines = ${JSON.stringify(turnStreamLines)};
const lines = turnStreamLines[Math.min(count, turnStreamLines.length - 1)] || [];
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

describe("Antigravity Fork Session Branching", () => {
  it("advertises history.fork capability as true", async () => {
    const { command, cwd, cleanup } = await fakeStreamingAgy([]);
    const adapter = new AntigravityAdapter({ command });
    try {
      const opened = await adapter.open({ kind: "create", cwd });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;

      expect(opened.value.capabilities.history.fork).toBe(true);
      expect(opened.value.capabilities.history.forkAcrossCwd).toBe(false);
      await opened.value.close();
    } finally {
      await adapter.close();
      await cleanup();
    }
  });

  it("forks active session at checkpoint and creates isolated derived session", async () => {
    const turns = [
      [
        JSON.stringify({
          event: "init",
          init: { permission_mode: "configured" },
          conversation_id: "conv-parent-1",
        }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-parent-1",
            status: "SUCCESS",
            num_turns: 1,
            response: "Turn 1 answer",
          },
        }),
      ],
      [
        JSON.stringify({
          event: "init",
          init: { permission_mode: "configured" },
          conversation_id: "conv-parent-1",
        }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-parent-1",
            status: "SUCCESS",
            num_turns: 2,
            response: "Turn 2 answer",
          },
        }),
      ],
      [
        JSON.stringify({
          event: "init",
          init: { permission_mode: "configured" },
          conversation_id: "conv-forked",
        }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-forked",
            status: "SUCCESS",
            num_turns: 2,
            response: "Turn in forked branch",
          },
        }),
      ],
    ];

    const { command, cwd, cleanup } = await fakeMultiTurnAgy(turns);
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-fork-data-"));
    const adapter = new AntigravityAdapter({
      command,
      environment: { ...process.env, CODEXHOST_DATA_DIR: dataDir },
    });

    try {
      // 1. Open parent session and execute two turns
      const openedParent = await adapter.open({
        kind: "create",
        cwd,
        environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "thread-parent" },
      });
      expect(openedParent.ok).toBe(true);
      if (!openedParent.ok) return;
      const parentSession = openedParent.value;

      const iterator = parentSession.outputs[Symbol.asyncIterator]();
      async function drainTurn(): Promise<HostEvent[]> {
        const events: HostEvent[] = [];
        while (true) {
          const res = await iterator.next();
          if (res.done || res.value.kind !== "event") break;
          events.push(res.value.event);
          if (res.value.event.type === "turn.completed") break;
        }
        return events;
      }

      // Turn 1
      const drain1 = drainTurn();
      const turn1Result = await parentSession.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("turn-p-1"),
        input: [{ type: "text", text: "question 1" }],
      });
      expect(turn1Result.ok).toBe(true);
      const events1 = await drain1;
      const completed1 = events1.find((e) => e.type === "turn.completed");
      expect(completed1).toBeDefined();

      // Turn 2
      const drain2 = drainTurn();
      const turn2Result = await parentSession.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("turn-p-2"),
        input: [{ type: "text", text: "question 2" }],
      });
      expect(turn2Result.ok).toBe(true);
      const events2 = await drain2;
      const completed2 = events2.find((e) => e.type === "turn.completed");
      expect(completed2).toBeDefined();

      // Verify parent snapshot has 2 turns and checkpoint on turn 1
      const parentSnapshot = await parentSession.readSnapshot();
      expect(parentSnapshot.ok).toBe(true);
      if (!parentSnapshot.ok) return;
      expect(parentSnapshot.value.turns).toHaveLength(2);

      const turn1Checkpoint = parentSnapshot.value.turns[0]?.checkpoint;
      expect(turn1Checkpoint).toBeDefined();
      if (!turn1Checkpoint) return;
      expect(turn1Checkpoint.checkpointId).toBe("turn:1");

      const parentRef = parentSnapshot.value.state?.nativeRef;
      expect(parentRef).toBeDefined();
      if (!parentRef) return;

      // 2. Fork parent session at checkpoint turn:1
      const forkedResult = await adapter.open({
        kind: "fork",
        cwd,
        sourceRef: parentRef,
        checkpoint: turn1Checkpoint,
        environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "thread-child" },
      });

      expect(forkedResult.ok).toBe(true);
      if (!forkedResult.ok) return;
      const forkedSession = forkedResult.value;

      // Verify forked session has distinct native identity
      const forkedRef = forkedSession.initialState.nativeRef;
      expect(forkedRef).toBeDefined();
      expect(forkedRef?.nativeSessionId).not.toBe(parentRef.nativeSessionId);

      // Verify forked snapshot retains only turns up to checkpoint (1 turn)
      const forkedSnapshot = await forkedSession.readSnapshot();
      expect(forkedSnapshot.ok).toBe(true);
      if (!forkedSnapshot.ok) return;
      expect(forkedSnapshot.value.turns).toHaveLength(1);
      expect(forkedSnapshot.value.turns[0]?.input).toEqual([{ type: "text", text: "question 1" }]);
      expect(forkedSnapshot.value.turns[0]?.nativeTurnRef.nativeSessionId).toBe(
        forkedRef?.nativeSessionId,
      );

      // Parent session turns remain unaffected (2 turns)
      const parentSnapshotAfter = await parentSession.readSnapshot();
      expect(parentSnapshotAfter.ok).toBe(true);
      if (parentSnapshotAfter.ok) {
        expect(parentSnapshotAfter.value.turns).toHaveLength(2);
      }

      await forkedSession.close();
      await parentSession.close();
    } finally {
      await adapter.close();
      await cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("forks from sidecar history on disk when session is not in memory", async () => {
    const { command, cwd, cleanup } = await fakeStreamingAgy([]);
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-fork-disk-"));
    const env = { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "thread-disk-src" };

    try {
      // Create and persist source history sidecar on disk
      const model = harnessModelRefSchema.parse({ id: "gemini-3.7-flash" });
      const thinking = harnessThinkingOptionIdSchema.parse("high");
      const history = await AntigravityHistory.open({
        environment: env,
        nativeSessionId: "conv-disk-source",
      });
      history.setSelection(model, thinking);

      history.append({
        nativeTurnRef: {
          harnessId: antigravityHarnessId,
          nativeSessionId: "conv-disk-source",
          nativeTurnKey: "turn:1",
          formatVersion: 1,
        },
        checkpoint: {
          harnessId: antigravityHarnessId,
          nativeSessionId: "conv-disk-source",
          checkpointId: "turn:1",
          formatVersion: 1,
        },
        turnInput: [{ type: "text", text: "step 1" }],
        items: [],
        outcome: { status: "succeeded" },
        model,
      });
      history.append({
        nativeTurnRef: {
          harnessId: antigravityHarnessId,
          nativeSessionId: "conv-disk-source",
          nativeTurnKey: "turn:2",
          formatVersion: 1,
        },
        checkpoint: {
          harnessId: antigravityHarnessId,
          nativeSessionId: "conv-disk-source",
          checkpointId: "turn:2",
          formatVersion: 1,
        },
        turnInput: [{ type: "text", text: "step 2" }],
        items: [],
        outcome: { status: "succeeded" },
        model,
      });
      await history.flush();

      // Fork using AntigravityAdapter without source session in memory
      const adapter = new AntigravityAdapter({ command });
      const forked = await adapter.open({
        kind: "fork",
        cwd,
        sourceRef: {
          harnessId: antigravityHarnessId,
          nativeSessionId: "conv-disk-source",
          formatVersion: 1,
        },
        checkpoint: {
          harnessId: antigravityHarnessId,
          nativeSessionId: "conv-disk-source",
          checkpointId: "turn:1",
          formatVersion: 1,
        },
        environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "thread-disk-dst" },
      });

      expect(forked.ok).toBe(true);
      if (forked.ok) {
        const snap = await forked.value.readSnapshot();
        expect(snap.ok).toBe(true);
        if (snap.ok) {
          expect(snap.value.turns).toHaveLength(1);
          expect(snap.value.turns[0]?.input).toEqual([{ type: "text", text: "step 1" }]);
        }
        await forked.value.close();
      }
      await adapter.close();
    } finally {
      await cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("copies native conversation sqlite db file if present", async () => {
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), "codexhost-fakehome-"));
    try {
      const sourceDb = nativeConversationDbPath("source-conv-id", fakeHome);
      await (await import("node:fs/promises")).mkdir(path.dirname(sourceDb), { recursive: true });
      await writeFile(sourceDb, "SQLite format 3\0test-data");

      const copied = await copyNativeConversationDbIfExists(
        "source-conv-id",
        "derived-conv-id",
        fakeHome,
      );
      expect(copied).toBe(true);

      const derivedDb = nativeConversationDbPath("derived-conv-id", fakeHome);
      const content = await import("node:fs/promises").then((fs) => fs.readFile(derivedDb, "utf8"));
      expect(content).toBe("SQLite format 3\0test-data");
    } finally {
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  describe("Boundary & Error Cases", () => {
    it("rejects fork when checkpoint does not match source session", async () => {
      const { command, cwd, cleanup } = await fakeStreamingAgy([]);
      const adapter = new AntigravityAdapter({ command });
      try {
        const result = await adapter.open({
          kind: "fork",
          cwd,
          sourceRef: {
            harnessId: antigravityHarnessId,
            nativeSessionId: "conv-a",
            formatVersion: 1,
          },
          checkpoint: {
            harnessId: antigravityHarnessId,
            nativeSessionId: "conv-b", // Mismatched nativeSessionId
            checkpointId: "turn:1",
            formatVersion: 1,
          },
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("checkpointNotFound");
        }
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("rejects fork when checkpoint is not found in history turns", async () => {
      const { command, cwd, cleanup } = await fakeStreamingAgy([]);
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-fork-err-"));
      const env = { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "thread-err" };

      try {
        const history = await AntigravityHistory.open({
          environment: env,
          nativeSessionId: "conv-err",
        });
        history.append({
          nativeTurnRef: {
            harnessId: antigravityHarnessId,
            nativeSessionId: "conv-err",
            nativeTurnKey: "turn:1",
            formatVersion: 1,
          },
          checkpoint: {
            harnessId: antigravityHarnessId,
            nativeSessionId: "conv-err",
            checkpointId: "turn:1",
            formatVersion: 1,
          },
          turnInput: [{ type: "text", text: "turn 1" }],
          items: [],
          outcome: { status: "succeeded" },
        });
        await history.flush();

        const adapter = new AntigravityAdapter({ command });
        const result = await adapter.open({
          kind: "fork",
          cwd,
          sourceRef: {
            harnessId: antigravityHarnessId,
            nativeSessionId: "conv-err",
            formatVersion: 1,
          },
          checkpoint: {
            harnessId: antigravityHarnessId,
            nativeSessionId: "conv-err",
            checkpointId: "turn:99", // Non-existent checkpoint ID
            formatVersion: 1,
          },
          environment: env,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("checkpointNotFound");
        }
        await adapter.close();
      } finally {
        await cleanup();
        await rm(dataDir, { recursive: true, force: true });
      }
    });

    it("rejects fork for foreign harnessId", async () => {
      const { command, cwd, cleanup } = await fakeStreamingAgy([]);
      const adapter = new AntigravityAdapter({ command });
      try {
        const result = await adapter.open({
          kind: "fork",
          cwd,
          sourceRef: nativeSessionRefSchema.parse({
            harnessId: "claude-code" as "antigravity",
            nativeSessionId: "conv-foreign",
            formatVersion: 1,
          }),
          checkpoint: nativeCheckpointRefSchema.parse({
            harnessId: "claude-code" as "antigravity",
            nativeSessionId: "conv-foreign",
            checkpointId: "turn:1",
            formatVersion: 1,
          }),
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("invalidRequest");
        }
      } finally {
        await adapter.close();
        await cleanup();
      }
    });
  });
});
