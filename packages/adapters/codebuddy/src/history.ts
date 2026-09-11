import { access, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type {
  HostItemSnapshot,
  HostThreadSnapshot,
  HostTurnSnapshot,
  HostUsage,
} from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  nativeTurnRefSchema,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";
import { CODEBUDDY_ID, CodeBuddyError, record, text } from "./common.js";
import { modelRef } from "./configuration.js";
import { contentText, toolItem, toolOutcome, toolOutput } from "./projection.js";
import { codeBuddyChildId, codeBuddyDelegation } from "./subagent-tool.js";
import { readCodeBuddyVersionedText, type CodeBuddyFileVersion } from "./file-observation.js";

interface CodeBuddyHistorySource {
  file: string;
  contents: string;
  historicalCwds: string[];
  reusableVersion: CodeBuddyFileVersion | undefined;
}

export function validateNativeRef(ref: NativeSessionRef) {
  if (
    ref.harnessId !== CODEBUDDY_ID ||
    ref.formatVersion !== 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u.test(ref.nativeSessionId)
  ) {
    throw new CodeBuddyError("invalidRequest", "Invalid CodeBuddy Native Session identity");
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

export async function codeBuddyNativeHistory(
  cwd: string,
  ref: NativeSessionRef,
  environment: NodeJS.ProcessEnv,
): Promise<CodeBuddyHistorySource> {
  return codeBuddyHistory(cwd, ref, environment, false);
}

/** Live child observation may see one final record before CodeBuddy appends its newline. */
export async function codeBuddyLiveNativeHistory(
  cwd: string,
  ref: NativeSessionRef,
  environment: NodeJS.ProcessEnv,
): Promise<CodeBuddyHistorySource> {
  return codeBuddyHistory(cwd, ref, environment, true);
}

async function codeBuddyHistory(
  cwd: string,
  ref: NativeSessionRef,
  environment: NodeJS.ProcessEnv,
  tolerateIncompleteTail: boolean,
) {
  validateNativeRef(ref);
  const configRoot =
    environment.CODEBUDDY_CONFIG_DIR ||
    path.join(environment.HOME || environment.USERPROFILE || homedir(), ".codebuddy");
  const root = path.join(configRoot, "projects");
  const slug = path
    .resolve(cwd)
    .replace(/[^a-z0-9]/giu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .toLowerCase();
  const primary = path.join(root, slug, `${ref.nativeSessionId}.jsonl`);
  let candidates: string[] = [];
  try {
    await access(primary);
    candidates = [primary];
  } catch (error) {
    if (record(error).code !== "ENOENT") throw error;
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
  const source = await readCodeBuddyVersionedText(
      file,
      64_000_000,
      "Native history exceeds the supported 64 MB snapshot size",
    ),
    parsed = parseJsonl(source.contents, tolerateIncompleteTail);
  const checkedDirectories = new Set<string>();
  for (const row of parsed.rows) {
    if (row.sessionId && row.sessionId !== ref.nativeSessionId)
      throw new CodeBuddyError("protocolError", "Native history has a different Session identity");
    if (typeof row.cwd === "string" && !checkedDirectories.has(row.cwd)) {
      if (!(await sameCwd(row.cwd, cwd)))
        throw new CodeBuddyError(
          "invalidRequest",
          "Native Session belongs to a different working directory",
        );
      checkedDirectories.add(row.cwd);
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
): Promise<string> {
  return (await codeBuddyNativeHistory(cwd, ref, environment)).contents;
}

function parseRows(contents: string, tolerateIncompleteTail = false) {
  return parseJsonl(contents, tolerateIncompleteTail).rows;
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

/** Follow the current native parent chain, not every branch in the append-only file. */
export function nativeHistoryRows(contents: string) {
  const entries = new Map<string, Record<string, unknown>>();
  let leaf = "";
  for (const row of parseRows(contents)) {
    if (!["message", "reasoning", "function_call", "function_call_result"].includes(text(row.type)))
      continue;
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
): HostThreadSnapshot {
  const turns: HostTurnSnapshot[] = [];
  let current: HostTurnSnapshot | undefined;
  const tools = new Map<string, HostItemSnapshot>();
  for (const row of nativeHistoryRows(contents)) {
    if (row.type === "message" && row.role === "user") {
      current = {
        nativeTurnRef: nativeTurnRefSchema.parse({
          harnessId: CODEBUDDY_ID,
          nativeSessionId: ref.nativeSessionId,
          nativeTurnKey: row.id,
          formatVersion: 1,
        }),
        input: [{ type: "text", text: contentText(row.content) }],
        items: [],
        outcome: { status: "unknown", reason: "Native terminal outcome was not recorded" },
        ...(typeof row.timestamp === "number" ? { startedAtMs: row.timestamp } : {}),
      };
      turns.push(current);
      tools.clear();
      continue;
    }
    if (!current) continue;
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
      const snapshot = {
        item:
          row.name === "Agent"
            ? codeBuddyDelegation(text(row.callId), input, "running")
            : toolItem(text(row.callId), text(row.name), input, cwd),
        outcome: toolOutcome("unknown"),
      };
      tools.set(text(row.callId), snapshot);
      current.items.push(snapshot);
      current.outcome = { status: "unknown", reason: "Native Tool has not completed" };
    } else if (row.type === "function_call_result") {
      const snapshot = tools.get(text(row.callId));
      if (!snapshot) throw new CodeBuddyError("protocolError", "Native Tool result has no call");
      snapshot.outcome = toolOutcome(row.status);
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
    }
  }
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
