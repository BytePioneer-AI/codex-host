import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { NativeSessionRef } from "@codexhost/shared-contracts";
import { CodeBuddyError, record, text } from "./common.js";
import { validCodeBuddyChildId } from "./subagent-tool.js";

export const CODEBUDDY_CHILD_MAX_BYTES = 8_000_000;

export interface CodeBuddyInheritedChild {
  childId: string;
  nativeSessionId: string;
  inheritedBytes: number;
  inheritedRows: number;
  inheritedSha256: string;
  recordedCwds: string[];
  historicalCwds: string[];
  workspaceBindings: CodeBuddyChildWorkspaceBinding[];
}

export interface CodeBuddyChildWorkspaceBinding {
  recordedCwd: string;
  canonicalCwd: string;
}

export interface ParsedCodeBuddyChild {
  contents: string;
  entries: Record<string, unknown>[];
}

export interface ValidatedCodeBuddyChild extends ParsedCodeBuddyChild {
  nativeSessionId: string;
  recordedCwds: string[];
  historicalCwds: string[];
  workspaceBindings: CodeBuddyChildWorkspaceBinding[];
}

const equalPath = (left: string, right: string) =>
  process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;

export function codeBuddyChildDigest(contents: string | Buffer) {
  return createHash("sha256").update(contents).digest("hex");
}

/** Only a trailing in-flight JSON line may be skipped by a live observer. */
export function parseCodeBuddyChild(contents: string, tolerateIncompleteTail: boolean) {
  const lines = contents.split(/\r?\n/u);
  if (tolerateIncompleteTail && lines.at(-1)?.trim()) {
    try {
      JSON.parse(lines.at(-1) ?? "");
    } catch {
      lines.pop();
    }
  }
  const entries = lines.filter((line) => line.trim()).map((line) => record(JSON.parse(line)));
  return { contents: lines.join("\n"), entries };
}

function inheritedChildren(parent: NativeSessionRef): CodeBuddyInheritedChild[] {
  const value = record(parent.locator).codebuddyInheritedChildren;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256)
    throw new CodeBuddyError("protocolError", "Inherited Subagent provenance is invalid");
  const seen = new Set<string>();
  return value.map((candidate) => {
    const child = record(candidate);
    const historicalCwds = child.historicalCwds;
    const recordedCwds = child.recordedCwds;
    const workspaceBindings = child.workspaceBindings;
    if (
      !validCodeBuddyChildId(text(child.childId)) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u.test(text(child.nativeSessionId)) ||
      !Number.isSafeInteger(child.inheritedBytes) ||
      Number(child.inheritedBytes) < 0 ||
      Number(child.inheritedBytes) > CODEBUDDY_CHILD_MAX_BYTES ||
      !Number.isSafeInteger(child.inheritedRows) ||
      Number(child.inheritedRows) < 0 ||
      typeof child.inheritedSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(child.inheritedSha256) ||
      !Array.isArray(historicalCwds) ||
      historicalCwds.length > 256 ||
      historicalCwds.some((cwd) => typeof cwd !== "string" || !cwd) ||
      !Array.isArray(recordedCwds) ||
      recordedCwds.length > 256 ||
      recordedCwds.some((cwd) => typeof cwd !== "string" || !cwd) ||
      !Array.isArray(workspaceBindings) ||
      workspaceBindings.length > 256
    )
      throw new CodeBuddyError("protocolError", "Inherited Subagent provenance is invalid");
    const bindings = workspaceBindings.map((candidate) => {
      const binding = record(candidate);
      if (
        typeof binding.recordedCwd !== "string" ||
        !binding.recordedCwd ||
        typeof binding.canonicalCwd !== "string" ||
        !binding.canonicalCwd
      )
        throw new CodeBuddyError("protocolError", "Inherited Subagent provenance is invalid");
      return {
        recordedCwd: binding.recordedCwd,
        canonicalCwd: binding.canonicalCwd,
      };
    });
    const boundRecorded = new Set(bindings.map((binding) => binding.recordedCwd));
    const boundCanonical = new Set(bindings.map((binding) => binding.canonicalCwd));
    if (
      boundRecorded.size !== bindings.length ||
      new Set(recordedCwds).size !== recordedCwds.length ||
      boundRecorded.size !== new Set(recordedCwds).size ||
      recordedCwds.some((cwd) => !boundRecorded.has(cwd)) ||
      new Set(historicalCwds).size !== historicalCwds.length ||
      boundCanonical.size !== new Set(historicalCwds).size ||
      historicalCwds.some((cwd) => !boundCanonical.has(cwd))
    )
      throw new CodeBuddyError("protocolError", "Inherited Subagent provenance is inconsistent");
    const childId = text(child.childId);
    if (seen.has(childId))
      throw new CodeBuddyError("protocolError", "Inherited Subagent provenance is ambiguous");
    seen.add(childId);
    return {
      childId,
      nativeSessionId: text(child.nativeSessionId),
      inheritedBytes: Number(child.inheritedBytes),
      inheritedRows: Number(child.inheritedRows),
      inheritedSha256: child.inheritedSha256,
      recordedCwds: [...recordedCwds],
      historicalCwds: [...historicalCwds],
      workspaceBindings: bindings,
    };
  });
}

