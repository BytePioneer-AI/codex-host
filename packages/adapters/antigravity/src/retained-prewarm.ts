import { createHash } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

import { sanitizeDiagnosticTail, type HarnessResult } from "@codexhost/harness-adapter";
import { jsonlRecords } from "@codexhost/harness-adapter/usage-statistics";
import {
  harnessIdSchema,
  type BillingSourceRef,
  type RetainedPrewarmParams,
  type RetainedPrewarmResult,
} from "@codexhost/shared-contracts";

import { AntigravityAcpTransport } from "./acp-transport.js";
import type {
  AntigravityAcpConfigOption,
  AntigravityAcpSessionOpenResult,
  AntigravityAcpTransportOptions,
  AntigravityAcpTransportLike,
} from "./acp-types.js";
import { normalizeAntigravityUsageModel } from "./acp-usage.js";
import { nativeBrainDirPath, nativeConversationDbPath, validNativeSessionRef } from "./fork.js";
import { findAntigravityAcpConfigOption } from "./model-catalog.js";
import type { AntigravityQuotaReading } from "./quota.js";
import { antigravityHome } from "./usage-statistics.js";

const harnessId = harnessIdSchema.parse("antigravity");
const MODELS_BY_SCOPE: Readonly<Record<string, string | undefined>> = {
  "gemini models": "gemini-3.8-flash",
  "claude and gpt models": "claude-sonnet-5-5",
};
const THINKING_OPTION = "low";
const PERMISSION_MODE = "default";
const PROMPT =
  "[codexhost-quota-prewarm]\nReply only with OK. Do not use tools or make any changes.";
const RUN_TIMEOUT_MS = 90_000;
const CLOSE_TIMEOUT_MS = 3_000;
const STALE_ACCOUNT = "The requested Antigravity Profile or login is no longer active";
const LEGACY_LOGIN_CHANGED = "The login for this Antigravity Profile changed";

