import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  HarnessSessionState,
  OpenSessionInput,
  ResumeSessionInput,
} from "@codexhost/harness-adapter";
import {
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  nativeSessionRefSchema,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";
import type { CodeBuddyClientFactory, CodeBuddyInvocationFactory } from "./acp-client.js";
import { codeBuddyInvocation } from "./command.js";
import {
  bounded,
  CODEBUDDY_RUNTIME_PROFILE,
  CodeBuddyError,
  record,
  text,
  type CodeBuddyRuntimeProfile,
} from "./common.js";
import { configuration, modelRef } from "./configuration.js";
import {
  codeBuddyNativeHistory,
  codeBuddyCanonicalCwd,
  codeBuddyPrimaryHistoryPath,
  codeBuddyProjectSlug,
  nativeHistoryRows,
  nativeRawHistoryRows,
  nativeRowsDigest,
  snapshotFromHistory,
  validateNativeRef,
} from "./history.js";
import {
  CODEBUDDY_CHILD_MAX_BYTES,
  codeBuddyChildPrefixThrough,
  codeBuddyInheritedChildDescriptor,
  type CodeBuddyInheritedChild,
  validateCodeBuddyChildContents,
} from "./child-provenance.js";
import {
  codeBuddyFileVersion,
  readCodeBuddyVersionedText,
  sameCodeBuddyFileVersion,
} from "./file-observation.js";
import { validCodeBuddyChildId } from "./subagent-tool.js";

type DeriveInput = Extract<OpenSessionInput, { kind: "fork" | "rollbackLastTurn" }>;
type Row = Record<string, unknown>;
type OwnedCopy = { file: string; expected: Buffer };

/** EOF requests native replay/copy only; this path never sends an empty model prompt. */
export async function copyCodeBuddySession(
  cwd: string,
  sourceId: string,
  targetId: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
  invocationFactory: CodeBuddyInvocationFactory = codeBuddyInvocation,
): Promise<void> {
  if (signal.aborted)
    throw new CodeBuddyError("invalidState", "Adapter closed before history copy");
  const invocation = invocationFactory(environment, false, [
    "--resume",
    sourceId,
    "--fork-session",
    "--session-id",
    targetId,
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
  ]);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.arguments, {
      cwd,
      env: invocation.environment,
      stdio: "pipe",
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      detached: process.platform !== "win32",
    });
    let output = "",
      bytes = 0,
      failed = false;
    let termination = Promise.resolve();
    const stop = () => {
      if (failed) return;
      failed = true;
      if (child.exitCode !== null || child.signalCode !== null) {
        // Do not signal a potentially reused PID while a descendant owns a pipe.
        child.stdout.destroy();
        child.stderr.destroy();
      } else if (process.platform === "win32" && child.pid) {
        termination = new Promise<void>((done) => {
          execFile(
            "taskkill",
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true, timeout: 3_000 },
            () => {
              child.kill();
              done();
            },
          );
        });
      } else if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, 30_000);
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 64_000_000) {
        stop();
        return;
      }
      output += data.toString();
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("error", reject);
    child.once("close", async (code) => {
      await termination;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (failed || signal.aborted || code !== 0) {
        reject(
          new CodeBuddyError("nativeFailure", "Native history copy failed or was interrupted"),
        );
        return;
      }
      try {
        const rows = output
          .trim()
          .split(/\r?\n/u)
          .filter(Boolean)
          .map((line) => record(JSON.parse(line)));
        const init = rows.find((row) => row.type === "system" && row.subtype === "init");
        const result = rows.findLast((row) => row.type === "result");
        if (
          init?.session_id !== targetId ||
          result?.session_id !== targetId ||
          result?.is_error !== false ||
          result?.duration_api_ms !== 0
        )
          throw new CodeBuddyError(
            "unsupported",
            "Native CLI did not confirm a model-free history copy",
          );
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    if (signal.aborted) stop();
    child.stdin.end();
  });
}

