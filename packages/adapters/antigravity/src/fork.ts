import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, cp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from "node:sqlite";

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
import { nativeTurnBoundaryError } from "./native-turn-boundaries.js";
import {
  minimalRawSummaryBlob,
  minimalTrajectoryMetadataBlob,
  rewriteTrajectoryMetadataCascadeId,
} from "./native-trajectory-metadata.js";
import type { AntigravityPermissionMode } from "./permission-modes.js";
import { antigravityHome } from "./usage-statistics.js";

export {
  minimalRawSummaryBlob,
  minimalTrajectoryMetadataBlob,
} from "./native-trajectory-metadata.js";

const DEFAULT_CLI_PROJECT_ID = "default-cli-project";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function nativeConversationDbPath(nativeSessionId: string, homedir = os.homedir()): string {
  return path.join(homedir, ".gemini", "antigravity-cli", "conversations", `${nativeSessionId}.db`);
}

export function nativeConversationSummariesDbPath(homedir = os.homedir()): string {
  return path.join(homedir, ".gemini", "antigravity-cli", "conversation_summaries.db");
}

/** agy's per-Conversation directories, one per native Conversation ID. */
export function nativeBrainRoot(homedir = os.homedir()): string {
  return path.join(homedir, ".gemini", "antigravity-cli", "brain");
}

export function nativeBrainDirPath(nativeSessionId: string, homedir = os.homedir()): string {
  return path.join(nativeBrainRoot(homedir), nativeSessionId);
}

/** Only a missing path is absent; other access errors (permissions, I/O) are rethrown. */
async function pathExists(targetPath: string): Promise<boolean> {
  return access(targetPath).then(
    () => true,
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return false;
      throw error;
    },
  );
}

function readConversationSummaryRow(
  DatabaseSync: typeof DatabaseSyncType,
  summariesDbPath: string,
  conversationId: string,
): Record<string, unknown> | undefined {
  try {
    const sumDb = new DatabaseSync(summariesDbPath);
    try {
      const stmt = sumDb.prepare("SELECT * FROM conversation_summaries WHERE conversation_id = ?");
      return stmt.get(conversationId) as Record<string, unknown> | undefined;
    } finally {
      sumDb.close();
    }
  } catch {
    return undefined;
  }
}

