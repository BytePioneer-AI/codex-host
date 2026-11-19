import { randomUUID } from "node:crypto";
import { access, cp, mkdir, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
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
import {
  minimalRawSummaryBlob,
  minimalTrajectoryMetadataBlob,
  rewriteTrajectoryMetadataCascadeId,
} from "./native-trajectory-metadata.js";
import { nativeHistoryError, readNativeTurnCount } from "./native-turn-boundaries.js";
import { antigravityHome } from "./usage-statistics.js";

export {
  minimalRawSummaryBlob,
  minimalTrajectoryMetadataBlob,
} from "./native-trajectory-metadata.js";

export function nativeConversationDbPath(id: string, home = os.homedir()): string {
  return path.join(home, ".gemini", "antigravity-cli", "conversations", `${id}.db`);
}
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

/** SQLite backup includes committed WAL pages; byte-copying the main file does not. */
export async function cloneNativeConversationDb(
  sourceId: string,
  derivedId: string,
  retainedTurnsCountOrHome?: number | string,
  homeOption = os.homedir(),
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
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let owned = false;
  try {
    source.exec("BEGIN");
    const count = Number(
      source.prepare("SELECT count(*) AS n FROM steps WHERE step_type = 14").get()?.n ?? 0,
    );
    if (
      retained !== undefined &&
      (!Number.isSafeInteger(retained) || retained < 0 || retained > count)
    )
      throw new Error("Invalid retained native Turn count");
    await mkdir(path.dirname(targetPath), { recursive: true });
    const reservation = await open(targetPath, "wx");
    owned = true;
    await reservation.close();
    await backup(source, targetPath);
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
      if (retained !== undefined && retained < count) {
        const boundary = target
          .prepare("SELECT idx FROM steps WHERE step_type = 14 ORDER BY idx LIMIT 1 OFFSET ?")
          .get(retained);
        const cutoff = retained === 0 ? 0 : Number(boundary?.idx);
        target.prepare("DELETE FROM steps WHERE idx >= ?").run(cutoff);
        for (const table of [
          "gen_metadata",
          "executor_metadata",
          "parent_references",
          "battle_mode_infos",
        ]) {
          if (
            target
              .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
              .get(table)
          )
            target.prepare(`DELETE FROM ${table} WHERE idx >= ?`).run(cutoff);
        }
      }
      target.exec("COMMIT");
    } finally {
      target.close();
    }
    await registerDerivedSummary(sourceId, derivedId, home);
    return true;
  } catch (error) {
    if (owned) await removeDerivedDb(derivedId, home);
    throw error;
  } finally {
    source.close();
  }
}

async function registerDerivedSummary(
  sourceId: string,
  derivedId: string,
  home: string,
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
    const derived = new DatabaseSync(nativeConversationDbPath(derivedId, home), { readOnly: true });
    let row;
    try {
      const metadata = derived
        .prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'")
        .get()?.data;
      const trajectoryId = derived
        .prepare("SELECT trajectory_id FROM trajectory_meta LIMIT 1")
        .get()?.trajectory_id;
      row = {
        ...template,
        conversation_id: derivedId,
        status: "CASCADE_RUN_STATUS_IDLE",
        step_count: Number(derived.prepare("SELECT count(*) AS n FROM steps").get()?.n),
        last_user_input_step_index: Number(
          derived.prepare("SELECT max(idx) AS idx FROM steps WHERE step_type = 14").get()?.idx ??
            -1,
        ),
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
}

/** Only this invocation's freshly generated derived identity is disposable. */
export async function openDerivedAntigravitySession(
  options: NativeDerivationOptions,
  input: ResumeSessionInput,
  sourceRef: NativeSessionRef,
  retained: number,
): Promise<HarnessResult<HarnessSession>> {
  const environment = { ...options.adapterEnvironment, ...input.environment };
  const home = antigravityHome(environment);
  const derivedId = randomUUID();
  let cloned = false;
  try {
    await cloneNativeConversationDb(sourceRef.nativeSessionId, derivedId, retained, home);
    cloned = true;
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
  if (options.sourceSession?.isActive)
    return {
      ok: false,
      error: {
        code: "sessionBusy",
        message: "Source Session is busy",
        retryable: true,
      },
    };
  const match = /^turn-(0|[1-9]\d*)$/u.exec(checkpoint.data.checkpointId);
  if (!match) return checkpointError();
  try {
    const count = await readNativeTurnCount(
      nativeConversationDbPath(
        input.sourceRef.nativeSessionId,
        antigravityHome({ ...options.adapterEnvironment, ...input.environment }),
      ),
    );
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index) || index >= count) return checkpointError();
    return openDerivedAntigravitySession(
      options,
      {
        kind: "resume",
        nativeRef: input.sourceRef,
        cwd: input.cwd,
        ...(input.environment ? { environment: input.environment } : {}),
      },
      input.sourceRef,
      index + 1,
    );
  } catch (error) {
    return { ok: false, error: nativeHistoryError(error) };
  }
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
