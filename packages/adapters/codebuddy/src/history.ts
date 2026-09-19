import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { access, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  HostItemSnapshot,
  HostThreadSnapshot,
  HostTurnSnapshot,
  HostUsage,
} from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  nativeCheckpointRefSchema,
  nativeTurnRefSchema,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";
import {
  CODEBUDDY_RUNTIME_PROFILE,
  CodeBuddyError,
  nativeError,
  record,
  text,
  type CodeBuddyRuntimeProfile,
} from "./common.js";
import { capabilitiesForProfile, modelRef } from "./configuration.js";
import { contentText, toolItem, toolOutcome, toolOutput } from "./projection.js";
import { nativeCommandsEnabled } from "./slash-commands.js";
import { codeBuddyChildId, codeBuddyDelegation } from "./subagent-tool.js";
import { readCodeBuddyVersionedText, type CodeBuddyFileVersion } from "./file-observation.js";

interface CodeBuddyHistorySource {
  file: string;
  contents: string;
  historicalCwds: string[];
  reusableVersion: CodeBuddyFileVersion | undefined;
}

export interface CodeBuddyHistoryTransaction {
  /** Administrative derivation reads are always confined to the requested project's primary file. */
  requirePrimary?: true;
  /** Exact rows already verified in an immutable source snapshot. */
  inheritedContents?: string;
  /** Additional historical directories accepted only during this derivation transaction. */
  allowedHistoricalCwds?: readonly string[];
}

interface DerivedLocator {
  boundCwd: string;
  targetProjectSlug: string;
  inheritedPrefixRows: number;
  inheritedPrefixSha256: string;
  bindingMarkerId: string;
}