function withoutIdentity(row: Row) {
  const result = { ...row };
  delete result.id;
  delete result.parentId;
  delete result.logicalParentId;
  delete result.sessionId;
  return result;
}

/** Native /fork remaps IDs; compare content and both parent edges, not generated IDs. */
export function assertCopiedPrefix(source: Row[], copied: Row[]) {
  if (copied.length < source.length)
    throw new CodeBuddyError("unsupported", "Native Fork omitted history");
  const ids = new Map(source.map((row, index) => [text(row.id), text(copied[index]?.id)]));
  for (const [index, row] of source.entries()) {
    const clone = copied[index];
    if (!clone) throw new CodeBuddyError("unsupported", "Native Fork omitted history");
    if (
      !isDeepStrictEqual(withoutIdentity(row), withoutIdentity(clone)) ||
      ["parentId", "logicalParentId"].some(
        (key) => text(clone[key]) !== (ids.get(text(row[key])) ?? ""),
      )
    )
      throw new CodeBuddyError(
        "unsupported",
        "Native Fork did not preserve the exact history prefix",
      );
  }
}

function commandCaveat(row: Row | undefined) {
  return (
    record(row?.providerData).skipRun === true &&
    JSON.stringify(row?.content).includes('data-role=\\"command-caveat\\"')
  );
}

export function retainedRowCount(
  input: DeriveInput,
  contents: string,
  sourceCwd = input.cwd,
  profile: CodeBuddyRuntimeProfile = CODEBUDDY_RUNTIME_PROFILE,
) {
  const rows = nativeHistoryRows(contents);
  const turns = snapshotFromHistory(contents, input.sourceRef, sourceCwd, profile).turns;
  let excluded: string | undefined;
  if (input.kind === "rollbackLastTurn") {
    if (!turns.length)
      throw new CodeBuddyError("invalidState", "Native Session has no Turn to revise");
    excluded = turns.at(-1)?.nativeTurnRef.nativeTurnKey;
  } else {
    const checkpoint = input.checkpoint;
    const index = turns.findIndex(
      (turn) => turn.nativeTurnRef.nativeTurnKey === checkpoint.checkpointId,
    );
    if (
      checkpoint.harnessId !== profile.harnessId ||
      checkpoint.nativeSessionId !== input.sourceRef.nativeSessionId ||
      checkpoint.formatVersion !== 1 ||
      index < 0
    )
      throw new CodeBuddyError("checkpointNotFound", "Native Fork checkpoint was not found");
    excluded = turns[index + 1]?.nativeTurnRef.nativeTurnKey;
  }
  let count = excluded ? rows.findIndex((row) => row.id === excluded) : rows.length;
  if (count < 0) throw new CodeBuddyError("protocolError", "Native Turn boundary is missing");
  if (excluded) while (count > 0 && commandCaveat(rows[count - 1])) count--;
  return count;
}

export interface DerivationOptions {
  input: DeriveInput;
  sourceCwd?: string;
  environment: NodeJS.ProcessEnv;
  factory: CodeBuddyClientFactory;
  invocationFactory?: CodeBuddyInvocationFactory;
  profile?: CodeBuddyRuntimeProfile;
  signal: AbortSignal;
  state?: HarnessSessionState;
  copy?: typeof copyCodeBuddySession;
}