export function codeBuddyInheritedChild(
  parent: NativeSessionRef,
  childId: string,
): CodeBuddyInheritedChild | undefined {
  return inheritedChildren(parent).find((child) => child.childId === childId);
}

async function canonicalCwds(cwds: readonly string[]) {
  const result = new Map<string, string>();
  for (const cwd of new Set(cwds)) {
    const canonical = await realpath(cwd).catch((error) => {
      if (["ENOENT", "ENOTDIR"].includes(String(record(error).code)))
        throw new CodeBuddyError(
          "invalidRequest",
          "Subagent historical working directory is unavailable; ownership cannot be verified",
        );
      throw error;
    });
    result.set(cwd, canonical);
  }
  return result;
}

/**
 * Validate a child transcript against its parent provenance. A derived child may
 * retain a byte-pinned historical prefix; every later row belongs to the target cwd.
 */
export async function validateCodeBuddyChildContents(
  contents: string,
  parent: NativeSessionRef,
  childId: string,
  cwd: string,
  tolerateIncompleteTail: boolean,
): Promise<ValidatedCodeBuddyChild> {
  if (!validCodeBuddyChildId(childId))
    throw new CodeBuddyError("invalidRequest", "Invalid native Subagent ID");
  const parsed = parseCodeBuddyChild(contents, tolerateIncompleteTail);
  const sessions = new Set(parsed.entries.map((row) => text(row.sessionId)).filter(Boolean));
  if (sessions.size !== 1)
    throw new CodeBuddyError("protocolError", "Subagent transcript identity is missing or mixed");
  const nativeSessionId = [...sessions][0];
  if (!nativeSessionId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u.test(nativeSessionId))
    throw new CodeBuddyError("protocolError", "Missing or invalid native child Session");

  const inherited = codeBuddyInheritedChild(parent, childId);
  let inheritedEntries: Record<string, unknown>[] = [];
  if (inherited) {
    const bytes = Buffer.from(contents, "utf8");
    if (inherited.inheritedBytes > bytes.length)
      throw new CodeBuddyError("protocolError", "Inherited Subagent prefix is incomplete");
    const prefix = bytes.subarray(0, inherited.inheritedBytes);
    const prefixText = prefix.toString("utf8");
    if (
      !isDeepStrictEqual(Buffer.from(prefixText, "utf8"), prefix) ||
      codeBuddyChildDigest(prefix) !== inherited.inheritedSha256
    )
      throw new CodeBuddyError("protocolError", "Inherited Subagent prefix verification failed");
    let prefixParsed: ParsedCodeBuddyChild;
    try {
      prefixParsed = parseCodeBuddyChild(prefixText, false);
    } catch {
      throw new CodeBuddyError("protocolError", "Inherited Subagent prefix is malformed");
    }
    if (
      prefixParsed.entries.length !== inherited.inheritedRows ||
      parsed.entries.length < inherited.inheritedRows ||
      !isDeepStrictEqual(prefixParsed.entries, parsed.entries.slice(0, inherited.inheritedRows)) ||
      nativeSessionId !== inherited.nativeSessionId
    )
      throw new CodeBuddyError("protocolError", "Inherited Subagent identity changed");
    inheritedEntries = prefixParsed.entries;
  }

  const target = await realpath(cwd);
  const inheritedCwds = inheritedEntries.flatMap((row) =>
    typeof row.cwd === "string" ? [row.cwd] : [],
  );
  const suffixCwds = parsed.entries
    .slice(inheritedEntries.length)
    .flatMap((row) => (typeof row.cwd === "string" ? [row.cwd] : []));
  const canonical = await canonicalCwds(suffixCwds);

  if (inherited) {
    const allowed = new Set(inherited.recordedCwds);
    const observed = new Set(inheritedCwds);
    if (
      allowed.size !== observed.size ||
      [...allowed].some((value) => !observed.has(value)) ||
      inheritedCwds.some((value) => !allowed.has(value))
    )
      throw new CodeBuddyError("invalidRequest", "Inherited Subagent workspace changed");
  }
  for (const value of suffixCwds) {
    const actual = canonical.get(value);
    if (!actual || !equalPath(actual, target))
      throw new CodeBuddyError("invalidRequest", "Subagent workspace differs from parent");
  }

  const bindings = new Map(
    (inherited?.workspaceBindings ?? []).map((binding) => [
      binding.recordedCwd,
      binding.canonicalCwd,
    ]),
  );
  for (const value of new Set(suffixCwds)) {
    const resolved = canonical.get(value);
    if (!resolved) throw new CodeBuddyError("invalidRequest", "Subagent workspace is unavailable");
    const existing = bindings.get(value);
    if (existing && !equalPath(existing, resolved))
      throw new CodeBuddyError("invalidRequest", "Subagent workspace binding changed");
    bindings.set(value, resolved);
  }

  return {
    ...parsed,
    nativeSessionId,
    recordedCwds: [...bindings.keys()],
    historicalCwds: [...new Set(bindings.values())],
    workspaceBindings: [...bindings].map(([recordedCwd, canonicalCwd]) => ({
      recordedCwd,
      canonicalCwd,
    })),
  };
}

