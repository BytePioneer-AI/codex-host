import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { HostSubagentStatus, HostThreadSnapshot } from "@codexhost/harness-adapter";
import type { NativeSessionRef } from "@codexhost/shared-contracts";
import { CodeBuddyError, record, text } from "./common.js";
import { codeBuddyNativeHistory, snapshotFromHistory } from "./history.js";
import { validCodeBuddyChildId } from "./subagent-tool.js";

const equalPath = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

async function childDirectory(
  parent: NativeSessionRef,
  cwd: string,
  environment: NodeJS.ProcessEnv,
) {
  const history = await codeBuddyNativeHistory(cwd, parent, environment);
  const project = path.dirname(await realpath(history.file));
  const expected = path.join(project, parent.nativeSessionId, "subagents");
  const actual = await realpath(expected);
  if (!equalPath(actual, expected))
    throw new CodeBuddyError("invalidRequest", "Redirected CodeBuddy Subagent directory");
  return actual;
}

/** Only a trailing in-flight JSON line may be skipped. No model-controlled log paths. */
async function childContents(directory: string, childId: string) {
  if (!validCodeBuddyChildId(childId))
    throw new CodeBuddyError("invalidRequest", "Invalid native Subagent ID");
  const file = path.join(directory, `${childId}.jsonl`);
  if (!equalPath(await realpath(file), file))
    throw new CodeBuddyError("invalidRequest", "Redirected Subagent transcript");
  if ((await stat(file)).size > 8_000_000)
    throw new CodeBuddyError("unsupported", "Subagent transcript exceeds 8 MB");
  const contents = await readFile(file, "utf8"),
    lines = contents.split(/\r?\n/u);
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

export async function locateCodeBuddyChild(
  parent: NativeSessionRef,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  requestId: string,
): Promise<string | undefined> {
  if (!requestId) return undefined;
  const directory = await childDirectory(parent, cwd, environment);
  const files = (await readdir(directory, { withFileTypes: true })).filter(
    (entry) => entry.isFile() && /^agent-[\w-]+\.jsonl$/u.test(entry.name),
  );
  if (files.length > 256)
    throw new CodeBuddyError("unsupported", "Too many native Subagent transcripts");
  const matches: string[] = [];
  for (const file of files) {
    const id = file.name.slice(0, -6),
      data = await childContents(directory, id);
    const first = data.entries.find((row) => row.type === "message" && row.role === "user");
    if (record(first?.providerData).conversationRequestId === requestId) matches.push(id);
  }
  if (matches.length > 1)
    throw new CodeBuddyError("protocolError", "Ambiguous native Subagent correlation");
  return matches[0];
}

export async function readCodeBuddyChild(
  parent: NativeSessionRef,
  childId: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  status?: HostSubagentStatus,
): Promise<HostThreadSnapshot> {
  if (!status) {
    const source = await codeBuddyNativeHistory(cwd, parent, environment);
    const states = snapshotFromHistory(source.contents, parent, cwd).turns.flatMap((turn) =>
      turn.items.flatMap(({ item }) => (item.type === "subagentDelegation" ? item.subagents : [])),
    );
    status = states.findLast((child) => child.nativeSubagentId === childId)?.status;
  }
  const data = await childContents(await childDirectory(parent, cwd, environment), childId);
  const sessions = new Set(data.entries.map((row) => text(row.sessionId)).filter(Boolean));
  if (sessions.size !== 1)
    throw new CodeBuddyError("protocolError", "Subagent transcript identity is missing or mixed");
  for (const row of data.entries) {
    if (typeof row.cwd === "string" && !equalPath(await realpath(row.cwd), await realpath(cwd)))
      throw new CodeBuddyError("invalidRequest", "Subagent workspace differs from parent");
  }
  const childSessionId = [...sessions][0];
  if (!childSessionId) throw new CodeBuddyError("protocolError", "Missing native child Session");
  const snapshot = snapshotFromHistory(
    data.contents,
    { ...parent, nativeSessionId: childSessionId },
    cwd,
  );
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
  return snapshot;
}
