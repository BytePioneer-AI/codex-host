import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { HostSubagentStatus, HostThreadSnapshot } from "@codexhost/harness-adapter";
import type { NativeSessionRef } from "@codexhost/shared-contracts";
import { CodeBuddyError, record, text } from "./common.js";
import { codeBuddyLiveNativeHistory, snapshotFromHistory } from "./history.js";
import { validCodeBuddyChildId } from "./subagent-tool.js";
import {
  codeBuddyFileVersion,
  readCodeBuddyVersionedText,
  sameCodeBuddyFileVersion,
  type CodeBuddyFileVersion,
} from "./file-observation.js";

const equalPath = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const MAX_CACHED_CHILDREN = 16;

interface CachedParent {
  file: string;
  version: CodeBuddyFileVersion | undefined;
  contents: string;
  historicalCwds: string[];
}

interface CachedChild {
  version: CodeBuddyFileVersion | undefined;
  contents: string;
  entries: Record<string, unknown>[];
  snapshot?: HostThreadSnapshot;
}

/** Only a trailing in-flight JSON line may be skipped. No model-controlled log paths. */
function childContents(contents: string) {
  const lines = contents.split(/\r?\n/u);
  if (lines.at(-1)?.trim()) {
    try {
      JSON.parse(lines.at(-1) ?? "");
    } catch {
      lines.pop();
    }
  }
  const entries = lines.filter((line) => line.trim()).map((line) => record(JSON.parse(line)));
  return { contents: lines.join("\n"), entries };
}

/** Session-scoped native child reader. Cached bytes never bypass path or ownership validation. */
export class CodeBuddyChildObserver {
  readonly #children = new Map<string, CachedChild>();
  #parent: CachedParent | undefined;
  #closed = false;

  constructor(
    readonly parent: NativeSessionRef,
    readonly cwd: string,
    readonly environment: NodeJS.ProcessEnv,
  ) {}

  close() {
    this.#closed = true;
    this.#children.clear();
    this.#parent = undefined;
  }

  #assertOpen() {
    if (this.#closed) throw new CodeBuddyError("invalidRequest", "Subagent observer is closed");
  }