export function codeBuddyInheritedChildDescriptor(
  childId: string,
  contents: string,
  child: ValidatedCodeBuddyChild,
): CodeBuddyInheritedChild {
  if (child.recordedCwds.length > 256 || child.historicalCwds.length > 256)
    throw new CodeBuddyError("unsupported", "Too many Subagent historical workspaces");
  return {
    childId,
    nativeSessionId: child.nativeSessionId,
    inheritedBytes: Buffer.byteLength(contents, "utf8"),
    inheritedRows: child.entries.length,
    inheritedSha256: codeBuddyChildDigest(contents),
    recordedCwds: child.recordedCwds,
    historicalCwds: child.historicalCwds,
    workspaceBindings: child.workspaceBindings,
  };
}

/** Retain exactly the child range named by the native Agent result (lastId is inclusive). */
export async function codeBuddyChildPrefixThrough(
  contents: string,
  lastId: string,
  child: ValidatedCodeBuddyChild,
): Promise<{ contents: string; child: ValidatedCodeBuddyChild }> {
  let cursor = 0;
  let rowIndex = 0;
  let match = -1;
  let end = -1;
  while (cursor < contents.length) {
    const newline = contents.indexOf("\n", cursor);
    const next = newline < 0 ? contents.length : newline + 1;
    const physicalLine = contents.slice(cursor, next);
    const line = physicalLine.replace(/\r?\n$/u, "");
    if (line.trim()) {
      const row = child.entries[rowIndex++];
      if (!row) throw new CodeBuddyError("protocolError", "Subagent transcript rows changed");
      if (text(row.id) === lastId) {
        if (match >= 0)
          throw new CodeBuddyError("protocolError", "Agent result has an ambiguous child range");
        match = rowIndex - 1;
        end = next;
      }
    }
    cursor = next;
  }
  if (rowIndex !== child.entries.length || match < 0 || end < 0)
    throw new CodeBuddyError("protocolError", "Agent result child range was not found");
  const entries = child.entries.slice(0, match + 1);
  const cwdValues = entries.flatMap((row) => (typeof row.cwd === "string" ? [row.cwd] : []));
  const inheritedBindings = new Map(
    child.workspaceBindings.map((binding) => [binding.recordedCwd, binding.canonicalCwd]),
  );
  const bindings = [...new Set(cwdValues)].map((recordedCwd) => {
    const canonicalCwd = inheritedBindings.get(recordedCwd);
    if (!canonicalCwd)
      throw new CodeBuddyError("protocolError", "Subagent workspace binding is missing");
    return { recordedCwd, canonicalCwd };
  });
  return {
    contents: contents.slice(0, end),
    child: {
      contents: contents.slice(0, end),
      entries,
      nativeSessionId: child.nativeSessionId,
      recordedCwds: bindings.map((binding) => binding.recordedCwd),
      historicalCwds: [...new Set(bindings.map((binding) => binding.canonicalCwd))],
      workspaceBindings: bindings,
    },
  };
}