export function codeBuddyProjectSlug(
  cwd: string,
  profile: CodeBuddyRuntimeProfile = CODEBUDDY_RUNTIME_PROFILE,
) {
  const canonical = codeBuddyCanonicalCwd(cwd);
  if (profile.projectDirectoryName) return profile.projectDirectoryName(canonical);
  return canonical
    .replace(/[^a-z0-9]/giu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .toLowerCase();
}

export function codeBuddyCanonicalCwd(cwd: string) {
  try {
    return realpathSync.native(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

export function codeBuddyConfigRoot(environment: NodeJS.ProcessEnv, profile: CodeBuddyRuntimeProfile) {
  const configuredRoot = profile.configDirectoryEnvironmentVariables
    .map((name) => environment[name])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return (
    configuredRoot ||
    path.join(
      environment.HOME || environment.USERPROFILE || homedir(),
      profile.defaultConfigDirectoryName,
    )
  );
}

export function codeBuddyPrimaryHistoryPath(
  cwd: string,
  ref: NativeSessionRef,
  environment: NodeJS.ProcessEnv,
  profile: CodeBuddyRuntimeProfile = CODEBUDDY_RUNTIME_PROFILE,
) {
  return path.join(
    codeBuddyConfigRoot(environment, profile),
    "projects",
    codeBuddyProjectSlug(cwd, profile),
    `${ref.nativeSessionId}.jsonl`,
  );
}

function derivedLocator(ref: NativeSessionRef): DerivedLocator | undefined {
  const locator = record(ref.locator);
  if (locator.codebuddyDerived !== 1) return undefined;
  const fields = [
    locator.boundCwd,
    locator.targetProjectSlug,
    locator.inheritedPrefixRows,
    locator.inheritedPrefixSha256,
    locator.bindingMarkerId,
  ];
  // CodeBuddy's original same-directory derivation locator predates the
  // cross-directory provenance fields. An all-legacy locator remains valid;
  // a partially populated provenance locator must fail closed.
  if (fields.every((value) => value === undefined)) return undefined;
  if (
    typeof locator.boundCwd !== "string" ||
    !locator.boundCwd ||
    typeof locator.targetProjectSlug !== "string" ||
    !locator.targetProjectSlug ||
    !Number.isSafeInteger(locator.inheritedPrefixRows) ||
    Number(locator.inheritedPrefixRows) < 0 ||
    typeof locator.inheritedPrefixSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(locator.inheritedPrefixSha256) ||
    typeof locator.bindingMarkerId !== "string" ||
    !locator.bindingMarkerId
  )
    throw new CodeBuddyError("protocolError", "Derived Native Session locator is incomplete");
  return {
    boundCwd: locator.boundCwd,
    targetProjectSlug: locator.targetProjectSlug,
    inheritedPrefixRows: Number(locator.inheritedPrefixRows),
    inheritedPrefixSha256: locator.inheritedPrefixSha256,
    bindingMarkerId: locator.bindingMarkerId,
  };
}

export function nativeRowsDigest(rows: readonly Record<string, unknown>[]) {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export function validateNativeRef(
  ref: NativeSessionRef,
  profile: CodeBuddyRuntimeProfile = CODEBUDDY_RUNTIME_PROFILE,
) {
  if (
    ref.harnessId !== profile.harnessId ||
    ref.formatVersion !== 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u.test(ref.nativeSessionId)
  ) {
    throw new CodeBuddyError(
      "invalidRequest",
      `Invalid ${profile.displayName} Native Session identity`,
    );
  }
}

async function sameCwd(left: string, right: string) {
  const b = await realpath(right);
  const a = await realpath(left).catch((error) => {
    if (["ENOENT", "ENOTDIR"].includes(String(record(error).code)))
      throw new CodeBuddyError(
        "invalidRequest",
        "Native Session historical working directory is unavailable; ownership cannot be verified",
      );
    throw error;
  });
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function matchesAnyHistoricalCwd(value: string, candidates: readonly string[]) {
  const resolved = path.resolve(value);
  for (const candidate of candidates) {
    const other = path.resolve(candidate);
    if (
      process.platform === "win32"
        ? resolved.toLowerCase() === other.toLowerCase()
        : resolved === other
    )
      return true;
    try {
      if (await sameCwd(value, candidate)) return true;
    } catch (error) {
      if (
        !(error instanceof CodeBuddyError) &&
        !["ENOENT", "ENOTDIR"].includes(text(record(error).code))
      )
        throw error;
    }
  }
  return false;
}

export async function codeBuddyNativeHistory(
  cwd: string,
  ref: NativeSessionRef,
  environment: NodeJS.ProcessEnv,
  profileOrVerifiedSource: CodeBuddyRuntimeProfile | string = CODEBUDDY_RUNTIME_PROFILE,
  transaction?: CodeBuddyHistoryTransaction,
): Promise<CodeBuddyHistorySource> {
  const profile =
    typeof profileOrVerifiedSource === "string"
      ? CODEBUDDY_RUNTIME_PROFILE
      : profileOrVerifiedSource;
  const effectiveTransaction =
    typeof profileOrVerifiedSource === "string"
      ? { inheritedContents: profileOrVerifiedSource }
      : transaction;
  return codeBuddyHistory(cwd, ref, environment, false, profile, effectiveTransaction);
}

/** Live child observation may see one final record before CodeBuddy appends its newline. */
export async function codeBuddyLiveNativeHistory(
  cwd: string,
  ref: NativeSessionRef,
  environment: NodeJS.ProcessEnv,
  profile: CodeBuddyRuntimeProfile = CODEBUDDY_RUNTIME_PROFILE,
): Promise<CodeBuddyHistorySource> {
  return codeBuddyHistory(cwd, ref, environment, true, profile);
}

async function codeBuddyHistory(
  cwd: string,
  ref: NativeSessionRef,
  environment: NodeJS.ProcessEnv,
  tolerateIncompleteTail: boolean,
  profile: CodeBuddyRuntimeProfile,
  transaction?: CodeBuddyHistoryTransaction,
) {
  validateNativeRef(ref, profile);
  const configRoot = codeBuddyConfigRoot(environment, profile);
  const root = path.join(configRoot, "projects");
  const slug = codeBuddyProjectSlug(cwd, profile);
  const primary = path.join(root, slug, `${ref.nativeSessionId}.jsonl`);
  const provenance = derivedLocator(ref);
  let candidates: string[] = [];
  try {
    await access(primary);
    candidates = [primary];
  } catch (error) {
    if (record(error).code !== "ENOENT") throw error;
    if (transaction?.requirePrimary || provenance)
      throw new CodeBuddyError("sessionNotFound", "Native Session history was not found");
    const directories = await readdir(root, { withFileTypes: true }).catch((error) => {
      if (record(error).code === "ENOENT") return [];
      throw error;
    });
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      const file = path.join(root, directory.name, `${ref.nativeSessionId}.jsonl`);
      try {
        await access(file);
        candidates.push(file);
      } catch (error) {
        if (record(error).code !== "ENOENT") throw error;
      }
    }
  }
  if (candidates.length !== 1)
    throw new CodeBuddyError(
      "sessionNotFound",
      candidates.length
        ? "Ambiguous Native Session history"
        : "Native Session history was not found",
    );
  const file = candidates[0];
  if (!file) throw new CodeBuddyError("sessionNotFound", "Native Session history was not found");
  if (
    profile.historyCapabilities?.fork &&
    !transaction &&
    path.resolve(file) !== path.resolve(primary)
  )
    throw new CodeBuddyError(
      "invalidRequest",
      "Native Session is not stored in the requested working directory",
    );
  const source = await readCodeBuddyVersionedText(
      file,
      64_000_000,
      "Native history exceeds the supported 64 MB snapshot size",
    ),
    parsed = parseJsonl(source.contents, tolerateIncompleteTail);
  const checkedDirectories = new Set<string>();
  const inheritedRows = new Map<string, Record<string, unknown>[]>();
  for (const row of transaction?.inheritedContents
    ? parseRows(transaction.inheritedContents)
    : []) {
    const id = text(row.id);
    const candidates = inheritedRows.get(id) ?? [];
    candidates.push(row);
    inheritedRows.set(id, candidates);
  }
  const inherited = (row: Record<string, unknown>) =>
    inheritedRows.get(text(row.id))?.some((candidate) => isDeepStrictEqual(candidate, row)) ===
    true;
  if (transaction) {
    for (const row of parsed.rows) {
      if (inherited(row)) {
        if (typeof row.cwd === "string") checkedDirectories.add(row.cwd);
        continue;
      }
      if (row.sessionId && row.sessionId !== ref.nativeSessionId)
        throw new CodeBuddyError(
          "protocolError",
          "Native history has a different Session identity",
        );
      if (typeof row.cwd === "string" && !checkedDirectories.has(row.cwd)) {
        const allowed = [cwd, ...(transaction.allowedHistoricalCwds ?? [])];
        if (!(await matchesAnyHistoricalCwd(row.cwd, allowed)))
          throw new CodeBuddyError(
            "invalidRequest",
            "Native Session belongs to a different working directory",
          );
        checkedDirectories.add(row.cwd);
      }
    }
  } else if (provenance) {
    if (
      !(await sameCwd(provenance.boundCwd, cwd)) ||
      provenance.targetProjectSlug !== slug ||
      path.resolve(file) !== path.resolve(primary)
    )
      throw new CodeBuddyError("invalidRequest", "Derived Native Session target binding changed");
    const active = nativeHistoryRows(parsed.contents);
    if (
      provenance.inheritedPrefixRows > active.length ||
      nativeRowsDigest(active.slice(0, provenance.inheritedPrefixRows)) !==
        provenance.inheritedPrefixSha256
    )
      throw new CodeBuddyError(
        "protocolError",
        "Derived Native Session prefix verification failed",
      );
    const marker = parsed.rows.find((row) => text(row.id) === provenance.bindingMarkerId);
    if (
      !marker ||
      marker.sessionId !== ref.nativeSessionId ||
      typeof marker.cwd !== "string" ||
      !(await sameCwd(marker.cwd, cwd))
    )
      throw new CodeBuddyError("protocolError", "Derived Native Session target marker is missing");
    // Inherited prefix rows are pinned by the provenance digest. Only the target
    // workspace is reusable for current child-observer validation.
    checkedDirectories.add(cwd);
    const verifiedSuffixCwds = new Set<string>();
    for (const row of active.slice(provenance.inheritedPrefixRows)) {
      if (row.sessionId && row.sessionId !== ref.nativeSessionId)
        throw new CodeBuddyError(
          "protocolError",
          "Derived Native Session appended foreign history",
        );
      if (typeof row.cwd === "string" && !verifiedSuffixCwds.has(row.cwd)) {
        if (!(await sameCwd(row.cwd, cwd)))
          throw new CodeBuddyError(
            "invalidRequest",
            "Derived Native Session left its target directory",
          );
        verifiedSuffixCwds.add(row.cwd);
      }
    }
  } else {
    for (const row of parsed.rows) {
      if (row.sessionId && row.sessionId !== ref.nativeSessionId)
        throw new CodeBuddyError(
          "protocolError",
          "Native history has a different Session identity",
        );
      if (typeof row.cwd === "string" && !checkedDirectories.has(row.cwd)) {
        if (!(await sameCwd(row.cwd, cwd)))
          throw new CodeBuddyError(
            "invalidRequest",
            "Native Session belongs to a different working directory",
          );
        checkedDirectories.add(row.cwd);
      }
    }
  }
  return {
    file,
    contents: parsed.contents,
    historicalCwds: [...checkedDirectories],
    reusableVersion: source.reusableVersion,
  };
}

export async function readNativeHistory(
  cwd: string,
  ref: NativeSessionRef,
  environment: NodeJS.ProcessEnv,
  profile: CodeBuddyRuntimeProfile = CODEBUDDY_RUNTIME_PROFILE,
): Promise<string> {
  return (await codeBuddyNativeHistory(cwd, ref, environment, profile)).contents;
}

function parseRows(contents: string, tolerateIncompleteTail = false) {
  return parseJsonl(contents, tolerateIncompleteTail).rows;
}

export function nativeRawHistoryRows(contents: string) {
  return parseRows(contents);
}

function parseJsonl(contents: string, tolerateIncompleteTail: boolean) {
  const lines = contents.split(/\r?\n/u);
  const completeLines: string[] = [],
    rows: Record<string, unknown>[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(record(JSON.parse(line)));
      completeLines.push(line);
    } catch {
      if (tolerateIncompleteTail && index === lines.length - 1 && !contents.endsWith("\n"))
        continue;
      throw new CodeBuddyError(
        "protocolError",
        "Native history contains an incomplete or invalid record",
      );
    }
  }
  return {
    rows,
    contents: tolerateIncompleteTail ? completeLines.join("\n") : contents,
  };
}

const NATIVE_MESSAGE_TYPES = new Set([
  "message",
  "reasoning",
  "function_call",
  "function_call_result",
]);

/** A trailing rewind still needs a live cursor; a later message anchors the branch itself. */
export function pendingNativeHistoryRewind(contents: string) {
  const last = parseRows(contents).findLast(
    (row) => row.type === "resend-fork-notice" || NATIVE_MESSAGE_TYPES.has(text(row.type)),
  );
  return last?.type === "resend-fork-notice"
    ? { forkPointId: text(last.parentId) || null }
    : undefined;
}

/** Follow the current native parent chain, not every branch in the append-only file. */
export function nativeHistoryRows(contents: string) {
  const entries = new Map<string, Record<string, unknown>>();
  let leaf = "";
  for (const row of parseRows(contents)) {
    if (row.type === "resend-fork-notice") {
      // The notice records the desired branch, but native load may ignore it.
      // Session opening restores this cursor before allowing a new prompt.
      leaf = text(row.parentId);
      continue;
    }
    if (!NATIVE_MESSAGE_TYPES.has(text(row.type))) continue;
    if (!text(row.id))
      throw new CodeBuddyError("protocolError", "Native message is missing its stable ID");
    entries.set(text(row.id), row);
    leaf = text(row.id);
  }
  const chain: Record<string, unknown>[] = [],
    seen = new Set<string>();
  while (leaf) {
    if (seen.has(leaf))
      throw new CodeBuddyError("protocolError", "Native history contains a parent cycle");
    seen.add(leaf);
    const row = entries.get(leaf);
    if (!row) throw new CodeBuddyError("protocolError", "Native history parent is missing");
    chain.push(row);
    leaf = text(row.parentId);
  }
  return chain.reverse();
}

export function snapshotFromHistory(
  contents: string,
  ref: NativeSessionRef,
  cwd: string,
  profile: CodeBuddyRuntimeProfile = CODEBUDDY_RUNTIME_PROFILE,
): HostThreadSnapshot {
  const supportsNativeCommands = nativeCommandsEnabled(profile);
  const supportsFork = capabilitiesForProfile(profile).history.fork;
  const turns: HostTurnSnapshot[] = [];
  let current: HostTurnSnapshot | undefined;
  const tools = new Map<string, HostItemSnapshot>();
  // CodeBuddy persists a Tool call and its result from separate writers, so a call that
  // is refused before it runs can land its result first. Hold such a result until its
  // call arrives instead of failing the whole read.
  const earlyResults = new Map<string, Record<string, unknown>>();
  const applyResult = (snapshot: HostItemSnapshot, row: Record<string, unknown>) => {
    snapshot.outcome = toolOutcome(row.status, profile);
    if (snapshot.item.type === "subagentDelegation") {
      const childId = codeBuddyChildId(row);
      snapshot.item.subagents = snapshot.item.subagents.map((child) => ({
        ...child,
        ...(childId ? { subagentId: childId, nativeSubagentId: childId } : {}),
        status:
          snapshot.outcome.status === "failed"
            ? "failed"
            : child.background
              ? "interrupted"
              : "completed",
        resultSummary: child.background
          ? "Live background observation is unavailable after reload"
          : contentText(row.output).slice(0, 2000),
      }));
    }
    if (snapshot.item.type === "toolExecution") snapshot.item.output = toolOutput(row.output);
    if (snapshot.item.type === "commandExecution") {
      const output = toolOutput(row.output);
      snapshot.item.output = contentText(output.content);
      snapshot.item.outputTruncated = Boolean(output.truncated);
    }
  };
  const history = nativeHistoryRows(contents);
  // Only manual compaction creates a command Turn. Native automatic compaction
  // also has an internal user prompt, which must not split the current user Turn.
  const manualCompactions = new Set<string>();
  let compactUser: string | undefined;
  if (supportsNativeCommands)
    for (const row of history) {
      const data = record(row.providerData);
      if (row.type === "message" && row.role === "user")
        compactUser = data.agent === "compact" ? text(row.id) : undefined;
      if (compactUser && row.role === "assistant" && data.compactType === "user-command")
        manualCompactions.add(compactUser);
    }
  for (const row of history) {
    const data = record(row.providerData);
    const body = contentText(row.content);
    const localCommand =
      supportsNativeCommands && data.skipRun === true
        ? /^<command-name>([^<]+)<\/command-name>(?:\s*<command-args>([\s\S]*)<\/command-args>)?$/u.exec(
            body,
          )
        : null;
    const localOutput =
      supportsNativeCommands && data.skipRun === true
        ? /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/u.exec(body)
        : null;
    if (localOutput) {
      if (current) {
        current.items.push({
          item: {
            type: "agentMessage",
            itemId: hostItemIdSchema.parse(`agentMessage-${text(row.id)}`),
            text: localOutput[1] ?? "",
          },
          outcome: { status: "succeeded" },
        });
        current.outcome = { status: "succeeded" };
      }
      continue;
    }
    if (
      supportsNativeCommands &&
      data.skipRun === true &&
      body.startsWith('<system-reminder data-role="command-caveat">')
    )
      continue;
    if (
      supportsNativeCommands &&
      row.type === "message" &&
      row.role === "user" &&
      data.agent === "compact" &&
      !manualCompactions.has(text(row.id))
    )
      continue;
    if (row.type === "message" && row.role === "user") {
      current = {
        nativeTurnRef: nativeTurnRefSchema.parse({
          harnessId: profile.harnessId,
          nativeSessionId: ref.nativeSessionId,
          nativeTurnKey: row.id,
          formatVersion: 1,
        }),
        input: [
          {
            type: "text",
            text:
              supportsNativeCommands && data.agent === "compact"
                ? "/compact"
                : localCommand
                  ? `${localCommand[1]}${localCommand[2] ? ` ${localCommand[2]}` : ""}`
                  : body,
          },
        ],
        items: [],
        outcome: { status: "unknown", reason: "Native terminal outcome was not recorded" },
        ...(typeof row.timestamp === "number" ? { startedAtMs: row.timestamp } : {}),
      };
      turns.push(current);
      tools.clear();
      earlyResults.clear();
      continue;
    }
    if (!current) continue;
    if (supportsNativeCommands && (data.agent === "compact" || data.isCompactInternal === true)) {
      if (row.role === "assistant") {
        const outcome: HostItemSnapshot["outcome"] =
          row.status === "completed" && data.isCompacted === true
            ? { status: "succeeded" }
            : row.status === "cancelled" || row.status === "interrupted"
              ? { status: "cancelled" }
              : {
                  status: "failed",
                  error: nativeError(
                    new CodeBuddyError("nativeFailure", "Native compaction did not complete"),
                    profile,
                  ),
                };
        current.items.push({
          item: {
            type: "contextCompaction",
            itemId: hostItemIdSchema.parse(`compact-${text(row.id)}`),
          },
          outcome,
        });
        if (data.compactType === "user-command") current.outcome = outcome;
      }
      continue;
    }
    const model = text(record(row.providerData).model);
    if (model) current.model = modelRef(model);
    if ((row.type === "message" && row.role === "assistant") || row.type === "reasoning") {
      const type = row.type === "reasoning" ? "reasoning" : "agentMessage";
      const body = contentText(row.content) || contentText(row.rawContent);
      if (body)
        current.items.push({
          item: { type, itemId: hostItemIdSchema.parse(`${type}-${text(row.id)}`), text: body },
          outcome: { status: "succeeded" },
        });
      if (row.role === "assistant" && row.status === "completed") {
        current.outcome = { status: "succeeded" };
        if (typeof row.timestamp === "number") current.completedAtMs = row.timestamp;
      }
    } else if (row.type === "function_call") {
      let input: unknown = row.arguments;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          throw new CodeBuddyError("protocolError", "Invalid native Tool arguments");
        }
      }
      const callId = text(row.callId);
      const snapshot = {
        item:
          row.name === "Agent"
            ? codeBuddyDelegation(callId, input, "running", undefined, profile.displayName)
            : toolItem(callId, text(row.name), input, typeof row.cwd === "string" ? row.cwd : cwd),
        outcome: toolOutcome("unknown", profile),
      };
      tools.set(callId, snapshot);
      current.items.push(snapshot);
      current.outcome = { status: "unknown", reason: "Native Tool has not completed" };
      const early = earlyResults.get(callId);
      if (early) {
        earlyResults.delete(callId);
        applyResult(snapshot, early);
      }
    } else if (row.type === "function_call_result") {
      // A result may precede its call: a Tool refused before it runs records its result
      // without waiting for the call row. A result whose call never appears cannot be
      // attributed to a renderable Tool, so it is dropped rather than failing the read.
      const callId = text(row.callId);
      const snapshot = tools.get(callId);
      if (snapshot) applyResult(snapshot, row);
      else earlyResults.set(callId, row);
    }
  }
  if (supportsFork)
    for (const turn of turns)
      turn.checkpoint = nativeCheckpointRefSchema.parse({
        harnessId: profile.harnessId,
        nativeSessionId: ref.nativeSessionId,
        checkpointId: turn.nativeTurnRef.nativeTurnKey,
        formatVersion: 1,
      });
  return { turns };
}

/** One Usage entry per model request; duplicated tool rows do not multiply spend. */
export function historyUsage(contents: string): HostUsage | null {
  const requests = new Map<string, Record<string, unknown>>();
  for (const row of nativeHistoryRows(contents)) {
    const data = record(row.providerData),
      usage = record(data.rawUsage);
    if (Object.keys(usage).length && text(data.messageId))
      requests.set(text(data.messageId), usage);
  }
  if (!requests.size) return null;
  const fields = {
    inputTokens: "prompt_tokens",
    outputTokens: "completion_tokens",
    totalTokens: "total_tokens",
    cachedInputTokens: "cache_read_input_tokens",
    cacheWriteInputTokens: "cache_creation_input_tokens",
    reasoningOutputTokens: "completion_thinking_tokens",
    totalCredits: "credit",
  } as const;
  const result: HostUsage = {};
  for (const [host, native] of Object.entries(fields)) {
    const values = [...requests.values()].map((usage) => usage[native]);
    if (
      values.every(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value) && value >= 0,
      )
    ) {
      result[host as keyof HostUsage] = values.reduce((sum, value) => sum + value, 0);
    }
  }
  return Object.keys(result).length ? result : null;
}
