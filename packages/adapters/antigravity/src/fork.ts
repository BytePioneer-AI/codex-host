import { randomUUID } from "node:crypto";
import { copyFile, cp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { ForkSessionInput, HarnessResult, HarnessSession } from "@codexhost/harness-adapter";
import {
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  type HarnessId,
  type HarnessModelRef,
  type HarnessThinkingOptionId,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import { AntigravityHistory, type AntigravityTurn } from "./history.js";
import type { AntigravityPermissionMode } from "./permission-modes.js";

export function nativeConversationDbPath(nativeSessionId: string, homedir = os.homedir()): string {
  return path.join(homedir, ".gemini", "antigravity-cli", "conversations", `${nativeSessionId}.db`);
}

export function nativeBrainDirPath(nativeSessionId: string, homedir = os.homedir()): string {
  return path.join(homedir, ".gemini", "antigravity-cli", "brain", nativeSessionId);
}

export async function cloneNativeConversationDb(
  sourceSessionId: string,
  derivedSessionId: string,
  retainedTurnsCountOrHomedir?: number | string,
  homedirOption = os.homedir(),
): Promise<boolean> {
  let retainedTurnsCount: number | undefined;
  let homedir = homedirOption;
  if (typeof retainedTurnsCountOrHomedir === "string") {
    homedir = retainedTurnsCountOrHomedir;
  } else if (typeof retainedTurnsCountOrHomedir === "number") {
    retainedTurnsCount = retainedTurnsCountOrHomedir;
  }

  const sourceDb = nativeConversationDbPath(sourceSessionId, homedir);
  const targetDb = nativeConversationDbPath(derivedSessionId, homedir);
  try {
    await mkdir(path.dirname(targetDb), { recursive: true });
    await copyFile(sourceDb, targetDb);
  } catch {
    return false;
  }

  try {
    const db = new DatabaseSync(targetDb);
    try {
      db.prepare("UPDATE trajectory_meta SET cascade_id = ?").run(derivedSessionId);
      if (retainedTurnsCount !== undefined) {
        try {
          if (retainedTurnsCount === 0) {
            db.prepare("DELETE FROM steps").run();
          } else {
            // In agy, each turn begins with a user_input step (step_type = 14)
            const rows = db
              .prepare("SELECT idx FROM steps WHERE step_type = 14 ORDER BY idx ASC")
              .all() as Array<{ idx: number }>;
            const cutoff = rows[retainedTurnsCount];
            if (cutoff) {
              db.prepare("DELETE FROM steps WHERE idx >= ?").run(cutoff.idx);
            }
          }
        } catch {}
        try {
          db.prepare("DELETE FROM gen_metadata WHERE idx >= ?").run(retainedTurnsCount);
        } catch {}
        try {
          db.prepare("DELETE FROM executor_metadata WHERE idx >= ?").run(retainedTurnsCount);
        } catch {}
        try {
          db.prepare("DELETE FROM parent_references WHERE idx >= ?").run(retainedTurnsCount);
        } catch {}
        try {
          db.prepare("DELETE FROM battle_mode_infos WHERE idx >= ?").run(retainedTurnsCount);
        } catch {}
      }
    } finally {
      db.close();
    }
  } catch {
    // If table updating fails, ignore
  }

  // Register in conversation_summaries.db so `agy` trajectory lookup succeeds
  try {
    const summariesDbPath = path.join(
      homedir,
      ".gemini",
      "antigravity-cli",
      "conversation_summaries.db",
    );
    const sumDb = new DatabaseSync(summariesDbPath);
    try {
      const cur = sumDb.prepare("SELECT * FROM conversation_summaries WHERE conversation_id = ?");
      const row = cur.get(sourceSessionId) as Record<string, unknown> | undefined;
      if (row) {
        let remainingStepCount = 0;
        try {
          const countDb = new DatabaseSync(targetDb);
          try {
            const countRow = countDb.prepare("SELECT count(*) as c FROM steps").get() as
              { c: number } | undefined;
            if (countRow) remainingStepCount = countRow.c;
          } finally {
            countDb.close();
          }
        } catch {}

        const cols = Object.keys(row);
        const newRow: Record<string, unknown> = {
          ...row,
          conversation_id: derivedSessionId,
          last_modified_time: new Date().toISOString(),
          ...(retainedTurnsCount !== undefined ? { step_count: remainingStepCount } : {}),
        };
        const placeholders = cols.map(() => "?").join(", ");
        const values = cols.map((col) => newRow[col] as SQLInputValue);
        sumDb
          .prepare(
            `INSERT OR REPLACE INTO conversation_summaries (${cols.map((c) => `\`${c}\``).join(", ")}) VALUES (${placeholders})`,
          )
          .run(...values);
      }
    } finally {
      sumDb.close();
    }
  } catch {
    // If summaries registration fails, continue
  }

  return true;
}

export const copyNativeConversationDbIfExists = cloneNativeConversationDb;

export async function copyNativeBrainDirIfExists(
  sourceSessionId: string,
  derivedSessionId: string,
  homedir = os.homedir(),
): Promise<boolean> {
  const sourceBrain = nativeBrainDirPath(sourceSessionId, homedir);
  const targetBrain = nativeBrainDirPath(derivedSessionId, homedir);
  try {
    await cp(sourceBrain, targetBrain, {
      recursive: true,
      filter: (source) => path.basename(source) !== ".system_generated",
    });
    return true;
  } catch {
    return false;
  }
}

export interface ForkAntigravitySessionOptions {
  harnessId: HarnessId;
  input: ForkSessionInput;
  adapterEnvironment: NodeJS.ProcessEnv;
  sourceSession?:
    | {
        history: AntigravityHistory;
        model?: HarnessModelRef | undefined;
        thinkingOptionId?: HarnessThinkingOptionId | undefined;
        permissionMode: AntigravityPermissionMode;
        isActive: boolean;
      }
    | undefined;
  createSession: (params: {
    history: AntigravityHistory;
    nativeRef: NativeSessionRef;
    model?: HarnessModelRef | undefined;
    thinkingOptionId?: HarnessThinkingOptionId | undefined;
    permissionMode: AntigravityPermissionMode;
    cwd: string;
    environment: NodeJS.ProcessEnv;
  }) => HarnessSession;
}

export async function forkAntigravitySession(
  options: ForkAntigravitySessionOptions,
): Promise<HarnessResult<HarnessSession>> {
  const { harnessId, input, adapterEnvironment, sourceSession, createSession } = options;

  const sourceRefParsed = nativeSessionRefSchema.safeParse(input.sourceRef);
  if (!sourceRefParsed.success || sourceRefParsed.data.harnessId !== harnessId) {
    return {
      ok: false,
      error: {
        code: "invalidRequest",
        message: "Antigravity cannot fork another Harness Session",
        retryable: false,
      },
    };
  }
  const sourceRef = sourceRefParsed.data;

  const checkpointParsed = nativeCheckpointRefSchema.safeParse(input.checkpoint);
  if (
    !checkpointParsed.success ||
    checkpointParsed.data.harnessId !== harnessId ||
    checkpointParsed.data.nativeSessionId !== sourceRef.nativeSessionId
  ) {
    return {
      ok: false,
      error: {
        code: "checkpointNotFound",
        message: "Antigravity Checkpoint does not belong to the source Native Session",
        retryable: false,
      },
    };
  }
  const checkpoint = checkpointParsed.data;

  if (sourceSession?.isActive) {
    return {
      ok: false,
      error: {
        code: "sessionBusy",
        message: "Antigravity Session cannot fork while a Turn is active",
        retryable: true,
      },
    };
  }

  const sessionEnvironment = input.environment ?? adapterEnvironment;
  let sourceHistory: AntigravityHistory | null = sourceSession?.history ?? null;
  if (!sourceHistory) {
    sourceHistory = await AntigravityHistory.findByNativeSessionId(
      sessionEnvironment,
      sourceRef.nativeSessionId,
    );
  }
  if (!sourceHistory) {
    return {
      ok: false,
      error: {
        code: "sessionNotFound",
        message: "Antigravity source session history not found",
        retryable: false,
      },
    };
  }

  const sourceTurns = sourceHistory.snapshot();
  const boundaryIndex = sourceTurns.findIndex(
    (turn) =>
      turn.checkpoint?.checkpointId === checkpoint.checkpointId ||
      turn.nativeTurnRef.nativeTurnKey === checkpoint.checkpointId,
  );
  if (boundaryIndex === -1) {
    return {
      ok: false,
      error: {
        code: "checkpointNotFound",
        message: `Antigravity Checkpoint '${checkpoint.checkpointId}' not found in source Session history`,
        retryable: false,
      },
    };
  }

  const retainedTurns = sourceTurns.slice(0, boundaryIndex + 1);
  const derivedNativeSessionId = randomUUID();
  const copiedTurns: AntigravityTurn[] = retainedTurns.map((turn) => ({
    ...turn,
    nativeTurnRef: {
      ...turn.nativeTurnRef,
      nativeSessionId: derivedNativeSessionId,
    },
    ...(turn.checkpoint
      ? {
          checkpoint: {
            ...turn.checkpoint,
            nativeSessionId: derivedNativeSessionId,
          },
        }
      : {}),
  }));

  const model = sourceSession?.model ?? sourceHistory.model;
  const thinkingOptionId = sourceSession?.thinkingOptionId ?? sourceHistory.thinkingOptionId;
  const permissionMode = sourceSession?.permissionMode ?? "configured";

  const forkedHistory = await AntigravityHistory.createDerived({
    environment: sessionEnvironment,
    nativeSessionId: derivedNativeSessionId,
    turns: copiedTurns,
    ...(model ? { model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
  });

  await Promise.all([
    copyNativeConversationDbIfExists(
      sourceRef.nativeSessionId,
      derivedNativeSessionId,
      retainedTurns.length,
    ),
    copyNativeBrainDirIfExists(sourceRef.nativeSessionId, derivedNativeSessionId),
  ]);

  const derivedNativeRef: NativeSessionRef = {
    harnessId,
    nativeSessionId: derivedNativeSessionId,
    formatVersion: 1,
  };

  const session = createSession({
    history: forkedHistory,
    nativeRef: derivedNativeRef,
    ...(model ? { model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    permissionMode,
    cwd: input.cwd,
    environment: sessionEnvironment,
  });

  return { ok: true, value: session };
}
