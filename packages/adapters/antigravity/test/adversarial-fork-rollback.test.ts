import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HarnessSession, HostEvent } from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  type HarnessId,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { AntigravityAdapter } from "../src/index.js";
import { AntigravityHistory } from "../src/history.js";

const antigravityHarnessId = harnessIdSchema.parse("antigravity");

interface TestSession extends HarnessSession {
  readonly isActive: boolean;
  readonly history: AntigravityHistory;
}

interface MockHarnessOptions {
  turnResponses?: readonly (readonly string[])[];
  delayMs?: number;
}

async function createMockAgy(options: MockHarnessOptions = {}): Promise<{
  command: string;
  cwd: string;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-adv-test-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-adv-cwd-"));
  const runsDir = path.join(directory, "runs");
  const cleanup = async (): Promise<void> => {
    for (const target of [directory, cwd]) {
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  };

  const delayMs = options.delayMs ?? 0;
  const turnResponses = options.turnResponses ?? [];

  const scriptContent = `
const fs = require("node:fs");
const path = require("node:path");

if (process.argv.includes("models") || process.argv.some((arg) => arg.includes("--print=/usage") || arg.includes("/usage"))) {
  if (process.argv.includes("models")) {
    process.stdout.write("gemini-3.7-flash\\tGemini 3.7 Flash\\ngemini-3.7-flash-high\\tGemini 3.7 Flash (High)\\n");
  }
  process.exit(0);
}

const runsDir = ${JSON.stringify(runsDir)};
fs.mkdirSync(runsDir, { recursive: true });
const count = fs.readdirSync(runsDir).length;
fs.writeFileSync(path.join(runsDir, "run-" + count + ".txt"), JSON.stringify(process.argv) + "\\n");

const convIdx = process.argv.indexOf("--conversation");
const effectiveConvId = convIdx !== -1 ? process.argv[convIdx + 1] : "default-conv-" + count;

const turnResponses = ${JSON.stringify(turnResponses)};
const delay = ${delayMs};

function emit() {
  const rawLines = turnResponses[Math.min(count, turnResponses.length - 1)] || [];
  for (const rawLine of rawLines) {
    try {
      const parsed = JSON.parse(rawLine);
      if (parsed.conversation_id) {
        parsed.conversation_id = effectiveConvId;
      }
      if (parsed.result && parsed.result.conversation_id) {
        parsed.result.conversation_id = effectiveConvId;
      }
      if (parsed.step_update && parsed.step_update.conversation_id) {
        parsed.step_update.conversation_id = effectiveConvId;
      }
      process.stdout.write(JSON.stringify(parsed) + "\\n");
    } catch {
      process.stdout.write(rawLine + "\\n");
    }
  }
}

if (delay > 0) {
  setTimeout(emit, delay);
} else {
  emit();
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

class SessionEventConsumer {
  readonly #iterator: AsyncIterator<{ kind: string; event?: HostEvent }>;

  constructor(session: HarnessSession) {
    this.#iterator = session.outputs[Symbol.asyncIterator]();
  }

  async drainTurn(): Promise<HostEvent[]> {
    const events: HostEvent[] = [];
    while (true) {
      const res = await this.#iterator.next();
      if (res.done || res.value.kind !== "event") break;
      if (res.value.event) {
        events.push(res.value.event);
        if (res.value.event.type === "turn.completed") break;
      }
    }
    return events;
  }
}

describe("Empirical Adversarial Challenges: Fork & Rollback", () => {
  describe("1. Forking from First, Middle, and Last Turn", () => {
    it("forks at first turn (1 of 3), middle turn (2 of 3), and last turn (3 of 3)", async () => {
      const turns = [
        [
          JSON.stringify({
            event: "init",
            conversation_id: "p",
            init: { permission_mode: "configured" },
          }),
          JSON.stringify({
            event: "result",
            result: { conversation_id: "p", status: "SUCCESS", num_turns: 1, response: "Answer 1" },
          }),
        ],
        [
          JSON.stringify({
            event: "init",
            conversation_id: "p",
            init: { permission_mode: "configured" },
          }),
          JSON.stringify({
            event: "result",
            result: { conversation_id: "p", status: "SUCCESS", num_turns: 2, response: "Answer 2" },
          }),
        ],
        [
          JSON.stringify({
            event: "init",
            conversation_id: "p",
            init: { permission_mode: "configured" },
          }),
          JSON.stringify({
            event: "result",
            result: { conversation_id: "p", status: "SUCCESS", num_turns: 3, response: "Answer 3" },
          }),
        ],
      ];

      const { command, cwd, cleanup } = await createMockAgy({ turnResponses: turns });
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-adv-fork3-"));
      const adapter = new AntigravityAdapter({
        command,
        environment: { ...process.env, CODEXHOST_DATA_DIR: dataDir },
      });

      try {
        const openedParent = await adapter.open({
          kind: "create",
          cwd,
          environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "thread-p3" },
        });
        expect(openedParent.ok).toBe(true);
        if (!openedParent.ok) return;
        const parent = openedParent.value;
        const parentConsumer = new SessionEventConsumer(parent);

        // Run 3 turns
        for (let i = 1; i <= 3; i++) {
          const drain = parentConsumer.drainTurn();
          const turnRes = await parent.execute({
            type: "turn.start",
            turnId: hostTurnIdSchema.parse(`turn-p3-${i}`),
            input: [{ type: "text", text: `prompt ${i}` }],
          });
          expect(turnRes.ok).toBe(true);
          await drain;
        }

        const parentSnap = await parent.readSnapshot();
        expect(parentSnap.ok).toBe(true);
        if (!parentSnap.ok) return;
        expect(parentSnap.value.turns).toHaveLength(3);

        const parentRef = parentSnap.value.state?.nativeRef;
        expect(parentRef).toBeDefined();
        if (!parentRef) return;

        const cp1 = parentSnap.value.turns[0]?.checkpoint;
        const cp2 = parentSnap.value.turns[1]?.checkpoint;
        const cp3 = parentSnap.value.turns[2]?.checkpoint;
        expect(cp1?.checkpointId).toBe("turn:1");
        expect(cp2?.checkpointId).toBe("turn:2");
        expect(cp3?.checkpointId).toBe("turn:3");
        if (!cp1 || !cp2 || !cp3) return;

        // 1A. Fork at First Turn (checkpoint turn:1)
        const fork1 = await adapter.open({
          kind: "fork",
          cwd,
          sourceRef: parentRef,
          checkpoint: cp1,
          environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "thread-fork-1" },
        });
        expect(fork1.ok).toBe(true);
        if (fork1.ok) {
          const snap1 = await fork1.value.readSnapshot();
          expect(snap1.ok).toBe(true);
          if (snap1.ok) {
            expect(snap1.value.turns).toHaveLength(1);
            expect(snap1.value.turns[0]?.input).toEqual([{ type: "text", text: "prompt 1" }]);
            expect(snap1.value.turns[0]?.checkpoint?.nativeSessionId).toBe(
              fork1.value.initialState.nativeRef?.nativeSessionId,
            );
          }
          await fork1.value.close();
        }

        // 1B. Fork at Middle Turn (checkpoint turn:2)
        const fork2 = await adapter.open({
          kind: "fork",
          cwd,
          sourceRef: parentRef,
          checkpoint: cp2,
          environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "thread-fork-2" },
        });
        expect(fork2.ok).toBe(true);
        if (fork2.ok) {
          const snap2 = await fork2.value.readSnapshot();
          expect(snap2.ok).toBe(true);
          if (snap2.ok) {
            expect(snap2.value.turns).toHaveLength(2);
            expect(snap2.value.turns[0]?.input).toEqual([{ type: "text", text: "prompt 1" }]);
            expect(snap2.value.turns[1]?.input).toEqual([{ type: "text", text: "prompt 2" }]);
            expect(snap2.value.turns[0]?.checkpoint?.nativeSessionId).toBe(
              fork2.value.initialState.nativeRef?.nativeSessionId,
            );
            expect(snap2.value.turns[1]?.checkpoint?.nativeSessionId).toBe(
              fork2.value.initialState.nativeRef?.nativeSessionId,
            );
          }
          await fork2.value.close();
        }

        // 1C. Fork at Last Turn (checkpoint turn:3)
        const fork3 = await adapter.open({
          kind: "fork",
          cwd,
          sourceRef: parentRef,
          checkpoint: cp3,
          environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "thread-fork-3" },
        });
        expect(fork3.ok).toBe(true);
        if (fork3.ok) {
          const snap3 = await fork3.value.readSnapshot();
          expect(snap3.ok).toBe(true);
          if (snap3.ok) {
            expect(snap3.value.turns).toHaveLength(3);
            expect(snap3.value.turns[0]?.input).toEqual([{ type: "text", text: "prompt 1" }]);
            expect(snap3.value.turns[1]?.input).toEqual([{ type: "text", text: "prompt 2" }]);
            expect(snap3.value.turns[2]?.input).toEqual([{ type: "text", text: "prompt 3" }]);
          }
          await fork3.value.close();
        }

        // Verify parent session remained completely unchanged with 3 turns
        const parentFinal = await parent.readSnapshot();
        expect(parentFinal.ok).toBe(true);
        if (parentFinal.ok) {
          expect(parentFinal.value.turns).toHaveLength(3);
        }
        await parent.close();
      } finally {
        await adapter.close();
        await cleanup();
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  });

  describe("2. Non-existent Checkpoint and Mismatched Session ID", () => {
    it("rejects non-existent checkpoint with checkpointNotFound", async () => {
      const { command, cwd, cleanup } = await createMockAgy();
      const adapter = new AntigravityAdapter({ command });
      try {
        const sourceRef = nativeSessionRefSchema.parse({
          harnessId: antigravityHarnessId,
          nativeSessionId: "conv-exist",
          formatVersion: 1,
        });
        const fakeCheckpoint = nativeCheckpointRefSchema.parse({
          harnessId: antigravityHarnessId,
          nativeSessionId: "conv-exist",
          checkpointId: "turn:99999",
          formatVersion: 1,
        });

        // Set up on disk
        const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-adv-cpnotfound-"));
        const env = { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "th-exist" };
        const history = await AntigravityHistory.open({
          environment: env,
          nativeSessionId: "conv-exist",
        });
        history.append({
          nativeTurnRef: {
            harnessId: antigravityHarnessId,
            nativeSessionId: "conv-exist",
            nativeTurnKey: "turn:1",
            formatVersion: 1,
          },
          checkpoint: {
            harnessId: antigravityHarnessId,
            nativeSessionId: "conv-exist",
            checkpointId: "turn:1",
            formatVersion: 1,
          },
          turnInput: [{ type: "text", text: "hi" }],
          items: [],
          outcome: { status: "succeeded" },
        });
        await history.flush();

        const res = await adapter.open({
          kind: "fork",
          cwd,
          sourceRef,
          checkpoint: fakeCheckpoint,
          environment: env,
        });
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe("checkpointNotFound");
          expect(res.error.retryable).toBe(false);
        }
        await rm(dataDir, { recursive: true, force: true });
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("rejects mismatched session ID on checkpoint with checkpointNotFound", async () => {
      const { command, cwd, cleanup } = await createMockAgy();
      const adapter = new AntigravityAdapter({ command });
      try {
        const sourceRef = nativeSessionRefSchema.parse({
          harnessId: antigravityHarnessId,
          nativeSessionId: "conv-source-alpha",
          formatVersion: 1,
        });
        const mismatchedCheckpoint = nativeCheckpointRefSchema.parse({
          harnessId: antigravityHarnessId,
          nativeSessionId: "conv-source-beta",
          checkpointId: "turn:1",
          formatVersion: 1,
        });

        const res = await adapter.open({
          kind: "fork",
          cwd,
          sourceRef,
          checkpoint: mismatchedCheckpoint,
        });
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe("checkpointNotFound");
          expect(res.error.message).toContain("does not belong to the source Native Session");
        }
      } finally {
        await adapter.close();
        await cleanup();
      }
    });
  });

  describe("3. Isolation: Fork Execution Independence", () => {
    it("ensures executing turns on forked session does not modify parent history file or state", async () => {
      const turns = [
        // Parent Turn 1
        [
          JSON.stringify({
            event: "init",
            conversation_id: "p",
            init: { permission_mode: "configured" },
          }),
          JSON.stringify({
            event: "result",
            result: { conversation_id: "p", status: "SUCCESS", num_turns: 1, response: "P1 ans" },
          }),
        ],
        // Parent Turn 2
        [
          JSON.stringify({
            event: "init",
            conversation_id: "p",
            init: { permission_mode: "configured" },
          }),
          JSON.stringify({
            event: "result",
            result: { conversation_id: "p", status: "SUCCESS", num_turns: 2, response: "P2 ans" },
          }),
        ],
        // Forked Turn (executed on child)
        [
          JSON.stringify({
            event: "init",
            conversation_id: "c",
            init: { permission_mode: "configured" },
          }),
          JSON.stringify({
            event: "result",
            result: {
              conversation_id: "c",
              status: "SUCCESS",
              num_turns: 2,
              response: "Child branched turn",
            },
          }),
        ],
      ];

      const { command, cwd, cleanup } = await createMockAgy({ turnResponses: turns });
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-adv-iso-"));
      const parentThreadId = "thread-parent-isolation";
      const childThreadId = "thread-child-isolation";
      const adapter = new AntigravityAdapter({
        command,
        environment: { ...process.env, CODEXHOST_DATA_DIR: dataDir },
      });

      try {
        const parentOpened = await adapter.open({
          kind: "create",
          cwd,
          environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: parentThreadId },
        });
        expect(parentOpened.ok).toBe(true);
        if (!parentOpened.ok) return;
        const parent = parentOpened.value as unknown as TestSession;
        const parentConsumer = new SessionEventConsumer(parent);

        // Execute 2 turns on parent
        for (let i = 1; i <= 2; i++) {
          const drain = parentConsumer.drainTurn();
          await parent.execute({
            type: "turn.start",
            turnId: hostTurnIdSchema.parse(`p-turn-${i}`),
            input: [{ type: "text", text: `parent turn ${i}` }],
          });
          await drain;
        }

        const parentSnapBeforeFork = await parent.readSnapshot();
        expect(parentSnapBeforeFork.ok).toBe(true);
        if (!parentSnapBeforeFork.ok) return;
        expect(parentSnapBeforeFork.value.turns).toHaveLength(2);

        await parent.history.flush();
        const parentFile = path.join(dataDir, "antigravity-history", `${parentThreadId}.json`);
        const parentFileContentBefore = await readFile(parentFile, "utf8");

        const parentRef = parentSnapBeforeFork.value.state?.nativeRef;
        const cp1 = parentSnapBeforeFork.value.turns[0]?.checkpoint;
        expect(parentRef).toBeDefined();
        expect(cp1).toBeDefined();
        if (!parentRef || !cp1) return;

        // Fork from turn 1
        const forkedOpened = await adapter.open({
          kind: "fork",
          cwd,
          sourceRef: parentRef,
          checkpoint: cp1,
          environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: childThreadId },
        });
        expect(forkedOpened.ok).toBe(true);
        if (!forkedOpened.ok) return;
        const forked = forkedOpened.value as unknown as TestSession;
        const forkedConsumer = new SessionEventConsumer(forked);

        // Execute a new turn ON THE FORKED SESSION
        const drainFork = forkedConsumer.drainTurn();
        const forkTurnRes = await forked.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("fork-turn-x"),
          input: [{ type: "text", text: "branch divergent turn" }],
        });
        expect(forkTurnRes.ok).toBe(true);
        await drainFork;

        // Verify child session snapshot has 2 turns: Turn 1 (retained) + Child Turn
        const childSnap = await forked.readSnapshot();
        expect(childSnap.ok).toBe(true);
        if (childSnap.ok) {
          expect(childSnap.value.turns).toHaveLength(2);
          expect(childSnap.value.turns[0]?.input).toEqual([
            { type: "text", text: "parent turn 1" },
          ]);
          expect(childSnap.value.turns[1]?.input).toEqual([
            { type: "text", text: "branch divergent turn" },
          ]);
        }

        await forked.history.flush();
        // Verify child file on disk has 2 turns
        const childFile = path.join(dataDir, "antigravity-history", `${childThreadId}.json`);
        const childFileContent = JSON.parse(await readFile(childFile, "utf8")) as {
          turns: unknown[];
        };
        expect(childFileContent.turns).toHaveLength(2);

        // VERIFY PARENT SESSION IS 100% UNTOUCHED
        const parentSnapAfter = await parent.readSnapshot();
        expect(parentSnapAfter.ok).toBe(true);
        if (parentSnapAfter.ok) {
          expect(parentSnapAfter.value.turns).toHaveLength(2);
          expect(parentSnapAfter.value.turns[0]?.input).toEqual([
            { type: "text", text: "parent turn 1" },
          ]);
          expect(parentSnapAfter.value.turns[1]?.input).toEqual([
            { type: "text", text: "parent turn 2" },
          ]);
        }

        const parentFileContentAfter = await readFile(parentFile, "utf8");
        expect(parentFileContentAfter).toBe(parentFileContentBefore);

        await forked.close();
        await parent.close();
      } finally {
        await adapter.close();
        await cleanup();
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  });

  describe("4. Rollback: 0-turn, 1-turn, and Multi-turn", () => {
    it("fails with invalidState when rolling back a session with 0 completed turns", async () => {
      const { command, cwd, cleanup } = await createMockAgy();
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-adv-rb0-"));
      const env = { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "thread-rb0" };
      const adapter = new AntigravityAdapter({ command });

      try {
        // Create 0-turn session history in persistence
        await AntigravityHistory.createDerived({
          environment: env,
          nativeSessionId: "conv-0turns-on-disk",
          turns: [],
        });

        const rb = await adapter.open({
          kind: "rollbackLastTurn",
          cwd,
          sourceRef: {
            harnessId: antigravityHarnessId,
            nativeSessionId: "conv-0turns-on-disk",
            formatVersion: 1,
          },
          environment: env,
        });

        expect(rb.ok).toBe(false);
        if (!rb.ok) {
          expect(rb.error.code).toBe("invalidState");
          expect(rb.error.message).toContain("no Turn to roll back");
          expect(rb.error.retryable).toBe(false);
        }
      } finally {
        await adapter.close();
        await cleanup();
        await rm(dataDir, { recursive: true, force: true });
      }
    });

    it("rolls back 1-turn session to 0 turns and allows executing a new turn on rolled-back session", async () => {
      const turns = [
        [
          JSON.stringify({
            event: "init",
            conversation_id: "init-1",
            init: { permission_mode: "configured" },
          }),
          JSON.stringify({
            event: "result",
            result: {
              conversation_id: "init-1",
              status: "SUCCESS",
              num_turns: 1,
              response: "Old turn 1",
            },
          }),
        ],
        [
          JSON.stringify({
            event: "init",
            conversation_id: "init-2",
            init: { permission_mode: "configured" },
          }),
          JSON.stringify({
            event: "result",
            result: {
              conversation_id: "init-2",
              status: "SUCCESS",
              num_turns: 1,
              response: "New turn 1",
            },
          }),
        ],
      ];

      const { command, cwd, cleanup } = await createMockAgy({ turnResponses: turns });
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-adv-rb1-"));
      const adapter = new AntigravityAdapter({ command });

      try {
        const opened = await adapter.open({
          kind: "create",
          cwd,
          environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "th-rb1-src" },
        });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const session = opened.value;
        const sessionConsumer = new SessionEventConsumer(session);

        // Run 1 turn
        const drain1 = sessionConsumer.drainTurn();
        await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("t1"),
          input: [{ type: "text", text: "first turn" }],
        });
        await drain1;

        const snap1 = await session.readSnapshot();
        expect(snap1.ok).toBe(true);
        if (!snap1.ok) return;
        expect(snap1.value.turns).toHaveLength(1);

        const sourceRef = snap1.value.state?.nativeRef;
        expect(sourceRef).toBeDefined();
        if (!sourceRef) return;

        // Roll back
        const rb = await adapter.open({
          kind: "rollbackLastTurn",
          cwd,
          sourceRef,
          environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "th-rb1-dst" },
        });
        expect(rb.ok).toBe(true);
        if (!rb.ok) return;
        const rolledBackSession = rb.value;
        const rbConsumer = new SessionEventConsumer(rolledBackSession);

        // Read snapshot of rolled back session: 0 turns
        const rbSnap = await rolledBackSession.readSnapshot();
        expect(rbSnap.ok).toBe(true);
        if (rbSnap.ok) {
          expect(rbSnap.value.turns).toHaveLength(0);
        }

        // Execute a new replacement turn on the rolled back session
        const drain2 = rbConsumer.drainTurn();
        const execRes = await rolledBackSession.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("replacement-t1"),
          input: [{ type: "text", text: "replacement first turn" }],
        });
        expect(execRes.ok).toBe(true);
        await drain2;

        const snapAfterExec = await rolledBackSession.readSnapshot();
        expect(snapAfterExec.ok).toBe(true);
        if (snapAfterExec.ok) {
          expect(snapAfterExec.value.turns).toHaveLength(1);
          expect(snapAfterExec.value.turns[0]?.input).toEqual([
            { type: "text", text: "replacement first turn" },
          ]);
        }

        await rolledBackSession.close();
        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  });

  describe("5. Consecutive Rollbacks", () => {
    it("handles consecutive rollbacks: 3 -> 2 -> 1 -> 0 -> failure", async () => {
      const turns = [
        [
          JSON.stringify({
            event: "init",
            conversation_id: "c",
            init: { permission_mode: "configured" },
          }),
          JSON.stringify({
            event: "result",
            result: { conversation_id: "c", status: "SUCCESS", num_turns: 1, response: "R1" },
          }),
        ],
        [
          JSON.stringify({
            event: "init",
            conversation_id: "c",
            init: { permission_mode: "configured" },
          }),
          JSON.stringify({
            event: "result",
            result: { conversation_id: "c", status: "SUCCESS", num_turns: 2, response: "R2" },
          }),
        ],
        [
          JSON.stringify({
            event: "init",
            conversation_id: "c",
            init: { permission_mode: "configured" },
          }),
          JSON.stringify({
            event: "result",
            result: { conversation_id: "c", status: "SUCCESS", num_turns: 3, response: "R3" },
          }),
        ],
      ];

      const { command, cwd, cleanup } = await createMockAgy({ turnResponses: turns });
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-adv-crb-"));
      const adapter = new AntigravityAdapter({ command });

      try {
        // Build a 3-turn session
        const opened = await adapter.open({
          kind: "create",
          cwd,
          environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "th-consec-0" },
        });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const session3 = opened.value;
        const consumer3 = new SessionEventConsumer(session3);

        for (let i = 1; i <= 3; i++) {
          const drain = consumer3.drainTurn();
          await session3.execute({
            type: "turn.start",
            turnId: hostTurnIdSchema.parse(`t-${i}`),
            input: [{ type: "text", text: `turn ${i}` }],
          });
          await drain;
        }

        const snap3 = await session3.readSnapshot();
        expect(snap3.ok).toBe(true);
        if (!snap3.ok) return;
        expect(snap3.value.turns).toHaveLength(3);
        const ref3 = snap3.value.state?.nativeRef;
        expect(ref3).toBeDefined();
        if (!ref3) return;

        // Rollback 1: 3 -> 2
        const rb2 = await adapter.open({
          kind: "rollbackLastTurn",
          cwd,
          sourceRef: ref3,
          environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "th-consec-1" },
        });
        expect(rb2.ok).toBe(true);
        if (!rb2.ok) return;
        const session2 = rb2.value;
        const snap2 = await session2.readSnapshot();
        expect(snap2.ok && snap2.value.turns.length === 2).toBe(true);
        const ref2 = session2.initialState.nativeRef;
        expect(ref2).toBeDefined();
        if (!ref2) return;

        // Rollback 2: 2 -> 1
        const rb1 = await adapter.open({
          kind: "rollbackLastTurn",
          cwd,
          sourceRef: ref2,
          environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "th-consec-2" },
        });
        expect(rb1.ok).toBe(true);
        if (!rb1.ok) return;
        const session1 = rb1.value;
        const snap1 = await session1.readSnapshot();
        expect(snap1.ok && snap1.value.turns.length === 1).toBe(true);
        const ref1 = session1.initialState.nativeRef;
        expect(ref1).toBeDefined();
        if (!ref1) return;

        // Rollback 3: 1 -> 0
        const rb0 = await adapter.open({
          kind: "rollbackLastTurn",
          cwd,
          sourceRef: ref1,
          environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "th-consec-3" },
        });
        expect(rb0.ok).toBe(true);
        if (!rb0.ok) return;
        const session0 = rb0.value;
        const snap0 = await session0.readSnapshot();
        expect(snap0.ok && snap0.value.turns.length === 0).toBe(true);
        const ref0 = session0.initialState.nativeRef;
        expect(ref0).toBeDefined();
        if (!ref0) return;

        // Rollback 4: 0 -> MUST FAIL with invalidState
        const rbFail = await adapter.open({
          kind: "rollbackLastTurn",
          cwd,
          sourceRef: ref0,
          environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "th-consec-4" },
        });
        expect(rbFail.ok).toBe(false);
        if (!rbFail.ok) {
          expect(rbFail.error.code).toBe("invalidState");
          expect(rbFail.error.message).toContain("no Turn to roll back");
        }

        await session0.close();
        await session1.close();
        await session2.close();
        await session3.close();
      } finally {
        await adapter.close();
        await cleanup();
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  });

  describe("6. Foreign Harness ID Rejection", () => {
    it("rejects fork and rollback for foreign harness IDs with invalidRequest", async () => {
      const { command, cwd, cleanup } = await createMockAgy();
      const adapter = new AntigravityAdapter({ command });
      try {
        const foreignHarnessId = "claude-code" as unknown as HarnessId;
        const foreignSession = nativeSessionRefSchema.parse({
          harnessId: foreignHarnessId,
          nativeSessionId: "foreign-session-123",
          formatVersion: 1,
        });
        const foreignCheckpoint = nativeCheckpointRefSchema.parse({
          harnessId: foreignHarnessId,
          nativeSessionId: "foreign-session-123",
          checkpointId: "turn:1",
          formatVersion: 1,
        });

        // Fork with foreign sourceRef
        const forkRes = await adapter.open({
          kind: "fork",
          cwd,
          sourceRef: foreignSession,
          checkpoint: foreignCheckpoint,
        });
        expect(forkRes.ok).toBe(false);
        if (!forkRes.ok) {
          expect(forkRes.error.code).toBe("invalidRequest");
          expect(forkRes.error.message).toContain("cannot fork another Harness Session");
        }

        // Rollback with foreign sourceRef
        const rbRes = await adapter.open({
          kind: "rollbackLastTurn",
          cwd,
          sourceRef: foreignSession,
        });
        expect(rbRes.ok).toBe(false);
        if (!rbRes.ok) {
          expect(rbRes.error.code).toBe("invalidRequest");
          expect(rbRes.error.message).toContain("cannot roll back another Harness Session");
        }
      } finally {
        await adapter.close();
        await cleanup();
      }
    });
  });

  describe("7. Session Busy Guard on Fork and Rollback", () => {
    it("rejects fork and rollback when a turn is actively in-flight on the source session", async () => {
      const turns = [
        [
          JSON.stringify({
            event: "init",
            conversation_id: "busy",
            init: { permission_mode: "configured" },
          }),
          JSON.stringify({
            event: "result",
            result: { conversation_id: "busy", status: "SUCCESS", num_turns: 1, response: "Done" },
          }),
        ],
        [
          JSON.stringify({
            event: "init",
            conversation_id: "busy",
            init: { permission_mode: "configured" },
          }),
          JSON.stringify({
            event: "result",
            result: {
              conversation_id: "busy",
              status: "SUCCESS",
              num_turns: 2,
              response: "Slow done",
            },
          }),
        ],
      ];

      // Delay turn by 500ms so we can test busy state
      const { command, cwd, cleanup } = await createMockAgy({ turnResponses: turns, delayMs: 500 });
      const adapter = new AntigravityAdapter({ command });

      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const session = opened.value as unknown as TestSession;
        const consumer = new SessionEventConsumer(session);

        // Complete turn 1 first to establish a checkpoint
        const drain1 = consumer.drainTurn();
        await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("t1"),
          input: [{ type: "text", text: "t1" }],
        });
        await drain1;

        const snap1 = await session.readSnapshot();
        expect(snap1.ok).toBe(true);
        if (!snap1.ok) return;
        const sourceRef = snap1.value.state?.nativeRef;
        const cp1 = snap1.value.turns[0]?.checkpoint;
        expect(sourceRef).toBeDefined();
        expect(cp1).toBeDefined();
        if (!sourceRef || !cp1) return;

        // Start turn 2 (will take 500ms due to delayMs)
        const drain2Promise = consumer.drainTurn();
        const start2 = await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("t2"),
          input: [{ type: "text", text: "t2 slow" }],
        });
        expect(start2.ok).toBe(true);

        // While turn 2 is actively running:
        expect(session.isActive).toBe(true);

        // 7A. Test Fork while active
        const busyFork = await adapter.open({
          kind: "fork",
          cwd,
          sourceRef,
          checkpoint: cp1,
        });
        expect(busyFork.ok).toBe(false);
        if (!busyFork.ok) {
          expect(busyFork.error.code).toBe("sessionBusy");
          expect(busyFork.error.retryable).toBe(true);
        }

        // 7B. Test Rollback while active
        const busyRb = await adapter.open({
          kind: "rollbackLastTurn",
          cwd,
          sourceRef,
        });
        expect(busyRb.ok).toBe(false);
        if (!busyRb.ok) {
          expect(busyRb.error.code).toBe("sessionBusy");
          expect(busyRb.error.retryable).toBe(true);
        }

        // Wait for turn 2 to finish cleanly
        await drain2Promise;
        expect(session.isActive).toBe(false);

        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });
  });

  describe("8. Concurrent Forks and Configuration Continuity", () => {
    it("allows concurrent forks from the same checkpoint and preserves session configuration", async () => {
      const turns = [
        [
          JSON.stringify({
            event: "init",
            conversation_id: "cfg",
            init: { permission_mode: "dangerously-skip-permissions" },
          }),
          JSON.stringify({
            event: "result",
            result: { conversation_id: "cfg", status: "SUCCESS", num_turns: 1, response: "Done" },
          }),
        ],
      ];

      const { command, cwd, cleanup } = await createMockAgy({ turnResponses: turns });
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-adv-cfg-"));
      const adapter = new AntigravityAdapter({ command });

      try {
        const model = harnessModelRefSchema.parse({ id: "gemini-3.7-flash" });
        const thinkingOptionId = harnessThinkingOptionIdSchema.parse("high");
        const dangerousModeId = harnessPermissionModeIdSchema.parse("dangerously-skip-permissions");

        const opened = await adapter.open({
          kind: "create",
          cwd,
          model,
          thinkingOptionId,
          permissionModeId: dangerousModeId,
          environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "th-cfg-parent" },
        });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;
        const session = opened.value;
        const consumer = new SessionEventConsumer(session);

        // Run turn 1
        const drain = consumer.drainTurn();
        await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("t1"),
          input: [{ type: "text", text: "t1" }],
        });
        await drain;

        const snap = await session.readSnapshot();
        expect(snap.ok).toBe(true);
        if (!snap.ok) return;
        const sourceRef = snap.value.state?.nativeRef;
        const cp = snap.value.turns[0]?.checkpoint;
        expect(sourceRef).toBeDefined();
        expect(cp).toBeDefined();
        if (!sourceRef || !cp) return;

        // Fork concurrently into branch A and branch B
        const [forkA, forkB] = await Promise.all([
          adapter.open({
            kind: "fork",
            cwd,
            sourceRef,
            checkpoint: cp,
            environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "th-branch-a" },
          }),
          adapter.open({
            kind: "fork",
            cwd,
            sourceRef,
            checkpoint: cp,
            environment: { CODEXHOST_DATA_DIR: dataDir, CODEXHOST_THREAD_ID: "th-branch-b" },
          }),
        ]);

        expect(forkA.ok).toBe(true);
        expect(forkB.ok).toBe(true);
        if (!forkA.ok || !forkB.ok) return;

        const idA = forkA.value.initialState.nativeRef?.nativeSessionId;
        const idB = forkB.value.initialState.nativeRef?.nativeSessionId;
        expect(idA).toBeDefined();
        expect(idB).toBeDefined();
        expect(idA).not.toBe(idB);
        expect(idA).not.toBe(sourceRef.nativeSessionId);
        expect(idB).not.toBe(sourceRef.nativeSessionId);

        // Verify configuration was preserved
        expect(forkA.value.initialState.effectiveModel).toEqual(model);
        expect(forkA.value.initialState.effectiveThinkingOptionId).toBe(thinkingOptionId);
        expect(forkA.value.initialState.effectivePermissionModeId).toBe(
          "dangerously-skip-permissions",
        );

        expect(forkB.value.initialState.effectiveModel).toEqual(model);
        expect(forkB.value.initialState.effectiveThinkingOptionId).toBe(thinkingOptionId);
        expect(forkB.value.initialState.effectivePermissionModeId).toBe(
          "dangerously-skip-permissions",
        );

        await forkA.value.close();
        await forkB.value.close();
        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  });
});