function upsertConversationSummaryRow(
  DatabaseSync: typeof DatabaseSyncType,
  summariesDbPath: string,
  conversationId: string,
  trajectoryId: string,
  metadataBlob: Buffer,
  stepCount: number,
  templateRow?: Record<string, unknown>,
): void {
  try {
    const sumDb = new DatabaseSync(summariesDbPath);
    try {
      sumDb.exec(`
        CREATE TABLE IF NOT EXISTS \`conversation_summaries\` (
          \`conversation_id\` text,
          \`title\` text NOT NULL DEFAULT "",
          \`preview\` text NOT NULL DEFAULT "",
          \`step_count\` integer NOT NULL DEFAULT 0,
          \`last_modified_time\` datetime NOT NULL,
          \`workspace_uris\` text NOT NULL,
          \`status\` text NOT NULL DEFAULT "",
          \`source\` text NOT NULL DEFAULT "",
          \`project_id\` text NOT NULL DEFAULT "",
          \`agent_name\` text NOT NULL DEFAULT "",
          \`parent_conversation_id\` text NOT NULL DEFAULT "",
          \`nesting_depth\` integer NOT NULL DEFAULT 0,
          \`battle_id\` text NOT NULL DEFAULT "",
          \`winning_conversation_id\` text NOT NULL DEFAULT "",
          \`not_fully_idle\` numeric NOT NULL DEFAULT false,
          \`killed\` numeric NOT NULL DEFAULT false,
          \`last_user_input_time\` datetime NOT NULL,
          \`last_user_input_step_index\` integer NOT NULL DEFAULT -1,
          \`app_data_dir\` text NOT NULL DEFAULT "",
          \`raw_summary\` blob,
          \`group_id\` TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (\`conversation_id\`)
        );
      `);
      const now = new Date().toISOString();
      const rawSummary = minimalRawSummaryBlob(trajectoryId, metadataBlob);
      if (templateRow) {
        const cols = Object.keys(templateRow);
        const newRow: Record<string, unknown> = {
          ...templateRow,
          conversation_id: conversationId,
          step_count: stepCount,
          last_modified_time: now,
          ...(stepCount === 0 ? { last_user_input_step_index: -1 } : {}),
          raw_summary: rawSummary,
        };
        const placeholders = cols.map(() => "?").join(", ");
        const values = cols.map((col) => newRow[col] as SQLInputValue);
        sumDb
          .prepare(
            `INSERT OR REPLACE INTO conversation_summaries (${cols.map((c) => `\`${c}\``).join(", ")}) VALUES (${placeholders})`,
          )
          .run(...values);
      } else {
        sumDb
          .prepare(
            `INSERT OR REPLACE INTO conversation_summaries (
              \`conversation_id\`, \`title\`, \`preview\`, \`step_count\`, \`last_modified_time\`,
              \`workspace_uris\`, \`status\`, \`source\`, \`project_id\`, \`agent_name\`,
              \`parent_conversation_id\`, \`nesting_depth\`, \`battle_id\`, \`winning_conversation_id\`,
              \`not_fully_idle\`, \`killed\`, \`last_user_input_time\`, \`last_user_input_step_index\`,
              \`app_data_dir\`, \`raw_summary\`, \`group_id\`
            ) VALUES (?, '', '', ?, ?, '[]', 'CASCADE_RUN_STATUS_IDLE', '', ?, '', '', 0, '', '', 0, 0, ?, -1, '', ?, '')`,
          )
          .run(conversationId, stepCount, now, DEFAULT_CLI_PROJECT_ID, now, rawSummary);
      }
    } finally {
      sumDb.close();
    }
  } catch {
    // Ignore summaries registration errors when summaries DB is unavailable
  }
}

