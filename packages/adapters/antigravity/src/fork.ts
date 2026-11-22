import { randomUUID } from "node:crypto";
import { access, cp, mkdir, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  ForkSessionInput,
  HarnessResult,
  HarnessSession,
  ResumeSessionInput,
} from "@codexhost/harness-adapter";
import {
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  type HarnessId,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";
import { readProtoFields } from "./native-protobuf.js";
import { generatorStepIndices, nativeStepCreatedAtMs } from "./native-request-timing.js";
import {
  minimalRawSummaryBlob,
  minimalTrajectoryMetadataBlob,
  rewriteTrajectoryMetadataCascadeId,
} from "./native-trajectory-metadata.js";
import { decodeNativeHistory } from "./native-replay.js";
import { nativeConversationDbPath, nativeHistoryError } from "./native-turn-boundaries.js";
import { antigravityHome } from "./usage-statistics.js";

export {
  minimalRawSummaryBlob,
  minimalTrajectoryMetadataBlob,
} from "./native-trajectory-metadata.js";

export { nativeConversationDbPath } from "./native-turn-boundaries.js";
export function nativeConversationSummariesDbPath(home = os.homedir()): string {
  return path.join(home, ".gemini", "antigravity-cli", "conversation_summaries.db");
}
export function nativeBrainRoot(home = os.homedir()): string {
  return path.join(home, ".gemini", "antigravity-cli", "brain");
}
export function nativeBrainDirPath(id: string, home = os.homedir()): string {
  return path.join(nativeBrainRoot(home), id);
}

export function validNativeSessionRef(ref: NativeSessionRef, harnessId: HarnessId): boolean {
  return (
    nativeSessionRefSchema.safeParse(ref).success &&
    ref.harnessId === harnessId &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(ref.nativeSessionId)
  );
}

class ForkBoundaryError extends Error {}
class ActiveForkUnavailable extends Error {}

/** SQLite backup includes committed WAL pages; byte-copying the main file does not. */
export async function cloneNativeConversationDb(
  sourceId: string,
  derivedId: string,
  retainedTurnsCountOrHome?:
    number | string | { cutoff: number | undefined } | { checkpointId: string },
  homeOption = os.homedir(),
  fork?: { activeTurnIndex?: number },
): Promise<boolean> {
  if (![sourceId, derivedId].every((id) => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(id)))
    throw new Error("Invalid native conversation ID");
  const home = typeof retainedTurnsCountOrHome === "string" ? retainedTurnsCountOrHome : homeOption;
  const retained =
    typeof retainedTurnsCountOrHome === "number" ? retainedTurnsCountOrHome : undefined;
  const sourcePath = nativeConversationDbPath(sourceId, home);
  const targetPath = nativeConversationDbPath(derivedId, home);
  await access(sourcePath);
  const { DatabaseSync, backup } = await import("node:sqlite");
  let owned = false;
  let cutoff: number | undefined;
  const activeTurnIndex = fork?.activeTurnIndex;
  try {
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      source.exec("BEGIN");
      // WAL readers do not hold up commits by the active agy process.
      if (
        activeTurnIndex !== undefined &&
        source.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal"
      )
        throw new ActiveForkUnavailable(
          "Running Antigravity Session has no WAL snapshot; retry when idle",
        );
      const count = Number(
        source.prepare("SELECT count(*) AS n FROM steps WHERE step_type = 14").get()?.n ?? 0,
      );
      if (activeTurnIndex !== undefined && count <= activeTurnIndex)
        throw new ActiveForkUnavailable(
          "The running Antigravity Turn has no committed user input yet; retry shortly",
        );
      if (
        retained !== undefined &&
        (!Number.isSafeInteger(retained) || retained < 0 || retained > count)
      ) {
        if (fork) throw new ForkBoundaryError();
        throw new Error("Invalid retained native Turn count");
      }
      if (typeof retainedTurnsCountOrHome === "object") {
        if ("checkpointId" in retainedTurnsCountOrHome) {
          const boundaries = derivationBoundaries(source);
          const index = boundaries.findIndex(
            ({ checkpointId }) => checkpointId === retainedTurnsCountOrHome.checkpointId,
          );
          if (index < 0) throw new ForkBoundaryError();
          cutoff = boundaries[index + 1]?.idx;
        } else cutoff = retainedTurnsCountOrHome.cutoff;
      } else if (retained !== undefined && retained < count) {
        const boundary = source
          .prepare("SELECT idx FROM steps WHERE step_type = 14 ORDER BY idx LIMIT 1 OFFSET ?")
          .get(retained);
        cutoff = retained === 0 ? 0 : Number(boundary?.idx);
      }
      await mkdir(path.dirname(targetPath), { recursive: true });
      const reservation = await open(targetPath, "wx");
      owned = true;
      await reservation.close();
      await backup(source, targetPath);
    } finally {
      source.close();
    }
    const target = new DatabaseSync(targetPath);
    try {
      target.exec("BEGIN IMMEDIATE");
      target.prepare("UPDATE trajectory_meta SET cascade_id = ?").run(derivedId);
      const row = target
        .prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'")
        .get();
      const blob =
        row?.data instanceof Uint8Array
          ? rewriteTrajectoryMetadataCascadeId(row.data, derivedId)
          : minimalTrajectoryMetadataBlob(derivedId);
      if (!blob) throw new Error("Invalid native trajectory metadata");
      target
        .prepare("INSERT OR REPLACE INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)")
        .run(blob);
      if (cutoff !== undefined) {
        const cutoffIndex = cutoff;
        target.prepare("DELETE FROM steps WHERE idx >= ?").run(cutoffIndex);
        // agy stores these as separate repeated fields, with ordinal keys rather than step keys.
        // The Branch implementation uses the protobuf's own step indices to bound each list.
        for (const [table, stepFields] of Object.entries<number[]>({
          gen_metadata: [], // CortexStepGeneratorMetadata.step_indices (repeated uint32)
          executor_metadata: [3], // ExecutorMetadata.last_step_idx
          parent_references: [2], // CortexTrajectoryReference.step_index in the inherited prefix
          battle_mode_infos: [3, 4], // BattleModeInfo.start_step_index / end_step_index
        })) {
          if (
            !target
              .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
              .get(table)
          )
            continue;
          if (cutoffIndex === 0) {
            target.exec(`DELETE FROM ${table}`);
            continue;
          }
          const rows = target.prepare(`SELECT idx, data FROM ${table} ORDER BY idx`);
          if (table === "gen_metadata") {
            let last = -1;
            for (const { idx, data } of rows.iterate()) {
              const fields = data instanceof Uint8Array && readProtoFields(data);
              const indices = fields && generatorStepIndices(fields);
              if (!indices) throw new Error("Invalid native generator metadata");
              if (indices.some((step) => step >= cutoffIndex)) break;
              // Invocations without steps belong to the prefix only before a retained invocation.
              if (indices.length > 0) last = Number(idx);
            }
            target.prepare("DELETE FROM gen_metadata WHERE idx > ?").run(last);
            continue;
          }
          const remove = target.prepare(`DELETE FROM ${table} WHERE idx = ?`);
          const move = target.prepare(`UPDATE ${table} SET idx = ? WHERE idx = ?`);
          let next = 0;
          for (const { idx, data } of rows.all()) {
            const fields = data instanceof Uint8Array && readProtoFields(data);
            if (!fields) throw new Error(`Invalid native ${table}`);
            const outsidePrefix = fields.some(
              (field) =>
                stepFields.includes(field.number) &&
                typeof field.value === "bigint" &&
                BigInt.asIntN(32, field.value) >= BigInt(cutoffIndex),
            );
            if (outsidePrefix) remove.run(Number(idx));
            else {
              if (idx !== next) move.run(next, Number(idx));
              next++;
            }
          }
        }
      }
      target.exec("COMMIT");
    } finally {
      target.close();
    }
    await registerDerivedSummary(sourceId, derivedId, home, activeTurnIndex !== undefined);
    return true;
  } catch (error) {
    if (owned) await removeDerivedDb(derivedId, home);
    throw error;
  }
}