/** Resolve only agy's current data directory (or its existing ancestor on a fresh Profile). */
export async function antigravityProfileRef(
  environment: NodeJS.ProcessEnv,
): Promise<BillingSourceRef> {
  const directory = path.resolve(antigravityHome(environment), ".gemini", "antigravity-cli");
  let ancestor = directory;
  for (;;) {
    try {
      const physical = await realpath(ancestor);
      const canonical = path.join(physical, path.relative(ancestor, directory));
      return {
        harnessId,
        id: createHash("sha256").update("antigravity:profile\0").update(canonical).digest("hex"),
      };
    } catch (error) {
      const parent = path.dirname(ancestor);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

export function antigravityRetainedPrewarmScopes(quota: AntigravityQuotaReading): string[] {
  const scopes = new Map<string, string | null>();
  for (const { scope } of quota.buckets) {
    if (!scope) continue;
    const key = scope.id.toLowerCase();
    if (!Object.hasOwn(MODELS_BY_SCOPE, key)) continue;
    const previous = scopes.get(key);
    if (previous === undefined) scopes.set(key, scope.id);
    else if (previous !== scope.id) scopes.set(key, null);
  }
  return [...scopes.values()].filter((scope): scope is string => scope !== null);
}

type ModelVerification = RetainedPrewarmResult["modelVerification"];
type SessionRef = NonNullable<RetainedPrewarmResult["nativeSessionRef"]>;
type StoredRun = {
  native_session_id: string | null;
  verification: ModelVerification;
  state: "creating" | "running" | "succeeded" | "failed" | "unresolved";
  model: string | null;
  login_identity: string | null;
  last_source_id: string | null;
  workspace_source: string | null;
  error: string | null;
};

type RunOptions = Pick<
  AntigravityAcpTransportOptions,
  "command" | "commandTimeoutMs" | "closeTimeoutMs"
> & {
  environment: NodeJS.ProcessEnv;
  signal: AbortSignal;
  readActiveQuota(signal: AbortSignal, cwd: string): Promise<AntigravityQuotaReading | null>;
  createTransport?: (options: AntigravityAcpTransportOptions) => AntigravityAcpTransportLike;
};

function openState(directory: string): DatabaseSync {
  const db = new DatabaseSync(path.join(directory, "sessions.sqlite"));
  try {
    db.exec(`
      PRAGMA busy_timeout = 500;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS retained_sessions (
        source_id TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        native_session_id TEXT UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('creating', 'running', 'succeeded', 'failed', 'unresolved')),
        verification TEXT NOT NULL CHECK (verification IN ('not-run', 'matched', 'mismatch', 'unavailable')),
        observed_models TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        CHECK (state NOT IN ('running', 'succeeded') OR native_session_id IS NOT NULL),
        PRIMARY KEY (source_id, scope_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS retained_profiles (
        profile_id TEXT PRIMARY KEY,
        first_login TEXT,
        active_login TEXT,
        switched INTEGER NOT NULL DEFAULT 0 CHECK (switched IN (0, 1))
      ) STRICT;
    `);
    if (db.prepare("PRAGMA user_version").get()?.user_version !== 2) {
      db.exec("BEGIN IMMEDIATE");
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (version === 0) {
        db.exec(`
          ALTER TABLE retained_sessions ADD COLUMN model TEXT;
          ALTER TABLE retained_sessions ADD COLUMN login_identity TEXT;
          ALTER TABLE retained_sessions ADD COLUMN workspace_source TEXT;
        `);
      }
      if (version === 0 || version === 1) {
        db.exec(`
          ALTER TABLE retained_sessions ADD COLUMN last_source_id TEXT;
          UPDATE retained_sessions SET last_source_id = source_id WHERE model IS NOT NULL;
          PRAGMA user_version = 2;
        `);
        db.prepare(
          `
          UPDATE retained_sessions SET state = 'succeeded', error = NULL
          WHERE state = 'failed' AND model IS NOT NULL AND native_session_id IS NOT NULL
            AND verification != 'mismatch' AND error = ?
        `,
        ).run(LEGACY_LOGIN_CHANGED);
      } else if (version !== 2) {
        throw new Error("Unsupported Antigravity retained Session store version");
      }
      db.exec("COMMIT");
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function loginSource(profileId: string, first: string, observed: string): string {
  return first === observed
    ? profileId
    : createHash("sha256")
        .update("antigravity:profile-login\0")
        .update(profileId)
        .update(observed)
        .digest("hex");
}

function bindProfile(db: DatabaseSync, profileId: string, observed?: string): string | undefined {
  db.exec("BEGIN IMMEDIATE");
  try {
    const profile = db
      .prepare(
        "SELECT first_login, active_login, switched FROM retained_profiles WHERE profile_id = ?",
      )
      .get(profileId) as
      { first_login: string | null; active_login: string | null; switched: number } | undefined;
    let first = profile?.first_login ?? null;
    let active = profile?.active_login ?? null;
    if (!profile) {
      // Recover the login already attached to a Profile-keyed Session by the previous schema.
      const previous = db
        .prepare(
          `
        SELECT DISTINCT login_identity FROM retained_sessions
        WHERE source_id = ? AND login_identity IS NOT NULL LIMIT 2
      `,
        )
        .all(profileId);
      if (previous.length > 1)
        throw new Error("Conflicting logins for the retained Antigravity Profile");
      first = active = (previous[0]?.login_identity as string | undefined) ?? observed ?? null;
      db.prepare(
        "INSERT INTO retained_profiles (profile_id, first_login, active_login) VALUES (?, ?, ?)",
      ).run(profileId, first, active);
    }
    let switched = profile?.switched === 1;
    if (observed && active !== observed) {
      switched ||= first !== null && active !== null;
      first ??= observed;
      active = observed;
      db.prepare(
        "UPDATE retained_profiles SET first_login = ?, active_login = ?, switched = ? WHERE profile_id = ?",
      ).run(first, active, switched ? 1 : 0, profileId);
    }
    db.exec("COMMIT");
    return observed && first ? loginSource(profileId, first, observed) : profileId;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function inspectAntigravityPrewarmSource(
  environment: NodeJS.ProcessEnv,
  profile: BillingSourceRef,
  quota: AntigravityQuotaReading,
  directory?: string,
): Promise<{ ref: BillingSourceRef; scopes: string[] } | undefined> {
  if (directory) await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await antigravityProfileRef(environment)).id !== profile.id) return undefined;
  const scopes = antigravityRetainedPrewarmScopes(quota);
  if (!directory) return { ref: profile, scopes };
  const db = openState(directory);
  try {
    const id = bindProfile(db, profile.id, quota.loginIdentity);
    if (!id) return undefined;
    return { ref: { harnessId, id }, scopes };
  } finally {
    db.close();
  }
}

function sessionRef(nativeSessionId: string): SessionRef {
  const ref = { harnessId, nativeSessionId, formatVersion: 1 as const };
  if (!validNativeSessionRef(ref, harnessId))
    throw new Error("Antigravity returned an invalid retained Session ID");
  return ref;
}

async function withAbort<T>(signal: AbortSignal, start: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const { promise, reject } = Promise.withResolvers<never>();
  const onAbort = () => reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, start()]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function modelIsLocked(config: readonly AntigravityAcpConfigOption[], model: string): boolean {
  const selected = findAntigravityAcpConfigOption(config, "model");
  if (!selected?.options.some(({ value }) => value === selected.currentValue)) return false;
  const thinking = findAntigravityAcpConfigOption(config, "thinking");
  const confirmedLow =
    thinking?.currentValue === THINKING_OPTION &&
    thinking.options.some(({ value }) => value === THINKING_OPTION);
  if (selected.currentValue === `${model}-${THINKING_OPTION}`)
    return thinking === undefined || confirmedLow;
  return selected.currentValue === model && confirmedLow;
}

async function lockModel(
  transport: AntigravityAcpTransportLike,
  opened: AntigravityAcpSessionOpenResult,
  model: string,
  signal: AbortSignal,
): Promise<void> {
  const lowVariant = `${model}-${THINKING_OPTION}`;
  if (
    opened.models &&
    !opened.models.availableModels.some(
      ({ modelId }) => modelId === model || modelId === lowVariant,
    )
  )
    throw new Error("Antigravity's native catalog does not offer the retained prewarm Model");
  const option = findAntigravityAcpConfigOption(opened.configOptions ?? [], "model");
  const target = option?.options.some(({ value }) => value === lowVariant) ? lowVariant : model;
  if (!option?.options.some(({ value }) => value === target))
    throw new Error("Antigravity does not offer the exact retained prewarm Model");
  let config = await withAbort(signal, () => transport.setConfigOption(option.id, target));
  if (config.find(({ id }) => id === option.id)?.currentValue !== target)
    throw new Error("Antigravity did not confirm the retained prewarm Model selection");
  const thinking = findAntigravityAcpConfigOption(config, "thinking");
  if (target === model || thinking) {
    if (!thinking?.options.some(({ value }) => value === THINKING_OPTION))
      throw new Error("Antigravity does not offer low reasoning for the retained prewarm Model");
    config = await withAbort(signal, () => transport.setConfigOption(thinking.id, THINKING_OPTION));
  }
  if (!modelIsLocked(config, model))
    throw new Error("Antigravity did not confirm the retained prewarm Model with low reasoning");
}

async function transcriptModels(
  file: string,
  after: number | undefined,
  signal: AbortSignal,
): Promise<{ watermark: number; models: string[] } | null> {
  let watermark = after ?? -1;
  const steps = new Map<number, string | undefined>();
  try {
    for await (const record of jsonlRecords(file, '"PLANNER_RESPONSE"', signal)) {
      if (record.type !== "PLANNER_RESPONSE") continue;
      const step = record.step_index;
      if (typeof step !== "number" || !Number.isSafeInteger(step) || step < 0) continue;
      watermark = Math.max(watermark, step);
      if (after === undefined || step <= after) continue;
      const model = typeof record.model === "string" ? record.model.trim() : "";
      steps.set(
        step,
        (record.status === "DONE" || record.status === "ERROR") && model && model.length <= 256
          ? model
          : undefined,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
  }
  return {
    watermark,
    models: [...new Set([...steps.values()].filter((model): model is string => !!model))],
  };
}

async function observeModels(file: string, after: number, signal: AbortSignal): Promise<string[]> {
  for (const wait of [0, 100, 300]) {
    if (wait) await delay(wait, undefined, { signal });
    const read = await transcriptModels(file, after, signal);
    if (read?.models.length) return read.models;
  }
  return [];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError")
    return "Antigravity retained prewarm timed out";
  return sanitizeDiagnosticTail(error instanceof Error ? error.message : String(error)).slice(-512);
}

export async function runAntigravityRetainedPrewarm(
  input: RetainedPrewarmParams,
  storageDirectory: string,
  options: RunOptions,
): Promise<HarnessResult<RetainedPrewarmResult>> {
  const scope = input.scopeId.toLowerCase();
  const model = Object.hasOwn(MODELS_BY_SCOPE, scope) ? MODELS_BY_SCOPE[scope] : undefined;
  if (!model || input.billingSourceRef.harnessId !== harnessId)
    return {
      ok: false,
      error: {
        code: "invalidRequest",
        message: "Unsupported Antigravity prewarm target",
        retryable: false,
      },
    };

  const sourceId = input.billingSourceRef.id;
  let profileId: string;
  const matchesProfile = async () => {
    const current = await antigravityProfileRef(options.environment).catch(() => null);
    return current?.id === profileId;
  };
  let ref: SessionRef | null = null;
  let verification: ModelVerification = "not-run";
  let accountChanged: boolean | undefined;
  const outcome = (
    status: RetainedPrewarmResult["status"],
    error?: string,
  ): HarnessResult<RetainedPrewarmResult> => ({
    ok: true,
    value: {
      ...input,
      harnessId,
      model,
      thinkingOptionId: THINKING_OPTION,
      nativeSessionRef: ref,
      status,
      modelVerification: verification,
      accountVerification: quota?.loginIdentity ? "verified" : "unverified",
      ...(accountChanged !== undefined ? { accountChanged } : {}),
      ...(error ? { error } : {}),
    },
  });

  let quota: AntigravityQuotaReading | null;
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(Math.min(options.commandTimeoutMs ?? RUN_TIMEOUT_MS, RUN_TIMEOUT_MS)),
  ]);
  try {
    const profile = await antigravityProfileRef(options.environment).catch(() => null);
    if (!profile) return outcome("blocked", "The Antigravity Profile could not be resolved");
    profileId = profile.id;
    await withAbort(signal, () => mkdir(storageDirectory, { recursive: true, mode: 0o700 }));
    quota = await withAbort(signal, () => options.readActiveQuota(signal, storageDirectory));
    if (!(await matchesProfile()))
      return outcome("blocked", "The requested Antigravity Profile is no longer active");
  } catch (error) {
    return outcome("blocked", errorMessage(error));
  }

  let cwd: string;
  let db: DatabaseSync | undefined;
  try {
    if (!quota) return outcome("blocked", "Antigravity did not report native quota");
    const loginIdentity = quota.loginIdentity;
    accountChanged = loginIdentity ? false : undefined;
    db = openState(storageDirectory);
    const active = bindProfile(db, profileId, loginIdentity);
    if (active !== sourceId) {
      if (active !== undefined && loginIdentity) accountChanged = true;
      return outcome("blocked", STALE_ACCOUNT);
    }
    if (!antigravityRetainedPrewarmScopes(quota).includes(input.scopeId))
      return outcome(
        "blocked",
        "The requested Antigravity prewarm scope is not advertised by the native account",
      );
    const select = db.prepare(
      "SELECT * FROM retained_sessions WHERE source_id = ? AND scope_id = ?",
    );
    // Preserve the original Profile Session, or adopt the only attributable
    // Session from a version that keyed the ledger by confirmed login.
    if (!select.get(profileId, scope)) {
      const first = db
        .prepare("SELECT first_login FROM retained_profiles WHERE profile_id = ?")
        .get(profileId)?.first_login as string | null;
      if (first) {
        const previousRows = db
          .prepare(
            `
          SELECT source_id, login_identity FROM retained_sessions
          WHERE scope_id = ? AND model IS NOT NULL AND login_identity IS NOT NULL
        `,
          )
          .all(scope) as { source_id: string; login_identity: string }[];
        const candidates = previousRows.filter(
          (row) => row.source_id === loginSource(profileId, first, row.login_identity),
        );
        if (candidates.length > 1)
          return outcome(
            "blocked",
            "Several older retained Sessions match this Antigravity Profile and scope",
          );
        if (candidates[0]) {
          const previous = candidates[0].source_id;
          db.prepare(
            `
            UPDATE retained_sessions SET source_id = ?, workspace_source = COALESCE(workspace_source, source_id)
            WHERE source_id = ? AND scope_id = ?
              AND NOT EXISTS (SELECT 1 FROM retained_sessions WHERE source_id = ? AND scope_id = ?)
          `,
          ).run(profileId, previous, scope, profileId, scope);
        }
      }
    }
    // Older versions keyed by an observed Google subject. Adopt only an exact match;
    // an unattributable legacy row must not cause a second native Session to be created.
    if (loginIdentity && !select.get(profileId, scope)) {
      const legacy = select.get(loginIdentity, scope) as StoredRun | undefined;
      const nativeId = legacy?.model === null && legacy.native_session_id;
      const existing =
        nativeId &&
        (await stat(
          nativeConversationDbPath(
            sessionRef(nativeId).nativeSessionId,
            antigravityHome(options.environment),
          ),
        ).catch(() => null));
      if (existing && existing.isFile() && (await matchesProfile())) {
        db.prepare(
          `
          UPDATE retained_sessions SET source_id = ?, model = ?, login_identity = ?, workspace_source = ?, last_source_id = ?
          WHERE source_id = ? AND scope_id = ? AND model IS NULL
            AND NOT EXISTS (SELECT 1 FROM retained_sessions WHERE source_id = ? AND scope_id = ?)
        `,
        ).run(
          profileId,
          model,
          loginIdentity,
          loginIdentity,
          sourceId,
          loginIdentity,
          scope,
          profileId,
          scope,
        );
      }
    }
    if (
      !select.get(profileId, scope) &&
      db
        .prepare("SELECT 1 FROM retained_sessions WHERE scope_id = ? AND model IS NULL LIMIT 1")
        .get(scope)
    )
      return outcome("blocked", "An older retained Session cannot be attributed to this Profile");

    // Claim across processes; a lost caller leaves creating/running behind and cannot replay.
    const claim = db
      .prepare(
        `
      INSERT INTO retained_sessions (source_id, scope_id, model, state, verification)
      VALUES (?, ?, ?, 'creating', 'not-run')
      ON CONFLICT (source_id, scope_id) DO UPDATE SET
        state = 'running', verification = 'not-run', observed_models = '[]', error = NULL
      WHERE retained_sessions.state = 'succeeded' AND retained_sessions.model = excluded.model
      RETURNING native_session_id, workspace_source, last_source_id
    `,
      )
      .get(profileId, scope, model) as
      Pick<StoredRun, "native_session_id" | "workspace_source" | "last_source_id"> | undefined;
    if (!claim) {
      const previous = select.get(profileId, scope) as StoredRun | undefined;
      if (previous?.state === "succeeded" && previous.model !== model) {
        const failure = "The retained Antigravity Model changed";
        db.prepare(
          `
          UPDATE retained_sessions SET state = 'failed', error = ?
          WHERE source_id = ? AND scope_id = ? AND state = 'succeeded'
        `,
        ).run(failure, profileId, scope);
        if (previous.native_session_id) ref = sessionRef(previous.native_session_id);
        return outcome("failed", failure);
      }
      if (previous?.native_session_id) ref = sessionRef(previous.native_session_id);
      verification = previous?.verification ?? "not-run";
      return outcome(
        "blocked",
        previous?.error ?? "A previous Antigravity prewarm is running or unresolved",
      );
    }
    if (loginIdentity) {
      accountChanged = claim.last_source_id !== null && claim.last_source_id !== sourceId;
    }
    const key = createHash("sha256")
      .update(JSON.stringify([claim.workspace_source ?? profileId, scope]))
      .digest("hex");
    cwd = path.join(storageDirectory, "workspaces", key);

    let failure: string | undefined;
    let models: string[] = [];
    let transport: AntigravityAcpTransportLike | undefined;
    let transcript: { file: string; watermark: number | undefined } | undefined;
    let disposition = claim.native_session_id ? "running" : "creating";
    let createDispatched = false;
    let staleAccount = false;
    try {
      await withAbort(signal, () => mkdir(cwd, { recursive: true, mode: 0o700 }));
      if (!(await matchesProfile()))
        throw new Error("The requested Antigravity Profile is no longer active");
      const transportOptions: AntigravityAcpTransportOptions = {
        cwd,
        environment: options.environment,
        skipPermissions: false,
        ...(options.command ? { command: options.command } : {}),
        ...(options.commandTimeoutMs !== undefined
          ? { commandTimeoutMs: options.commandTimeoutMs }
          : {}),
        closeTimeoutMs: Math.min(options.closeTimeoutMs ?? 2000, CLOSE_TIMEOUT_MS - 500),
      };
      if (claim.native_session_id) ref = sessionRef(claim.native_session_id);
      const native =
        options.createTransport?.(transportOptions) ??
        new AntigravityAcpTransport(transportOptions);
      transport = native;
      if (native.skipPermissions)
        throw new Error("Retained prewarm cannot bypass Antigravity permissions");
      await withAbort(signal, () => native.initialize());
      if (!(await matchesProfile()))
        throw new Error("The requested Antigravity Profile is no longer active");
      const { opened } = await withAbort(signal, () => {
        createDispatched = ref === null;
        return native.openSession(
          ref ? { kind: "resume", sessionId: ref.nativeSessionId, cwd } : { kind: "create", cwd },
        );
      });
      const openedRef = sessionRef(opened.sessionId);
      if (
        native.sessionId !== openedRef.nativeSessionId ||
        (ref && ref.nativeSessionId !== openedRef.nativeSessionId)
      )
        throw new Error("Antigravity opened a different retained Session");
      if (!ref) {
        const saved = db
          .prepare(
            `
          UPDATE retained_sessions SET native_session_id = ?, state = 'running'
          WHERE source_id = ? AND scope_id = ? AND state = 'creating'
        `,
          )
          .run(openedRef.nativeSessionId, profileId, scope);
        if (saved.changes !== 1)
          throw new Error("Could not persist the retained Antigravity Session");
        ref = openedRef;
        disposition = "running";
      }

      const unexpected = new AbortController();
      const promptSignal = AbortSignal.any([signal, unexpected.signal]);
      let locked = false;
      const rejectInteraction = () =>
        unexpected.abort(new Error("Antigravity prewarm attempted a tool or interaction"));
      native.setSessionEventHandler((event) => {
        if (
          locked &&
          ((event.type === "config.update" && !modelIsLocked(event.configOptions, model)) ||
            (event.type === "mode.update" && event.currentModeId !== PERMISSION_MODE))
        )
          unexpected.abort(new Error("Antigravity changed the locked prewarm configuration"));
      });
      await lockModel(native, opened, model, signal);
      locked = true;
      await withAbort(promptSignal, () => native.setMode(PERMISSION_MODE));
      const file = path.join(
        nativeBrainDirPath(ref.nativeSessionId, antigravityHome(options.environment)),
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      const before = await withAbort(promptSignal, () =>
        transcriptModels(file, undefined, promptSignal),
      );
      quota = await withAbort(promptSignal, () => options.readActiveQuota(promptSignal, cwd));
      if (!(await matchesProfile()))
        throw new Error("The requested Antigravity Profile is no longer active");
      if (!quota?.loginIdentity && accountChanged === false) accountChanged = undefined;
      if (quota) {
        const confirmed = bindProfile(db, profileId, quota.loginIdentity);
        if (confirmed !== sourceId) {
          staleAccount = true;
          if (quota.loginIdentity && confirmed !== undefined) accountChanged = true;
          throw new Error(STALE_ACCOUNT);
        }
      }
      if (!quota || !antigravityRetainedPrewarmScopes(quota).includes(input.scopeId))
        throw new Error("The requested Antigravity prewarm scope is no longer advertised");
      const currentQuota = quota;
      const recordAccount = db.prepare(`
        UPDATE retained_sessions SET last_source_id = ?, login_identity = ?
        WHERE source_id = ? AND scope_id = ? AND state = 'running'
      `);
      const prompt = await withAbort(promptSignal, () => {
        if (
          recordAccount.run(
            currentQuota.loginIdentity ? sourceId : claim.last_source_id,
            currentQuota.loginIdentity ?? null,
            profileId,
            scope,
          ).changes !== 1
        )
          throw new Error("Could not record the current Antigravity account before prompting");
        transcript = { file, watermark: before?.watermark };
        return native.prompt([{ type: "text", text: PROMPT }], {
          onEvent(event) {
            if (event.type === "tool.call" || event.type === "tool.update") rejectInteraction();
          },
          async onPermission() {
            rejectInteraction();
            return { outcome: { outcome: "cancelled" } };
          },
          async onElicitation() {
            rejectInteraction();
            return { action: "cancel" };
          },
        });
      });
      promptSignal.throwIfAborted();
      if (prompt.stopReason !== "end_turn")
        throw new Error("Antigravity did not finish the retained prewarm prompt");
    } catch (error) {
      failure = errorMessage(error) || "Antigravity retained prewarm failed";
    } finally {
      const native = transport;
      if (native) {
        try {
          await withAbort(AbortSignal.timeout(CLOSE_TIMEOUT_MS), () => native.close());
        } catch {
          failure ??= "Antigravity retained prewarm transport did not close";
        }
      }
    }

    if (transcript) {
      verification = "unavailable";
      const { file, watermark } = transcript;
      if (watermark !== undefined)
        models = await withAbort(signal, () => observeModels(file, watermark, signal)).catch(
          () => [],
        );
      if (
        models.some(
          (actual) =>
            normalizeAntigravityUsageModel(actual).model !== model ||
            /-(?:medium|high|xhigh|max)$/u.test(actual),
        )
      ) {
        verification = "mismatch";
        failure = "Antigravity's native transcript recorded a different Model or reasoning level";
      } else if (models.length) {
        verification = "matched";
      }
    }
    if (staleAccount && ref) {
      const released = db
        .prepare(
          `
        UPDATE retained_sessions SET state = 'succeeded'
        WHERE source_id = ? AND scope_id = ? AND state = 'running'
      `,
        )
        .run(profileId, scope);
      return outcome(
        "blocked",
        released.changes === 1
          ? STALE_ACCOUNT
          : "Could not release the retained Antigravity Session",
      );
    }
    if (signal.aborted) failure ??= errorMessage(signal.reason);
    const status = failure ? "failed" : "succeeded";
    const state = status === "failed" && createDispatched && ref === null ? "unresolved" : status;
    const saved = db
      .prepare(
        `
      UPDATE retained_sessions SET state = ?, verification = ?, observed_models = ?, error = ?
      WHERE source_id = ? AND scope_id = ? AND state = ?
    `,
      )
      .run(
        state,
        verification,
        JSON.stringify(models),
        failure ?? null,
        profileId,
        scope,
        disposition,
      );
    if (saved.changes !== 1)
      return outcome("blocked", "Could not commit the Antigravity prewarm outcome");
    return outcome(status, failure);
  } catch {
    return outcome("blocked", "Antigravity retained prewarm state is unavailable or unresolved");
  } finally {
    db?.close();
  }
}