function sameResolvedPath(left: string, right: string) {
  const a = codeBuddyCanonicalCwd(left),
    b = codeBuddyCanonicalCwd(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Create a target-project copy without inventing a cross-project native locator.
 * The bytes originate in the official --fork-session operation and are used only
 * as input to the target cwd's official /fork command.
 */
async function bridgeCopyToTarget(
  sourceCwd: string,
  targetCwd: string,
  ref: NativeSessionRef,
  contents: string,
  environment: NodeJS.ProcessEnv,
  profile: CodeBuddyRuntimeProfile,
) {
  const sourceFile = codeBuddyPrimaryHistoryPath(sourceCwd, ref, environment, profile);
  const targetFile = codeBuddyPrimaryHistoryPath(targetCwd, ref, environment, profile);
  if (sameResolvedPath(sourceFile, targetFile)) return undefined;
  const targetDirectory = path.dirname(targetFile);
  const projectsDirectory = path.dirname(targetDirectory);
  await mkdir(targetDirectory, { recursive: true });
  const [realProjects, realTargetDirectory] = await Promise.all([
    realpath(projectsDirectory),
    realpath(targetDirectory),
  ]);
  if (
    !sameResolvedPath(
      realTargetDirectory,
      path.join(realProjects, codeBuddyProjectSlug(targetCwd, profile)),
    )
  )
    throw new CodeBuddyError(
      "invalidRequest",
      "Cross-directory history bridge target escaped the native projects root",
    );
  const expected = Buffer.from(contents, "utf8");
  await writeFile(targetFile, expected, { flag: "wx", mode: 0o600 });
  const bridge = { file: targetFile, expected };
  try {
    const persisted = await readFile(targetFile);
    if (!isDeepStrictEqual(persisted, expected))
      throw new CodeBuddyError(
        "nativeFailure",
        "Cross-directory history bridge changed native bytes",
      );
    return bridge;
  } catch (error) {
    return failAfterBridgeCleanup(error, bridge);
  }
}

async function cleanupBridge(bridge: OwnedCopy | undefined) {
  if (!bridge) return;
  try {
    const info = await lstat(bridge.file);
    if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) return;
    if (!isDeepStrictEqual(await readFile(bridge.file), bridge.expected)) return;
    await unlink(bridge.file);
  } catch (error) {
    if (record(error).code !== "ENOENT") throw error;
  }
}

async function failAfterBridgeCleanup(
  failure: unknown,
  bridge: OwnedCopy | undefined,
): Promise<never> {
  try {
    await cleanupBridge(bridge);
  } catch (cleanupFailure) {
    throw new AggregateError(
      [failure, cleanupFailure],
      "Native derivation and bridge cleanup both failed",
    );
  }
  throw failure;
}

interface ChildRange {
  afterId?: string;
  lastId: string;
}

interface ReferencedChild {
  childId: string;
  ranges: ChildRange[];
}

function argumentsRecord(value: unknown) {
  if (typeof value !== "string") return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}

/** Agent call/result correlation is native callId-based; parentId adjacency is not stable. */
function referencedChildren(rows: Row[]): ReferencedChild[] {
  const calls = new Map<string, string | undefined>();
  const children = new Map<string, ReferencedChild>();
  for (const row of rows) {
    if (row.type === "function_call" && row.name === "Agent") {
      const callId = text(row.callId);
      if (!callId || calls.has(callId))
        throw new CodeBuddyError("protocolError", "Agent delegation identity is ambiguous");
      const resumed = text(argumentsRecord(row.arguments).resume);
      if (resumed && !validCodeBuddyChildId(resumed))
        throw new CodeBuddyError("protocolError", "Agent delegation has an invalid child identity");
      calls.set(callId, resumed || undefined);
      continue;
    }
    if (row.type !== "function_call_result") continue;
    const callId = text(row.callId);
    if (!calls.has(callId)) continue;
    const subagent = record(record(record(row.providerData).toolResult).subAgent);
    const childId = text(subagent.sessionId);
    if (!validCodeBuddyChildId(childId))
      throw new CodeBuddyError(
        "unsupported",
        "Retained Agent result has no verified native child identity",
      );
    const resumed = calls.get(callId);
    if (resumed && resumed !== childId)
      throw new CodeBuddyError("protocolError", "Agent result changed its child identity");
    const lastId = text(subagent.lastId);
    const afterId = text(subagent.afterId);
    if (!lastId)
      throw new CodeBuddyError(
        "unsupported",
        "Retained Agent result has no bounded child transcript range",
      );
    const child = children.get(childId) ?? { childId, ranges: [] };
    child.ranges.push({ ...(afterId ? { afterId } : {}), lastId });
    children.set(childId, child);
    if (children.size > 256)
      throw new CodeBuddyError("unsupported", "Too many retained Subagent transcripts");
    calls.delete(callId);
  }
  if (calls.size)
    throw new CodeBuddyError("unsupported", "Retained Agent delegation is incomplete");
  return [...children.values()];
}

function assertChildRanges(rows: Row[], child: ReferencedChild) {
  const positions = new Map<string, number[]>();
  for (const [index, row] of rows.entries()) {
    const id = text(row.id);
    if (!id) continue;
    const matches = positions.get(id) ?? [];
    matches.push(index);
    positions.set(id, matches);
  }
  let previous = -1;
  for (const range of child.ranges) {
    const last = positions.get(range.lastId);
    const after = range.afterId ? positions.get(range.afterId) : undefined;
    if (
      last?.length !== 1 ||
      (after && after.length !== 1) ||
      (range.afterId && !after) ||
      (after && (after[0] ?? -1) >= (last[0] ?? -1)) ||
      (last[0] ?? -1) < previous
    )
      throw new CodeBuddyError("protocolError", "Agent result child range is inconsistent");
    previous = last[0] ?? -1;
  }
}

async function plainDirectory(parent: string, name: string) {
  const directory = path.join(parent, name);
  await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (record(error).code !== "EEXIST") throw error;
  });
  const info = await lstat(directory);
  // Windows isolation relies on native ACLs, not the synthesized POSIX mode bits.
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && (info.mode & 0o022) !== 0)
  )
    throw new CodeBuddyError("invalidRequest", "Redirected native Subagent directory");
  const actual = await realpath(directory);
  if (!sameResolvedPath(actual, directory))
    throw new CodeBuddyError("invalidRequest", "Redirected native Subagent directory");
  return directory;
}