export async function seedNativeConversationDb(
  nativeSessionId: string,
  homedir = os.homedir(),
  templateSummaryRow?: Record<string, unknown>,
): Promise<boolean> {
  let DatabaseSync: typeof DatabaseSyncType;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return false;
  }

  const targetDb = nativeConversationDbPath(nativeSessionId, homedir);
  const summariesDbPath = nativeConversationSummariesDbPath(homedir);
  const trajectoryId = randomUUID();
  const metadataBlob = minimalTrajectoryMetadataBlob(nativeSessionId);

  try {
    await mkdir(path.dirname(targetDb), { recursive: true });
    const db = new DatabaseSync(targetDb);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS \`trajectory_meta\` (
          \`trajectory_id\` text,
          \`cascade_id\` text,
          \`trajectory_type\` integer,
          \`source\` integer,
          PRIMARY KEY (\`trajectory_id\`)
        );
        CREATE TABLE IF NOT EXISTS \`steps\` (
          \`idx\` integer,
          \`step_type\` integer NOT NULL DEFAULT 0,
          \`status\` integer NOT NULL DEFAULT 0,
          \`has_subtrajectory\` numeric NOT NULL DEFAULT false,
          \`metadata\` blob,
          \`error_details\` blob,
          \`permissions\` blob,
          \`task_details\` blob,
          \`render_info\` blob,
          \`step_payload\` blob,
          \`step_format\` integer NOT NULL DEFAULT 0,
          PRIMARY KEY (\`idx\`)
        );
        CREATE INDEX IF NOT EXISTS \`idx_steps_status\` ON \`steps\`(\`status\`);
        CREATE INDEX IF NOT EXISTS \`idx_steps_step_type\` ON \`steps\`(\`step_type\`);
        CREATE TABLE IF NOT EXISTS \`gen_metadata\` (
          \`idx\` integer,
          \`data\` blob,
          \`size\` integer NOT NULL DEFAULT 0,
          PRIMARY KEY (\`idx\`)
        );
        CREATE TABLE IF NOT EXISTS \`executor_metadata\` (
          \`idx\` integer,
          \`data\` blob,
          PRIMARY KEY (\`idx\`)
        );
        CREATE TABLE IF NOT EXISTS \`parent_references\` (
          \`idx\` integer,
          \`data\` blob,
          PRIMARY KEY (\`idx\`)
        );
        CREATE TABLE IF NOT EXISTS \`trajectory_metadata_blob\` (
          \`id\` text DEFAULT "main",
          \`data\` blob,
          PRIMARY KEY (\`id\`)
        );
        CREATE TABLE IF NOT EXISTS \`battle_mode_infos\` (
          \`idx\` integer,
          \`data\` blob,
          PRIMARY KEY (\`idx\`)
        );
      `);
      db.prepare("DELETE FROM trajectory_meta").run();
      db.prepare(
        "INSERT INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?, ?, 4, 17)",
      ).run(trajectoryId, nativeSessionId);
      db.prepare(
        "INSERT OR REPLACE INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)",
      ).run(metadataBlob);
    } finally {
      db.close();
    }
  } catch {
    return false;
  }

  // The trajectory database is already written; a summary that cannot be read or written must
  // not turn the seed into a failure.
  try {
    const existingSummary =
      templateSummaryRow ??
      ((await pathExists(summariesDbPath))
        ? readConversationSummaryRow(DatabaseSync, summariesDbPath, nativeSessionId)
        : undefined);
    upsertConversationSummaryRow(
      DatabaseSync,
      summariesDbPath,
      nativeSessionId,
      trajectoryId,
      metadataBlob,
      0,
      existingSummary,
    );
  } catch {}
  return true;
}

/**
 * Ensures the native SQLite conversation database exists before spawning `agy --conversation <id>`.
 * When a tracked Conversation's `.db` file was deleted externally (or lost during an earlier
 * fork/rollback), seeding an empty trajectory DB and summary entry lets `agy` resume `<id>` instead
 * of silently starting a brand-new Conversation ID.
 */
