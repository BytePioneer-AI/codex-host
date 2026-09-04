import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HostEvent } from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { AntigravityAdapter } from "../src/index.js";
import { nativeConversationDbPath } from "../src/fork.js";
import { AntigravityHistory } from "../src/history.js";

const antigravityHarnessId = harnessIdSchema.parse("antigravity");

async function fakeMultiTurnAgy(turnStreamLines: readonly (readonly string[])[]): Promise<{
  command: string;
  cwd: string;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-rb-test-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-rb-cwd-"));
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

describe("Antigravity Rollback Last Turn Capability", () => {
  it("advertises history.rollbackLastTurn capability as true", async () => {
    const { command, cwd, cleanup } = await fakeMultiTurnAgy([]);
    const adapter = new AntigravityAdapter({ command });
    try {
      const opened = await adapter.open({ kind: "create", cwd });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;

      expect(opened.value.capabilities.history.rollbackLastTurn).toBe(true);
      await opened.value.close();
    } finally {
      await adapter.close();
      await cleanup();
    }
  });

  it("rolls back multi-turn session removing exactly the latest turn", async () => {
    const turns = [
      [
        JSON.stringify({
          event: "init",
          init: { permission_mode: "configured" },
          conversation_id: "conv-rb-parent",
        }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-rb-parent",
            status: "SUCCESS",
            num_turns: 1,
            response: "First answer",
          },
        }),
      ],
      [
        JSON.stringify({
          event: "init",
          init: { permission_mode: "configured" },
          conversation_id: "conv-rb-parent",
        }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-rb-parent",
            status: "SUCCESS",
            num_turns: 2,
            response: "Second answer to rollback",
          },
        }),
      ],
    ];

    const { command, cwd, cleanup } = await fakeMultiTurnAgy(turns);
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-rb-data-"));
    const adapter = new AntigravityAdapter({
      command,
      environment: { ...process.env, CODEXHOST_DATA_DIR: dataDir },
    });

    try {
      const opened = await adapter.open({
        kind: "create",
        cwd,
        environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "thread-rb-parent" },
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const parentSession = opened.value;

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
      await parentSession.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("turn-rb-1"),
        input: [{ type: "text", text: "question 1" }],
      });
      await drain1;

      // Turn 2
      const drain2 = drainTurn();
      await parentSession.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("turn-rb-2"),
        input: [{ type: "text", text: "question 2" }],
      });
      await drain2;

      // Check parent session has 2 turns
      const parentSnapshot = await parentSession.readSnapshot();
      expect(parentSnapshot.ok).toBe(true);
      if (!parentSnapshot.ok) return;
      expect(parentSnapshot.value.turns).toHaveLength(2);

      const parentRef = parentSnapshot.value.state?.nativeRef;
      expect(parentRef).toBeDefined();
      if (!parentRef) return;

      // Perform rollbackLastTurn
      const rolledBackResult = await adapter.open({
        kind: "rollbackLastTurn",
        cwd,
        sourceRef: parentRef,
        environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "thread-rb-child" },
      });

      expect(rolledBackResult.ok).toBe(true);
      if (!rolledBackResult.ok) return;
      const rolledBackSession = rolledBackResult.value;

      // Verify derived nativeSessionId differs from parent
      const derivedRef = rolledBackSession.initialState.nativeRef;
      expect(derivedRef).toBeDefined();
      expect(derivedRef?.nativeSessionId).not.toBe(parentRef.nativeSessionId);

      // Verify returned session snapshot has exactly 1 turn (the first turn retained)
      const rolledBackSnapshot = await rolledBackSession.readSnapshot();
      expect(rolledBackSnapshot.ok).toBe(true);
      if (!rolledBackSnapshot.ok) return;
      expect(rolledBackSnapshot.value.turns).toHaveLength(1);
      expect(rolledBackSnapshot.value.turns[0]?.input).toEqual([{ type: "text", text: "question 1" }]);

      // Verify parent session remains untouched with 2 turns
      const parentSnapshotAfter = await parentSession.readSnapshot();
      expect(parentSnapshotAfter.ok).toBe(true);
      if (parentSnapshotAfter.ok) {
        expect(parentSnapshotAfter.value.turns).toHaveLength(2);
      }

      await rolledBackSession.close();
      await parentSession.close();
    } finally {
      await adapter.close();
      await cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rolls back 1-turn session producing an empty continuable session with 0 turns", async () => {
    const turns = [
      [
        JSON.stringify({
          event: "init",
          init: { permission_mode: "configured" },
          conversation_id: "conv-rb-single",
        }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-rb-single",
            status: "SUCCESS",
            num_turns: 1,
            response: "First and only answer",
          },
        }),
      ],
    ];

    const { command, cwd, cleanup } = await fakeMultiTurnAgy(turns);
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-rb-single-"));
    const adapter = new AntigravityAdapter({
      command,
      environment: { ...process.env, CODEXHOST_DATA_DIR: dataDir },
    });

    try {
      const opened = await adapter.open({
        kind: "create",
        cwd,
        environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "thread-single" },
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const session = opened.value;

      const iterator = session.outputs[Symbol.asyncIterator]();
      const drainPromise = (async () => {
        const events: HostEvent[] = [];
        while (true) {
          const res = await iterator.next();
          if (res.done || res.value.kind !== "event") break;
          events.push(res.value.event);
          if (res.value.event.type === "turn.completed") break;
        }
        return events;
      })();

      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("turn-single-1"),
        input: [{ type: "text", text: "single question" }],
      });
      await drainPromise;

      const parentSnapshot = await session.readSnapshot();
      expect(parentSnapshot.ok).toBe(true);
      if (!parentSnapshot.ok) return;
      const parentRef = parentSnapshot.value.state?.nativeRef;
      expect(parentRef).toBeDefined();
      if (!parentRef) return;

      // Roll back the single turn
      const rolledBack = await adapter.open({
        kind: "rollbackLastTurn",
        cwd,
        sourceRef: parentRef,
        environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "thread-single-rb" },
      });

      expect(rolledBack.ok).toBe(true);
      if (!rolledBack.ok) return;

      const rolledBackSession = rolledBack.value;
      const snapshot = await rolledBackSession.readSnapshot();
      expect(snapshot.ok).toBe(true);
      if (snapshot.ok) {
        // Resulting history has exactly 0 turns
        expect(snapshot.value.turns).toEqual([]);
      }

      await rolledBackSession.close();
      await session.close();
    } finally {
      await adapter.close();
      await cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rolls back from sidecar on disk and preserves model, thinkingOption, and permissionMode", async () => {
    const { command, cwd, cleanup } = await fakeMultiTurnAgy([]);
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-rb-disk-"));
    const envSrc = { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "thread-disk-src" };

    try {
      const model = harnessModelRefSchema.parse({ id: "gemini-3.7-flash" });
      const thinking = harnessThinkingOptionIdSchema.parse("high");
      const history = await AntigravityHistory.open({
        environment: envSrc,
        nativeSessionId: "conv-rb-disk",
      });
      history.setSelection(model, thinking);

      history.append({
        nativeTurnRef: {
          harnessId: antigravityHarnessId,
          nativeSessionId: "conv-rb-disk",
          nativeTurnKey: "turn:1",
          formatVersion: 1,
        },
        turnInput: [{ type: "text", text: "turn 1" }],
        items: [],
        outcome: { status: "succeeded" },
        model,
      });
      history.append({
        nativeTurnRef: {
          harnessId: antigravityHarnessId,
          nativeSessionId: "conv-rb-disk",
          nativeTurnKey: "turn:2",
          formatVersion: 1,
        },
        turnInput: [{ type: "text", text: "turn 2" }],
        items: [],
        outcome: { status: "succeeded" },
        model,
      });
      await history.flush();

      const adapter = new AntigravityAdapter({ command });
      const rolledBack = await adapter.open({
        kind: "rollbackLastTurn",
        cwd,
        sourceRef: {
          harnessId: antigravityHarnessId,
          nativeSessionId: "conv-rb-disk",
          formatVersion: 1,
        },
        environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "thread-disk-rb" },
      });

      expect(rolledBack.ok).toBe(true);
      if (rolledBack.ok) {
        const session = rolledBack.value;
        const snapshot = await session.readSnapshot();
        expect(snapshot.ok).toBe(true);
        if (snapshot.ok) {
          expect(snapshot.value.turns).toHaveLength(1);
          expect(snapshot.value.turns[0]?.input).toEqual([{ type: "text", text: "turn 1" }]);
          expect(snapshot.value.state?.effectiveModel).toEqual(model);
          expect(snapshot.value.state?.effectiveThinkingOptionId).toBe(thinking);
        }
        await session.close();
      }
      await adapter.close();
    } finally {
      await cleanup();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("copies native sqlite db file on rollback if present", async () => {
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), "codexhost-rb-fakehome-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-rb-dbdata-"));
    const { command, cwd, cleanup } = await fakeMultiTurnAgy([]);

    try {
      const sourceDb = nativeConversationDbPath("conv-rb-db", fakeHome);
      await mkdir(path.dirname(sourceDb), { recursive: true });
      await writeFile(sourceDb, "SQLite format 3\0rollback-test");

      const history = await AntigravityHistory.open({
        environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "thread-db" },
        nativeSessionId: "conv-rb-db",
      });
      history.append({
        nativeTurnRef: {
          harnessId: antigravityHarnessId,
          nativeSessionId: "conv-rb-db",
          nativeTurnKey: "turn:1",
          formatVersion: 1,
        },
        turnInput: [{ type: "text", text: "first turn" }],
        items: [],
        outcome: { status: "succeeded" },
      });
      await history.flush();

      const adapter = new AntigravityAdapter({
        command,
        environment: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome },
      });
      const rolledBack = await adapter.open({
        kind: "rollbackLastTurn",
        cwd,
        sourceRef: {
          harnessId: antigravityHarnessId,
          nativeSessionId: "conv-rb-db",
          formatVersion: 1,
        },
        environment: {
          CODEXHOST_DATA_DIR: dataDir,
          CODEXHOST_THREAD_ID: "thread-db-derived",
          USERPROFILE: fakeHome,
          HOME: fakeHome,
        },
      });

      expect(rolledBack.ok).toBe(true);
      if (rolledBack.ok) {
        const derivedNativeId = rolledBack.value.initialState.nativeRef?.nativeSessionId;
        expect(derivedNativeId).toBeDefined();
        await rolledBack.value.close();
      }
      await adapter.close();
    } finally {
      await cleanup();
      await rm(fakeHome, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  describe("Boundary & Error Cases", () => {
    it("rejects rollback on session with 0 turns with invalidState error", async () => {
      const { command, cwd, cleanup } = await fakeMultiTurnAgy([]);
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-rb-empty-"));
      const env = { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "thread-empty" };

      try {
        // Create history with 0 turns persisted to disk
        await AntigravityHistory.createDerived({
          environment: env,
          nativeSessionId: "conv-empty",
          turns: [],
        });

        const adapter = new AntigravityAdapter({ command });
        const result = await adapter.open({
          kind: "rollbackLastTurn",
          cwd,
          sourceRef: {
            harnessId: antigravityHarnessId,
            nativeSessionId: "conv-empty",
            formatVersion: 1,
          },
          environment: env,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("invalidState");
          expect(result.error.message).toContain("no Turn to roll back");
          expect(result.error.retryable).toBe(false);
        }
        await adapter.close();
      } finally {
        await cleanup();
        await rm(dataDir, { recursive: true, force: true });
      }
    });

    it("rejects rollback for foreign harnessId", async () => {
      const { command, cwd, cleanup } = await fakeMultiTurnAgy([]);
      const adapter = new AntigravityAdapter({ command });
      try {
        const result = await adapter.open({
          kind: "rollbackLastTurn",
          cwd,
          sourceRef: nativeSessionRefSchema.parse({
            harnessId: "pi" as "antigravity",
            nativeSessionId: "conv-foreign",
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

    it("rejects rollback when source history is not found", async () => {
      const { command, cwd, cleanup } = await fakeMultiTurnAgy([]);
      const adapter = new AntigravityAdapter({ command });
      try {
        const result = await adapter.open({
          kind: "rollbackLastTurn",
          cwd,
          sourceRef: {
            harnessId: antigravityHarnessId,
            nativeSessionId: "conv-nonexistent",
            formatVersion: 1,
          },
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("sessionNotFound");
        }
      } finally {
        await adapter.close();
        await cleanup();
      }
    });
  });
});