async function verifiedChildFile(file: string, expected: Buffer) {
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    throw new CodeBuddyError("invalidRequest", "Unsafe derived Subagent transcript");
  if (!sameResolvedPath(await realpath(file), file))
    throw new CodeBuddyError("invalidRequest", "Redirected derived Subagent transcript");
  const before = await codeBuddyFileVersion(file);
  const actual = await readCodeBuddyVersionedText(
    file,
    CODEBUDDY_CHILD_MAX_BYTES,
    "Subagent transcript exceeds 8 MB",
    before,
  );
  if (
    !actual.reusableVersion ||
    !sameCodeBuddyFileVersion(before, actual.reusableVersion) ||
    !isDeepStrictEqual(Buffer.from(actual.contents, "utf8"), expected)
  )
    throw new CodeBuddyError(
      "nativeFailure",
      "Native Fork produced a different Subagent transcript",
    );
}

async function persistChildCopy(file: string, expected: Buffer): Promise<OwnedCopy | undefined> {
  try {
    await writeFile(file, expected, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (record(error).code !== "EEXIST") throw error;
    await verifiedChildFile(file, expected);
    return undefined;
  }
  const copy = { file, expected };
  try {
    await verifiedChildFile(file, expected);
    return copy;
  } catch (error) {
    return failAfterBridgeCleanup(error, copy);
  }
}

async function copyInheritedChildren(options: {
  references: ReferencedChild[];
  sourceRef: NativeSessionRef;
  sourceCwd: string;
  sourceHistoryFile: string;
  targetRef: NativeSessionRef;
  targetHistoryFile: string;
}) {
  const { references } = options;
  if (!references.length)
    return { descriptors: [] as CodeBuddyInheritedChild[], created: [] as OwnedCopy[] };

  const sourceHistoryFile = await realpath(options.sourceHistoryFile);
  const sourceProject = path.dirname(sourceHistoryFile);
  if (
    !sameResolvedPath(
      sourceHistoryFile,
      path.join(sourceProject, `${options.sourceRef.nativeSessionId}.jsonl`),
    )
  )
    throw new CodeBuddyError("invalidRequest", "Unexpected source history location");
  const sourceDirectory = path.join(sourceProject, options.sourceRef.nativeSessionId, "subagents");
  const sourceDirectoryInfo = await lstat(sourceDirectory);
  if (!sourceDirectoryInfo.isDirectory() || sourceDirectoryInfo.isSymbolicLink())
    throw new CodeBuddyError("invalidRequest", "Redirected source Subagent directory");
  if (!sameResolvedPath(await realpath(sourceDirectory), sourceDirectory))
    throw new CodeBuddyError("invalidRequest", "Redirected source Subagent directory");

  const targetHistoryFile = await realpath(options.targetHistoryFile);
  const targetProject = path.dirname(targetHistoryFile);
  if (
    !sameResolvedPath(
      targetHistoryFile,
      path.join(targetProject, `${options.targetRef.nativeSessionId}.jsonl`),
    )
  )
    throw new CodeBuddyError("invalidRequest", "Unexpected target history location");
  const targetSessionDirectory = await plainDirectory(
    targetProject,
    options.targetRef.nativeSessionId,
  );
  const targetDirectory = await plainDirectory(targetSessionDirectory, "subagents");

  const descriptors: CodeBuddyInheritedChild[] = [];
  const created: OwnedCopy[] = [];
  try {
    for (const reference of references) {
      const sourceFile = path.join(sourceDirectory, `${reference.childId}.jsonl`);
      const sourceInfo = await lstat(sourceFile);
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink())
        throw new CodeBuddyError("invalidRequest", "Redirected source Subagent transcript");
      const before = await codeBuddyFileVersion(sourceFile);
      if (!sameResolvedPath(before.realFile, sourceFile))
        throw new CodeBuddyError("invalidRequest", "Redirected source Subagent transcript");
      if (before.size > CODEBUDDY_CHILD_MAX_BYTES)
        throw new CodeBuddyError("unsupported", "Subagent transcript exceeds 8 MB");
      const source = await readCodeBuddyVersionedText(
        sourceFile,
        CODEBUDDY_CHILD_MAX_BYTES,
        "Subagent transcript exceeds 8 MB",
        before,
      );
      if (!source.reusableVersion)
        throw new CodeBuddyError("sessionBusy", "Source Subagent changed during Fork");
      const validated = await validateCodeBuddyChildContents(
        source.contents,
        options.sourceRef,
        reference.childId,
        options.sourceCwd,
        false,
      );
      assertChildRanges(validated.entries, reference);
      const last = reference.ranges.at(-1)?.lastId;
      if (!last) throw new CodeBuddyError("protocolError", "Missing Agent result child range");
      const prefix = await codeBuddyChildPrefixThrough(source.contents, last, validated);
      const expected = Buffer.from(prefix.contents, "utf8");
      const targetFile = path.join(targetDirectory, `${reference.childId}.jsonl`);
      const copy = await persistChildCopy(targetFile, expected);
      if (copy) created.push(copy);

      const after = await readCodeBuddyVersionedText(
        sourceFile,
        CODEBUDDY_CHILD_MAX_BYTES,
        "Subagent transcript exceeds 8 MB",
        before,
      );
      if (
        !after.reusableVersion ||
        !sameCodeBuddyFileVersion(before, after.reusableVersion) ||
        after.contents !== source.contents
      )
        throw new CodeBuddyError("sessionBusy", "Source Subagent changed during Fork");
      descriptors.push(
        codeBuddyInheritedChildDescriptor(reference.childId, prefix.contents, prefix.child),
      );
    }
    return { descriptors, created };
  } catch (failure) {
    const cleanupFailures: unknown[] = [];
    for (const copy of created.toReversed()) {
      try {
        await cleanupBridge(copy);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (cleanupFailures.length)
      throw new AggregateError(
        [failure, ...cleanupFailures],
        "Subagent copy and cleanup both failed",
      );
    throw failure;
  }
}

/** Keep the print-copy runtime identity away from model work and subagents. */
export async function deriveCodeBuddySession(
  options: DerivationOptions,
): Promise<ResumeSessionInput> {
  const { input, environment, factory, signal } = options;
  const sourceCwd = options.sourceCwd ?? input.cwd;
  const profile = options.profile ?? CODEBUDDY_RUNTIME_PROFILE;
  const strictHistoryBinding = profile.historyCapabilities?.forkAcrossCwd === true;
  validateNativeRef(input.sourceRef, profile);
  const source = await codeBuddyNativeHistory(sourceCwd, input.sourceRef, environment, profile);
  const retained = retainedRowCount(input, source.contents, sourceCwd, profile);
  const sourceRows = nativeHistoryRows(source.contents);
  const childReferences = referencedChildren(sourceRows.slice(0, retained));
  const temporary = nativeSessionRefSchema.parse({
    harnessId: profile.harnessId,
    nativeSessionId: randomUUID(),
    formatVersion: 1,
  });
  await (options.copy ?? copyCodeBuddySession)(
    sourceCwd,
    input.sourceRef.nativeSessionId,
    temporary.nativeSessionId,
    environment,
    signal,
    options.invocationFactory ?? codeBuddyInvocation,
  );
  const nativeCopy = await codeBuddyNativeHistory(sourceCwd, temporary, environment, profile, {
    ...(strictHistoryBinding ? { requirePrimary: true as const } : {}),
    inheritedContents: source.contents,
  });
  if (!isDeepStrictEqual(nativeHistoryRows(nativeCopy.contents), sourceRows))
    throw new CodeBuddyError("unsupported", "Native history copy changed the source prefix");
  const bridge = strictHistoryBinding
    ? await bridgeCopyToTarget(
        sourceCwd,
        input.cwd,
        temporary,
        nativeCopy.contents,
        environment,
        profile,
      )
    : undefined;
  if (strictHistoryBinding) {
    let targetCopy;
    try {
      targetCopy = await codeBuddyNativeHistory(input.cwd, temporary, environment, profile, {
        requirePrimary: true,
        inheritedContents: nativeCopy.contents,
      });
    } catch (error) {
      return failAfterBridgeCleanup(error, bridge);
    }
    if (targetCopy.contents !== nativeCopy.contents) {
      return failAfterBridgeCleanup(
        new CodeBuddyError("nativeFailure", "Cross-directory history bridge changed native bytes"),
        bridge,
      );
    }
  }

  let derivedId: string | undefined;
  let failure: unknown;
  let inheritedChildCopies: OwnedCopy[] = [];
  let derivationSucceeded = false;
  let receiveCommands!: (commands: unknown) => void;
  const commands = new Promise<unknown>((resolve) => {
    receiveCommands = resolve;
  });
  let client;
  try {
    client = factory({
      cwd: input.cwd,
      environment,
      ephemeral: false,
      temporarySessionId: temporary.nativeSessionId,
      handlers: {
        permission: async () => ({ outcome: { outcome: "cancelled" } }),
        question: async () => ({ outcome: "cancelled" }),
        fault: (error) => {
          failure = error;
        },
        update: ({ sessionId, update }) => {
          if (record(update).sessionUpdate === "available_commands_update")
            receiveCommands(record(update).availableCommands);
          const meta = record(record(update)._meta);
          if (
            meta["codebuddy.ai/sessionReset"] === true &&
            meta["codebuddy.ai/newSessionId"] === sessionId
          )
            derivedId = sessionId;
        },
      },
    });
  } catch (error) {
    return failAfterBridgeCleanup(error, bridge);
  }
  const abort = () => {
    void client.close();
  };
  signal.addEventListener("abort", abort, { once: true });
  let primaryFailure: unknown;
  try {
    if (!client.removeCopy)
      throw new CodeBuddyError("unsupported", "Native temporary Session cleanup is unavailable");
    if (signal.aborted) throw new CodeBuddyError("invalidState", "Adapter closed during Fork");
    await client.initialize();
    const opened = await client.open(input.cwd, temporary.nativeSessionId);
    if (opened.sessionId && opened.sessionId !== temporary.nativeSessionId)
      throw new CodeBuddyError("protocolError", "ACP loaded a different temporary Session");
    const nativeState = configuration(opened.configOptions, profile, { cwd: input.cwd, environment }).state;
    const available = await bounded(commands, 5_000, "Native command discovery", abort);
    if (!Array.isArray(available) || !available.some((entry) => record(entry).name === "fork"))
      throw new CodeBuddyError("unsupported", "Native Session does not advertise /fork");
    const result = await bounded(
      client.prompt(temporary.nativeSessionId, "/fork"),
      20_000,
      "Native Fork",
      abort,
    );
    if (failure) throw failure;
    if (
      result.stopReason !== "end_turn" ||
      !derivedId ||
      [input.sourceRef.nativeSessionId, temporary.nativeSessionId].includes(derivedId)
    )
      throw new CodeBuddyError("unsupported", "Native Fork did not report a separate Session");
    const preliminaryRef = nativeSessionRefSchema.parse({
      harnessId: profile.harnessId,
      nativeSessionId: derivedId,
      formatVersion: 1,
    });
    const historicalCwds = [
      ...new Set([
        ...sourceRows.flatMap((row) => (typeof row.cwd === "string" ? [row.cwd] : [])),
        ...source.historicalCwds,
        sourceCwd,
        input.cwd,
      ]),
    ];
    const historyTransaction = strictHistoryBinding
      ? ({ requirePrimary: true, allowedHistoricalCwds: historicalCwds } as const)
      : undefined;
    const forked = await codeBuddyNativeHistory(
      input.cwd,
      preliminaryRef,
      environment,
      profile,
      historyTransaction,
    );
    const forkRows = nativeHistoryRows(forked.contents);
    assertCopiedPrefix(sourceRows, forkRows);
    const marker = strictHistoryBinding
      ? nativeRawHistoryRows(forked.contents).findLast(
          (row) =>
            Boolean(text(row.id)) &&
            row.sessionId === derivedId &&
            typeof row.cwd === "string" &&
            sameResolvedPath(row.cwd, input.cwd),
        )
      : undefined;
    if (strictHistoryBinding && !marker)
      throw new CodeBuddyError(
        "unsupported",
        "Native Fork did not persist a target binding marker",
      );
    if (!client.rollback)
      throw new CodeBuddyError("unsupported", "Native history rewind is unavailable");
    const point = retained ? text(forkRows[retained - 1]?.id) : null;
    const rewound = await client.rollback(derivedId, point);
    if (rewound.applied !== true || (rewound.actualForkPointId ?? null) !== point)
      throw new CodeBuddyError("nativeFailure", "Native history rewind was not confirmed");
    const verified = await codeBuddyNativeHistory(
      input.cwd,
      preliminaryRef,
      environment,
      profile,
      historyTransaction,
    );
    const finalRows = nativeHistoryRows(verified.contents);
    if (!isDeepStrictEqual(finalRows, forkRows.slice(0, retained)))
      throw new CodeBuddyError(
        "nativeFailure",
        "Native history rewind did not persist the exact prefix",
      );
    const inheritedChildren = await copyInheritedChildren({
      references: childReferences,
      sourceRef: input.sourceRef,
      sourceCwd,
      sourceHistoryFile: source.file,
      targetRef: preliminaryRef,
      targetHistoryFile: verified.file,
    });
    inheritedChildCopies = inheritedChildren.created;
    const inheritedChildLocator = inheritedChildren.descriptors.length
      ? { codebuddyInheritedChildren: inheritedChildren.descriptors }
      : {};
    const ref = nativeSessionRefSchema.parse({
      ...preliminaryRef,
      locator: strictHistoryBinding
        ? {
            codebuddyDerived: 1,
            boundCwd: codeBuddyCanonicalCwd(input.cwd),
            targetProjectSlug: codeBuddyProjectSlug(input.cwd, profile),
            inheritedPrefixRows: finalRows.length,
            inheritedPrefixSha256: nativeRowsDigest(finalRows),
            bindingMarkerId: text(marker?.id),
            ...inheritedChildLocator,
          }
        : { codebuddyDerived: 1, ...inheritedChildLocator },
    });
    await codeBuddyNativeHistory(input.cwd, ref, environment, profile);
    const after = await codeBuddyNativeHistory(sourceCwd, input.sourceRef, environment, profile);
    if (after.contents !== source.contents)
      throw new CodeBuddyError("sessionBusy", "Source history changed during Fork");
    if (signal.aborted) throw new CodeBuddyError("invalidState", "Adapter closed during Fork");
    const saved = record(record(input.sourceRef.locator).configuration);
    const state = options.state ?? {
      ...nativeState,
      ...(text(saved.model) ? { effectiveModel: modelRef(text(saved.model)) } : {}),
    };
    const model =
      input.kind === "rollbackLastTurn" && input.model ? input.model : state.effectiveModel;
    const thinking =
      input.kind === "rollbackLastTurn" && input.thinkingOptionId
        ? input.thinkingOptionId
        : (options.state?.effectiveThinkingOptionId ??
          (text(saved.thinking)
            ? harnessThinkingOptionIdSchema.parse(saved.thinking)
            : state.effectiveThinkingOptionId));
    const mode =
      input.kind === "rollbackLastTurn" && input.permissionModeId
        ? input.permissionModeId
        : (options.state?.effectivePermissionModeId ??
          (text(saved.mode)
            ? harnessPermissionModeIdSchema.parse(saved.mode)
            : state.effectivePermissionModeId));
    const resume: ResumeSessionInput = {
      kind: "resume",
      nativeRef: ref,
      cwd: input.cwd,
      ...(input.environment ? { environment: input.environment } : {}),
      ...(model ? { model } : {}),
      ...(thinking ? { thinkingOptionId: thinking } : {}),
      ...(mode ? { permissionModeId: mode } : {}),
    };
    derivationSucceeded = true;
    return resume;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    const cleanupFailures: unknown[] = [];
    let temporaryCleanupFailed = false;
    try {
      if (client.removeCopy) await client.removeCopy();
    } catch (error) {
      temporaryCleanupFailed = true;
      cleanupFailures.push(error);
    }
    try {
      await client.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await cleanupBridge(bridge);
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (!derivationSucceeded || cleanupFailures.length) {
      for (const copy of inheritedChildCopies.toReversed()) {
        try {
          await cleanupBridge(copy);
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
    }
    if (cleanupFailures.length) {
      if (primaryFailure)
        throw new AggregateError(
          [primaryFailure, ...cleanupFailures],
          `${primaryFailure instanceof Error ? primaryFailure.message : "Native derivation failed"}; ${
            temporaryCleanupFailed
              ? `temporary Session ${temporary.nativeSessionId} could not be removed`
              : "native derivation cleanup also failed"
          }`,
        );
      if (cleanupFailures.length === 1) throw cleanupFailures[0];
      throw new AggregateError(cleanupFailures, "Native derivation cleanup failed");
    }
    // The native HTTP endpoint exits with this same administrative ACP process.
  }
}