export async function ensureNativeConversationDb(
  nativeSessionId: string,
  homedir = os.homedir(),
  hasPriorHistory = false,
): Promise<{ seeded: boolean; emptySteps: boolean }> {
  const dbPath = nativeConversationDbPath(nativeSessionId, homedir);
  let exists: boolean;
  try {
    exists = await pathExists(dbPath);
  } catch {
    // An unreadable database is not a missing one: never seed over it.
    return { seeded: false, emptySteps: false };
  }
  if (exists) {
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath);
      let trajectoryId: string = randomUUID();
      let metadataBlob: Buffer | null = null;
      let stepCount = 0;
      let validTrajectory = false;
      try {
        const metaRow = db
          .prepare("SELECT trajectory_id, cascade_id FROM trajectory_meta LIMIT 1")
          .get() as { trajectory_id?: string; cascade_id?: string } | undefined;
        if (metaRow?.trajectory_id) {
          validTrajectory = true;
          trajectoryId = metaRow.trajectory_id;
          if (metaRow.cascade_id !== nativeSessionId) {
            db.prepare("UPDATE trajectory_meta SET cascade_id = ?").run(nativeSessionId);
          }
        }
        try {
          const blobRow = db
            .prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'")
            .get() as { data?: Uint8Array } | undefined;
          const current = blobRow?.data?.length ? Buffer.from(blobRow.data) : null;
          // Keep a native blob this parser cannot read instead of replacing it with a minimal one.
          const updated = current
            ? rewriteTrajectoryMetadataCascadeId(current, nativeSessionId)
            : minimalTrajectoryMetadataBlob(nativeSessionId);
          metadataBlob = updated ?? current;
          if (updated && !current?.equals(updated)) {
            db.prepare(
              "INSERT OR REPLACE INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)",
            ).run(updated);
          }
        } catch {}
        const countRow = db.prepare("SELECT count(*) as c FROM steps").get() as
          { c: number } | undefined;
        stepCount = countRow?.c ?? 0;
      } finally {
        db.close();
      }
      if (validTrajectory) {
        // Register the summary even when the whole summaries database is missing, matching the
        // seed path: without a usable raw_summary `agy --conversation <id>` may start afresh.
        try {
          const summariesDbPath = nativeConversationSummariesDbPath(homedir);
          const existingRow = (await pathExists(summariesDbPath))
            ? readConversationSummaryRow(DatabaseSync, summariesDbPath, nativeSessionId)
            : undefined;
          if (!existingRow || !existingRow.raw_summary) {
            upsertConversationSummaryRow(
              DatabaseSync,
              summariesDbPath,
              nativeSessionId,
              trajectoryId,
              metadataBlob ?? minimalTrajectoryMetadataBlob(nativeSessionId),
              stepCount,
              existingRow,
            );
          }
        } catch {}
        return { seeded: false, emptySteps: stepCount === 0 };
      }
    } catch {
      return { seeded: false, emptySteps: false };
    }
    return { seeded: false, emptySteps: false };
  }

  if (!UUID_PATTERN.test(nativeSessionId)) {
    return { seeded: false, emptySteps: false };
  }
  let DatabaseSync: typeof DatabaseSyncType;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return { seeded: false, emptySteps: false };
  }
  const summariesDbPath = nativeConversationSummariesDbPath(homedir);
  let existingSummary: ReturnType<typeof readConversationSummaryRow>;
  let hasBrainDir: boolean;
  try {
    existingSummary = (await pathExists(summariesDbPath))
      ? readConversationSummaryRow(DatabaseSync, summariesDbPath, nativeSessionId)
      : undefined;
    hasBrainDir = await pathExists(nativeBrainDirPath(nativeSessionId, homedir));
  } catch {
    // Unreadable evidence is no evidence: do not seed, and do not fail the Turn.
    return { seeded: false, emptySteps: false };
  }
  if (!hasPriorHistory && !existingSummary && !hasBrainDir) {
    return { seeded: false, emptySteps: false };
  }
  const seeded = await seedNativeConversationDb(nativeSessionId, homedir, existingSummary);
  return { seeded, emptySteps: seeded };
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
  const summariesDbPath = nativeConversationSummariesDbPath(homedir);

  const { DatabaseSync } = await import("node:sqlite");
  if (!(await pathExists(sourceDb))) {
    const sourceSummary = (await pathExists(summariesDbPath))
      ? readConversationSummaryRow(DatabaseSync, summariesDbPath, sourceSessionId)
      : undefined;
    const sourceBrainExists = await pathExists(nativeBrainDirPath(sourceSessionId, homedir));
    if (!UUID_PATTERN.test(sourceSessionId) && !sourceSummary && !sourceBrainExists) {
      return false;
    }
    if (await pathExists(targetDb)) {
      throw new Error("Antigravity derived native conversation database already exists");
    }
    if (!(await seedNativeConversationDb(derivedSessionId, homedir, sourceSummary))) {
      await rm(targetDb, { force: true });
      throw new Error("Antigravity could not seed the derived native conversation database");
    }
    return true;
  }

  await mkdir(path.dirname(targetDb), { recursive: true });
  await copyFile(sourceDb, targetDb, constants.COPYFILE_EXCL);

  let trajectoryId: string = randomUUID();
  let metadataBlob = minimalTrajectoryMetadataBlob(derivedSessionId);
  let remainingStepCount = 0;
  try {
    const db = new DatabaseSync(targetDb);
    try {
      db.prepare("UPDATE trajectory_meta SET cascade_id = ?").run(derivedSessionId);
      const metaRow = db.prepare("SELECT trajectory_id FROM trajectory_meta LIMIT 1").get() as
        { trajectory_id?: string } | undefined;
      if (metaRow?.trajectory_id) trajectoryId = metaRow.trajectory_id;
      const blobRow = db
        .prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'")
        .get() as { data?: Uint8Array } | undefined;
      const rewritten = blobRow?.data?.length
        ? rewriteTrajectoryMetadataCascadeId(blobRow.data, derivedSessionId)
        : minimalTrajectoryMetadataBlob(derivedSessionId);
      if (!rewritten) throw new Error("Antigravity could not parse source trajectory metadata");
      metadataBlob = rewritten;
      db.prepare(
        "INSERT OR REPLACE INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)",
      ).run(metadataBlob);
      if (retainedTurnsCount !== undefined) {
        if (retainedTurnsCount === 0) {
          db.prepare("DELETE FROM steps").run();
        } else {
          // In agy, each turn begins with a user_input step (step_type = 14)
          const rows = db
            .prepare("SELECT idx FROM steps WHERE step_type = 14 ORDER BY idx ASC")
            .all() as Array<{ idx: number }>;
          const cutoff = rows[retainedTurnsCount];
          if (cutoff) db.prepare("DELETE FROM steps WHERE idx >= ?").run(cutoff.idx);
        }
        for (const table of [
          "gen_metadata",
          "executor_metadata",
          "parent_references",
          "battle_mode_infos",
        ]) {
          // Older native schemas may omit auxiliary tables, but write errors must still fail.
          if (
            db
              .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
              .get(table)
          ) {
            db.prepare(`DELETE FROM ${table} WHERE idx >= ?`).run(retainedTurnsCount);
          }
        }
      }
      const countRow = db.prepare("SELECT count(*) as c FROM steps").get() as
        { c: number } | undefined;
      if (countRow) remainingStepCount = countRow.c;
    } finally {
      db.close();
    }

    // Register in conversation_summaries.db so `agy` trajectory lookup succeeds
    if (await pathExists(summariesDbPath)) {
      const sourceRow = readConversationSummaryRow(DatabaseSync, summariesDbPath, sourceSessionId);
      const effectiveStepCount =
        retainedTurnsCount !== undefined
          ? remainingStepCount
          : typeof sourceRow?.step_count === "number"
            ? sourceRow.step_count
            : remainingStepCount;
      upsertConversationSummaryRow(
        DatabaseSync,
        summariesDbPath,
        derivedSessionId,
        trajectoryId,
        metadataBlob,
        effectiveStepCount,
        sourceRow,
      );
    }
  } catch (error) {
    // Only this invocation's exclusive copy is disposable; never remove the source or other rows.
    await rm(targetDb, { force: true });
    throw error;
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

  const sessionEnvironment = { ...adapterEnvironment, ...(input.environment ?? {}) };
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

  const homedir = antigravityHome(sessionEnvironment);
  const boundaryError = await nativeTurnBoundaryError(
    nativeConversationDbPath(sourceRef.nativeSessionId, homedir),
    sourceTurns.length,
  );
  if (boundaryError) return { ok: false, error: boundaryError };

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
  const permissionMode = sourceSession?.permissionMode ?? "dangerously-skip-permissions";

  try {
    // A genuinely missing store may recover from sidecar history; preparation errors must fail.
    await copyNativeConversationDbIfExists(
      sourceRef.nativeSessionId,
      derivedNativeSessionId,
      retainedTurns.length,
      homedir,
    );
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "nativeFailure",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      },
    };
  }
  await copyNativeBrainDirIfExists(sourceRef.nativeSessionId, derivedNativeSessionId, homedir);

  const forkedHistory = await AntigravityHistory.createDerived({
    environment: sessionEnvironment,
    nativeSessionId: derivedNativeSessionId,
    turns: copiedTurns,
    ...(model ? { model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
  });

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