  async #validateWorkspaces(cwds: string[], child = false) {
    const expected = await realpath(this.cwd);
    for (const cwd of new Set(cwds)) {
      const actual = await realpath(cwd).catch((error) => {
        if (!child && ["ENOENT", "ENOTDIR"].includes(String(record(error).code)))
          throw new CodeBuddyError(
            "invalidRequest",
            "Native Session historical working directory is unavailable; ownership cannot be verified",
          );
        throw error;
      });
      if (!equalPath(actual, expected))
        throw new CodeBuddyError(
          "invalidRequest",
          child
            ? "Subagent workspace differs from parent"
            : "Native Session belongs to a different working directory",
        );
    }
  }

  async #parentHistory() {
    this.#assertOpen();
    if (this.#parent) {
      const current = await codeBuddyFileVersion(this.#parent.file).catch((error) => {
        if (["ENOENT", "ENOTDIR"].includes(String(record(error).code))) return undefined;
        throw error;
      });
      if (sameCodeBuddyFileVersion(current, this.#parent.version)) {
        await this.#validateWorkspaces(this.#parent.historicalCwds);
        this.#assertOpen();
        return this.#parent;
      }
    }
    const history = await codeBuddyLiveNativeHistory(this.cwd, this.parent, this.environment);
    this.#assertOpen();
    this.#parent = {
      file: history.file,
      version: history.reusableVersion,
      contents: history.contents,
      historicalCwds: history.historicalCwds,
    };
    return this.#parent;
  }

  async #directory() {
    const history = await this.#parentHistory();
    const project = path.dirname(await realpath(history.file));
    const expected = path.join(project, this.parent.nativeSessionId, "subagents");
    const actual = await realpath(expected);
    this.#assertOpen();
    if (!equalPath(actual, expected))
      throw new CodeBuddyError("invalidRequest", "Redirected CodeBuddy Subagent directory");
    return actual;
  }

  async #child(directory: string, childId: string) {
    if (!validCodeBuddyChildId(childId))
      throw new CodeBuddyError("invalidRequest", "Invalid native Subagent ID");
    const file = path.join(directory, `${childId}.jsonl`);
    const before = await codeBuddyFileVersion(file);
    if (!equalPath(before.realFile, file))
      throw new CodeBuddyError("invalidRequest", "Redirected Subagent transcript");
    this.#assertOpen();
    if (before.size > 8_000_000)
      throw new CodeBuddyError("unsupported", "Subagent transcript exceeds 8 MB");
    const cached = this.#children.get(childId);
    if (cached && sameCodeBuddyFileVersion(cached.version, before)) return cached;
    const source = await readCodeBuddyVersionedText(
        file,
        8_000_000,
        "Subagent transcript exceeds 8 MB",
        before,
      ),
      data = childContents(source.contents);
    this.#assertOpen();
    const next: CachedChild = {
      ...data,
      version: source.reusableVersion,
    };
    this.#children.delete(childId);
    if (next.version) {
      this.#children.set(childId, next);
      if (this.#children.size > MAX_CACHED_CHILDREN) {
        const oldest = this.#children.keys().next().value;
        if (oldest) this.#children.delete(oldest);
      }
    }
    return next;
  }

  async locate(requestId: string): Promise<string | undefined> {
    if (!requestId) return undefined;
    const directory = await this.#directory();
    const files = (await readdir(directory, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && /^agent-[\w-]+\.jsonl$/u.test(entry.name),
    );
    if (files.length > 256)
      throw new CodeBuddyError("unsupported", "Too many native Subagent transcripts");
    const matches: string[] = [];
    for (const file of files) {
      const id = file.name.slice(0, -6),
        data = await this.#child(directory, id);
      const first = data.entries.find((row) => row.type === "message" && row.role === "user");
      if (record(first?.providerData).conversationRequestId === requestId) matches.push(id);
    }
    if (matches.length > 1)
      throw new CodeBuddyError("protocolError", "Ambiguous native Subagent correlation");
    this.#assertOpen();
    return matches[0];
  }

  async read(childId: string, status?: HostSubagentStatus): Promise<HostThreadSnapshot> {
    if (!status) {
      const source = await this.#parentHistory();
      const states = snapshotFromHistory(source.contents, this.parent, this.cwd).turns.flatMap(
        (turn) =>
          turn.items.flatMap(({ item }) =>
            item.type === "subagentDelegation" ? item.subagents : [],
          ),
      );
      status = states.findLast((child) => child.nativeSubagentId === childId)?.status;
    }
    const data = await this.#child(await this.#directory(), childId);
    const sessions = new Set(data.entries.map((row) => text(row.sessionId)).filter(Boolean));
    if (sessions.size !== 1)
      throw new CodeBuddyError("protocolError", "Subagent transcript identity is missing or mixed");
    await this.#validateWorkspaces(
      data.entries.flatMap((row) => (typeof row.cwd === "string" ? [row.cwd] : [])),
      true,
    );
    this.#assertOpen();
    const childSessionId = [...sessions][0];
    if (!childSessionId) throw new CodeBuddyError("protocolError", "Missing native child Session");
    data.snapshot ??= snapshotFromHistory(
      data.contents,
      { ...this.parent, nativeSessionId: childSessionId },
      this.cwd,
    );
    const snapshot = structuredClone(data.snapshot);
    projectChildSnapshot(snapshot, this.parent, childId, status);
    return snapshot;
  }
}

export async function locateCodeBuddyChild(
  parent: NativeSessionRef,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  requestId: string,
): Promise<string | undefined> {
  const observer = new CodeBuddyChildObserver(parent, cwd, environment);
  try {
    return await observer.locate(requestId);
  } finally {
    observer.close();
  }
}

export async function readCodeBuddyChild(
  parent: NativeSessionRef,
  childId: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  status?: HostSubagentStatus,
): Promise<HostThreadSnapshot> {
  const observer = new CodeBuddyChildObserver(parent, cwd, environment);
  try {
    return await observer.read(childId, status);
  } finally {
    observer.close();
  }
}

function projectChildSnapshot(
  snapshot: HostThreadSnapshot,
  parent: NativeSessionRef,
  childId: string,
  status?: HostSubagentStatus,
) {
  for (const turn of snapshot.turns) {
    turn.nativeTurnRef = {
      ...turn.nativeTurnRef,
      nativeSessionId: parent.nativeSessionId,
      nativeTurnKey: `${childId}:${turn.nativeTurnRef.nativeTurnKey}`,
    };
    turn.items = turn.items.filter(
      ({ outcome }) =>
        !(
          outcome.status === "failed" &&
          outcome.error.message.includes("Tool completion was not recorded")
        ),
    );
    if (!status || status === "running" || status === "pending")
      turn.outcome = { status: "unknown", reason: "Subagent completion has not been confirmed" };
    if (status === "interrupted")
      turn.outcome = { status: "cancelled", reason: "Subagent observation interrupted" };
    if (status === "failed")
      turn.outcome = {
        status: "failed",
        error: { code: "nativeFailure", message: "Subagent failed", retryable: false },
      };
  }
}
