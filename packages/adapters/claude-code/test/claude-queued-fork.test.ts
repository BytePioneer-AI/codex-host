import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  harnessIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";

import { forkClaudeSession } from "../src/claude-fork.js";
import { mapClaudeSnapshot } from "../src/claude-history.js";
import { ClaudePendingSessions } from "../src/pending-session.js";
import type { ClaudeAdapterDependencies } from "../src/transport.js";
import { historyMessage as message, queuedCommand } from "./fixtures/claude-queued-command.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function fixture(dropAttachments = false, turns = 2) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "claude-queued-fork-"));
  directories.push(cwd);
  const source: Record<string, unknown>[] = [
    message("user", "source-root", "request", "source-session"),
    queuedCommand("attachment-1", "steer-1", "repeat", "source-session"),
    queuedCommand("attachment-2", "steer-2", "repeat", "source-session"),
    message("assistant", "source-final", "response", "source-session"),
    ...(turns > 1
      ? [
          message("user", "next-root", "next request", "source-session"),
          message("assistant", "next-final", "next response", "source-session"),
        ]
      : []),
  ];
  const histories = new Map<string, Record<string, unknown>[]>([["source-session", source]]);
  const dependencies: Pick<
    ClaudeAdapterDependencies,
    "getSessionInfo" | "readSessionMessages" | "forkSession" | "deleteSession"
  > = {
    getSessionInfo: async ({ sessionId }) => (histories.has(sessionId) ? { cwd } : undefined),
    readSessionMessages: async ({ sessionId }) => structuredClone(histories.get(sessionId) ?? []),
    forkSession: vi.fn(async ({ sourceSessionId, checkpointId }) => {
      const values = histories.get(sourceSessionId);
      if (!values) throw new Error("Expected the source test Session to exist");
      const boundary = values.findIndex((entry) => entry.uuid === checkpointId);
      histories.set(
        "derived-session",
        values
          .slice(0, boundary + 1)
          .filter((entry) => !dropAttachments || entry.type !== "attachment")
          .map((entry) => ({
            ...structuredClone(entry),
            uuid: `copy-${entry.uuid as string}`,
            forkedFrom: { messageUuid: entry.uuid },
            sessionId: "derived-session",
            session_id: "derived-session",
          })),
      );
      return { sessionId: "derived-session" };
    }),
    deleteSession: vi.fn(async ({ sessionId }) => {
      histories.delete(sessionId);
    }),
  };
  const sourceRef = nativeSessionRefSchema.parse({
    harnessId: "claude-code",
    nativeSessionId: "source-session",
    formatVersion: 1,
  });
  return {
    cwd,
    source,
    sourceRef,
    histories,
    dependencies,
    harnessId: harnessIdSchema.parse("claude-code"),
    pendingSessions: new ClaudePendingSessions({ CLAUDE_CONFIG_DIR: cwd }),
  };
}

describe("Claude queued inputs at native history boundaries", () => {
  it.each(["fork", "rollbackLastTurn"] as const)(
    "retains the full steered prefix for %s",
    async (kind) => {
      const f = await fixture();
      const before = structuredClone(f.source);
      const result = await forkClaudeSession({
        cwd: f.cwd,
        sourceRef: f.sourceRef,
        harnessId: f.harnessId,
        dependencies: f.dependencies,
        ...(kind === "fork"
          ? {
              kind,
              checkpoint: nativeCheckpointRefSchema.parse({
                ...f.sourceRef,
                checkpointId: "source-final",
              }),
            }
          : { kind, pendingSessions: f.pendingSessions, configuration: {} }),
      });
      expect(result).toEqual({ ok: true, value: { sessionId: "derived-session" } });
      expect(f.dependencies.forkSession).toHaveBeenCalledWith({
        cwd: f.cwd,
        sourceSessionId: "source-session",
        checkpointId: "source-final",
      });
      const values = f.histories.get("derived-session");
      if (!values) throw new Error("Expected the derived test Session to exist");
      const derived = mapClaudeSnapshot(values, "derived-session");
      expect(derived.turns).toHaveLength(1);
      expect(derived.turns[0]).toMatchObject({
        nativeTurnRef: { nativeTurnKey: "copy-source-root" },
        checkpoint: { checkpointId: "copy-source-final" },
        items: [
          {
            item: { type: "userMessage", itemId: "copy-attachment-1", input: [{ text: "repeat" }] },
          },
          {
            item: { type: "userMessage", itemId: "copy-attachment-2", input: [{ text: "repeat" }] },
          },
          { item: { type: "agentMessage", text: "response" } },
        ],
      });
      expect(f.source).toEqual(before);
      expect(f.dependencies.deleteSession).not.toHaveBeenCalled();
    },
  );

  it("refuses an attachment UUID as a Fork checkpoint", async () => {
    const f = await fixture();
    const result = await forkClaudeSession({
      ...f,
      kind: "fork",
      checkpoint: nativeCheckpointRefSchema.parse({ ...f.sourceRef, checkpointId: "attachment-2" }),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "checkpointNotFound" } });
    expect(f.dependencies.forkSession).not.toHaveBeenCalled();
  });

  it("rejects and removes a native Fork that drops steered input", async () => {
    const f = await fixture(true);
    const before = structuredClone(f.source);
    const result = await forkClaudeSession({
      ...f,
      kind: "fork",
      checkpoint: nativeCheckpointRefSchema.parse({ ...f.sourceRef, checkpointId: "source-final" }),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "protocolError" } });
    expect(f.dependencies.deleteSession).toHaveBeenCalledWith({
      cwd: f.cwd,
      sessionId: "derived-session",
    });
    expect(f.source).toEqual(before);
  });

  it("rolls back one logical Turn containing multiple steers to a durable empty Session", async () => {
    const f = await fixture(false, 1);
    const before = structuredClone(f.source);
    const result = await forkClaudeSession({ ...f, kind: "rollbackLastTurn", configuration: {} });
    expect(result).toMatchObject({ ok: true, value: { openMode: "create" } });
    if (!result.ok || !result.value.nativeRef)
      throw new Error("Expected a durable pending Session");
    expect(await f.pendingSessions.read(result.value.nativeRef, f.cwd)).toMatchObject({
      started: false,
    });
    expect(f.dependencies.forkSession).not.toHaveBeenCalled();
    expect(f.source).toEqual(before);
  });
});