async function registerDerivedSummary(
  sourceId: string,
  derivedId: string,
  home: string,
  liveFork: boolean,
): Promise<void> {
  const summaryPath = nativeConversationSummariesDbPath(home);
  try {
    await access(summaryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const { DatabaseSync } = await import("node:sqlite");
  const summaries = new DatabaseSync(summaryPath);
  try {
    const template = summaries
      .prepare("SELECT * FROM conversation_summaries WHERE conversation_id = ?")
      .get(sourceId);
    if (!template) return;
    if (
      liveFork &&
      "parent_conversation_id" in template &&
      summaries
        .prepare(
          `SELECT 1 FROM conversation_summaries
        WHERE parent_conversation_id = ? AND status IS NOT 'CASCADE_RUN_STATUS_IDLE' LIMIT 1`,
        )
        .get(sourceId)
    )
      throw new ActiveForkUnavailable("A native Subagent is not idle; retry after it settles");
    const derived = new DatabaseSync(nativeConversationDbPath(derivedId, home), { readOnly: true });
    let row;
    try {
      const metadata = derived
        .prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'")
        .get()?.data;
      const trajectoryId = derived
        .prepare("SELECT trajectory_id FROM trajectory_meta LIMIT 1")
        .get()?.trajectory_id;
      const lastInput = derived
        .prepare(
          `SELECT idx${"last_user_input_time" in template ? ", metadata" : ""}
                  FROM steps WHERE step_type = 14 ORDER BY idx DESC LIMIT 1`,
        )
        .get();
      const lastInputMs = nativeStepCreatedAtMs(lastInput?.metadata);
      row = {
        ...template,
        conversation_id: derivedId,
        status: "CASCADE_RUN_STATUS_IDLE",
        step_count: Number(derived.prepare("SELECT count(*) AS n FROM steps").get()?.n),
        last_user_input_step_index: lastInput?.idx ?? -1,
        last_user_input_time:
          lastInputMs === undefined ? "0001-01-01T00:00:00Z" : new Date(lastInputMs).toISOString(),
        not_fully_idle: 0,
        killed: 0,
        last_modified_time: new Date().toISOString(),
        raw_summary: minimalRawSummaryBlob(
          String(trajectoryId),
          Buffer.from(metadata as Uint8Array),
        ),
      };
    } finally {
      derived.close();
    }
    const columns = Object.keys(template);
    summaries
      .prepare(
        `INSERT INTO conversation_summaries (${columns.map((name) => `\"${name.replaceAll('"', '""')}\"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      )
      .run(...columns.map((name) => (row as Record<string, SQLInputValue>)[name] ?? null));
  } finally {
    summaries.close();
  }
}

async function removeDerivedSummary(id: string, home: string): Promise<void> {
  try {
    await access(nativeConversationSummariesDbPath(home));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(nativeConversationSummariesDbPath(home));
  try {
    db.prepare("DELETE FROM conversation_summaries WHERE conversation_id = ?").run(id);
  } finally {
    db.close();
  }
}

async function removeDerivedDb(id: string, home: string): Promise<void> {
  const file = nativeConversationDbPath(id, home);
  await Promise.all(
    [file, `${file}-wal`, `${file}-shm`].map((target) => rm(target, { force: true })),
  );
}

export const copyNativeConversationDbIfExists = cloneNativeConversationDb;

export async function copyNativeBrainDirIfExists(
  sourceId: string,
  derivedId: string,
  home = os.homedir(),
): Promise<boolean> {
  try {
    await access(nativeBrainDirPath(sourceId, home));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await cp(nativeBrainDirPath(sourceId, home), nativeBrainDirPath(derivedId, home), {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (source) => path.basename(source) !== ".system_generated",
  });
  return true;
}

export interface NativeDerivationOptions {
  harnessId: HarnessId;
  adapterEnvironment: NodeJS.ProcessEnv;
  sourceSession?: { isActive: boolean } | undefined;
  openSession(input: ResumeSessionInput): Promise<HarnessResult<HarnessSession>>;
}
export interface ForkAntigravitySessionOptions extends NativeDerivationOptions {
  input: ForkSessionInput;
  sourceSession?: NativeDerivationOptions["sourceSession"] & {
    activeForkTurnIndex?(checkpointId: string, home: string): number | undefined;
  };
}

/** Only this invocation's freshly generated derived identity is disposable. */
export async function openDerivedAntigravitySession(
  options: NativeDerivationOptions,
  input: ResumeSessionInput,
  sourceRef: NativeSessionRef,
  retained: { cutoff: number | undefined } | { checkpointId: string },
  fork?: { activeTurnIndex?: number },
): Promise<HarnessResult<HarnessSession>> {
  const environment = { ...options.adapterEnvironment, ...input.environment };
  const home = antigravityHome(environment);
  const derivedId = randomUUID();
  let cloned = false;
  try {
    await cloneNativeConversationDb(sourceRef.nativeSessionId, derivedId, retained, home, fork);
    cloned = true;
    // Brain files have neither a snapshot nor a Turn boundary. Resume can load the SQLite prefix alone.
    if (fork?.activeTurnIndex === undefined)
      await copyNativeBrainDirIfExists(sourceRef.nativeSessionId, derivedId, home);
    const result = await options.openSession({
      ...input,
      environment,
      nativeRef: { ...sourceRef, nativeSessionId: derivedId },
    });
    if (result.ok) return result;
    const cleanupFailure = await cleanup().then(
      () => undefined,
      () => "Derived native history cleanup failed",
    );
    return cleanupFailure
      ? { ok: false, error: { ...result.error, diagnostic: cleanupFailure } }
      : result;
  } catch (error) {
    if (error instanceof ForkBoundaryError) return checkpointError();
    if (error instanceof ActiveForkUnavailable) return activeForkError(error.message);
    const cleanupFailure = await cleanup().then(
      () => undefined,
      () => "Derived native history cleanup failed",
    );
    return {
      ok: false,
      error: {
        ...nativeHistoryError(error),
        ...(cleanupFailure ? { diagnostic: cleanupFailure } : {}),
      },
    };
  }
  async function cleanup() {
    if (!cloned) return;
    await Promise.all([
      removeDerivedDb(derivedId, home),
      rm(nativeBrainDirPath(derivedId, home), { recursive: true, force: true }),
      removeDerivedSummary(derivedId, home),
    ]);
  }
}

export async function forkAntigravitySession(
  options: ForkAntigravitySessionOptions,
): Promise<HarnessResult<HarnessSession>> {
  const { input, harnessId } = options;
  if (!validNativeSessionRef(input.sourceRef, harnessId))
    return {
      ok: false,
      error: {
        code: "invalidRequest",
        message: "Invalid Antigravity source Native Session",
        retryable: false,
      },
    };
  const checkpoint = nativeCheckpointRefSchema.safeParse(input.checkpoint);
  if (
    !checkpoint.success ||
    checkpoint.data.harnessId !== harnessId ||
    checkpoint.data.nativeSessionId !== input.sourceRef.nativeSessionId
  )
    return checkpointError();
  const checkpointId = checkpoint.data.checkpointId;
  const match = /^(turn|wake)-(0|[1-9]\d*)$/u.exec(checkpointId);
  if (!match) return checkpointError();
  const index = Number(match[2]);
  if (!Number.isSafeInteger(index + 1)) return checkpointError();
  let activeTurnIndex: number | undefined;
  if (options.sourceSession?.isActive) {
    activeTurnIndex = options.sourceSession.activeForkTurnIndex?.(
      checkpointId,
      antigravityHome({ ...options.adapterEnvironment, ...input.environment }),
    );
    if (match[1] !== "turn" || activeTurnIndex === undefined || index >= activeTurnIndex)
      return activeForkError(
        "Fork requires a confirmed completed Turn before the running Antigravity Turn and no active Subagents; retry when idle",
      );
  }
  return openDerivedAntigravitySession(
    options,
    {
      kind: "resume",
      nativeRef: input.sourceRef,
      cwd: input.cwd,
      ...(input.environment ? { environment: input.environment } : {}),
    },
    input.sourceRef,
    { checkpointId },
    activeTurnIndex === undefined ? {} : { activeTurnIndex },
  );
}
function activeForkError(message: string): HarnessResult<never> {
  return { ok: false, error: { code: "sessionBusy", message, retryable: true } };
}
export async function readDerivationBoundaries(dbPath: string) {
  await access(dbPath);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("BEGIN");
    return derivationBoundaries(db);
  } finally {
    db.close();
  }
}

function derivationBoundaries(db: DatabaseSync): { idx: number; checkpointId: string }[] {
  const users = db.prepare("SELECT idx FROM steps WHERE step_type = 14 ORDER BY idx").all();
  const boundaries = users.map((row, index) => ({
    idx: Number(row.idx),
    checkpointId: `turn-${index}`,
  }));
  if (db.prepare("SELECT 1 FROM steps WHERE step_type = 101 LIMIT 1").get()) {
    for (const event of decodeNativeHistory(db).events) {
      if (event.type === "history.autonomous")
        boundaries.push({ idx: event.stepIndex, checkpointId: `wake-${event.stepIndex}` });
    }
    boundaries.sort((a, b) => a.idx - b.idx);
  }
  return boundaries;
}

function checkpointError(): HarnessResult<never> {
  return {
    ok: false,
    error: {
      code: "checkpointNotFound",
      message: "Antigravity native Turn checkpoint not found",
      retryable: false,
    },
  };
}
