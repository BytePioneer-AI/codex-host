import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import type {
  HarnessUsageEntry,
  HarnessUsageSource,
  HarnessUsageStatisticsCapability,
} from "@codexhost/harness-adapter";
import {
  jsonlRecords,
  nativeTimeMs,
  parseHarnessUsageEntry,
  usageSessionTitle,
  withUsageSession,
} from "@codexhost/harness-adapter/usage-statistics";
import { CodexCounters, object, usage } from "./counters.js";
import { copyRelation, rolloutLines } from "./rollout-io.js";

const ROLLOUT =
  /^rollout-.*?([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:[_-][0-9a-f-]+)?\.jsonl(?:\.zst)?$/iu;
interface SourceFile {
  file: string;
  fingerprint: string;
}
const text = (value: unknown): string => (typeof value === "string" ? value : "");
async function stamp(file: string): Promise<string> {
  const s = await lstat(file, { bigint: true });
  if (!s.isFile()) throw new Error("Codex rollout is not a regular file");
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
}
function fingerprint(files: readonly SourceFile[], extra = ""): string {
  return createHash("sha256").update(JSON.stringify(files)).update(extra).digest("hex");
}

/** Words the user typed, skipping Codex's own environment / AGENTS.md / instruction dumps. */
function typedPrompt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.startsWith("<") || text.startsWith("# AGENTS.md") || text.startsWith("<!--")) {
    return undefined;
  }
  return usageSessionTitle(text);
}

function userItemPrompt(payload: Record<string, unknown> | null): string | undefined {
  if (!payload || payload.type !== "message" || payload.role !== "user") return undefined;
  if (!Array.isArray(payload.content)) return typedPrompt(payload.content);
  for (const part of payload.content) {
    if (typeof part !== "object" || part === null) continue;
    const block = part as Record<string, unknown>;
    if (block.type === "input_text" || block.type === "text") {
      const prompt = typedPrompt(block.text);
      if (prompt) return prompt;
    }
  }
  return undefined;
}

async function readThreadNames(home: string, signal: AbortSignal): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    for await (const line of jsonlRecords(
      path.join(home, "session_index.jsonl"),
      '"thread_name"',
      signal,
    )) {
      const id = text(line.id);
      const name = usageSessionTitle(line.thread_name);
      if (id && name) names.set(id, name);
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return names;
}

export interface SessionReadOptions {
  sessionId?: string;
  onTokenCount?: (info: unknown) => void;
  onIncomplete?: () => void;
}

/** Shared by the plugin and fixture tests; a thread can continue across several rollout files. */
export async function readCodexRollouts(
  files: readonly string[],
  thread: string,
  signal: AbortSignal,
  options: SessionReadOptions = {},
): Promise<HarnessUsageEntry[]> {
  const counters = new CodexCounters();
  let model = "",
    cwd = "",
    // Codex writes a turn_context before every turn's model calls. Usage seen before the first one
    // is history a spawned subagent replays from its parent at creation, stamped with that time.
    ownFrom: number | null = null,
    firstMeta = false,
    forkAt = 0,
    seen = 0,
    firstPrompt: string | undefined;
  for (const file of files) {
    for await (const line of rolloutLines(file, signal)) {
      signal.throwIfAborted();
      if (++seen % 128 === 0) await yieldToEventLoop(undefined, { signal });
      const kind = /"type"\s*:\s*"([^"]+)"/u.exec(line.slice(0, 1024))?.[1];
      if (!kind && line.trim()) options.onIncomplete?.();
      if (
        !kind ||
        ![
          "session_meta",
          "turn_context",
          "token_usage_record",
          "compacted",
          "event_msg",
          "response_item",
        ].includes(kind)
      )
        continue;
      // Avoid decoding large tool outputs or conversation bodies which cannot contain usage.
      if (kind === "response_item" && !/"role"\s*:\s*"user"/u.test(line.slice(0, 1024))) continue;
      if (
        kind === "event_msg" &&
        !/"type"\s*:\s*"(?:token_count|task_started|thread_settings_applied|user_message)"/u.test(
          line.slice(0, 1024),
        )
      )
        continue;
      let row: Record<string, unknown> | null;
      try {
        row = object(JSON.parse(line));
      } catch {
        options.onIncomplete?.();
        continue;
      } // a writer may leave a partial tail
      const p = object(row?.payload);
      const at = nativeTimeMs(row?.timestamp);
      if (!row || !p || at === null) {
        options.onIncomplete?.();
        continue;
      }
      switch (row.type) {
        case "session_meta": {
          if (!firstMeta) {
            if (text(p.id) !== thread)
              throw new Error("Codex rollout identity does not match its source");
            if (p.forked_from_id || p.parent_thread_id || p.subagent_history_start_ordinal) {
              forkAt = nativeTimeMs(p.timestamp) ?? at;
              // Global attribution excludes inherited requests. Until a complete session-view
              // replay exists, do not advertise these own-only records as the whole session.
              options.onIncomplete?.();
            }
            cwd = text(p.cwd);
            firstMeta = true;
          }
          counters.context(text(p.session_id) || text(p.id), "", "");
          counters.snapshot(at, text(p.id), p);
          break;
        }
        case "turn_context":
          ownFrom ??= counters.entries.length;
          model = text(p.model) || model;
          counters.context("", text(p.turn_id), model);
          break;
        case "token_usage_record":
          if (!usage(p.usage) || !text(p.response_id)) options.onIncomplete?.();
          counters.record(at, model, p);
          break;
        case "compacted": {
          const record = object(p.latest_token_usage_record);
          if (
            record &&
            p.compaction_response_id &&
            record.response_id === p.compaction_response_id
          ) {
            if (!usage(record.usage)) options.onIncomplete?.();
            counters.record(at, model, record, true);
          }
          break;
        }
        case "response_item":
          counters.boundary();
          firstPrompt ??= userItemPrompt(p);
          break;
        case "event_msg":
          if (p.type === "task_started") {
            counters.context("", text(p.turn_id), "");
            counters.boundary();
          }
          if (p.type === "user_message") {
            counters.boundary();
            firstPrompt ??= typedPrompt(p.message);
          }
          if (p.type === "thread_settings_applied") {
            model = text(object(p.thread_settings)?.model) || model;
            counters.context("", "", model);
          }
          if (p.type === "token_count") {
            const info = object(p.info);
            options.onTokenCount?.(info);
            if (info && !usage(info.total_token_usage)) options.onIncomplete?.();
            if (info)
              counters.count(
                at,
                model,
                usage(info.total_token_usage),
                usage(info.last_token_usage),
              );
          }
          break;
      }
    }
  }
  if (!firstMeta) throw new Error("Codex rollout has no valid session metadata");
  return counters.entries.flatMap((v, index) => {
    // Replayed history still feeds the counters above, so later deltas stay right; it is not
    // a request of this thread. A rollout without any turn_context (older formats) keeps all.
    if (ownFrom !== null && index < ownFrom) return [];
    // Explicit ownership survives copied histories. Legacy copies keep times before fork creation.
    if ((v.thread && v.thread !== thread) || (!v.thread && forkAt && v.at < forkAt)) return [];
    const [input, output, cached, written, reasoning] = v.usage.values;
    const id = v.response
      ? `${v.session}:${v.response}`
      : `legacy:${createHash("sha256")
          .update(
            JSON.stringify([v.session, v.turn, v.epoch, v.at, v.total?.values, v.usage.values]),
          )
          .digest("hex")}`;
    const entry = parseHarnessUsageEntry({
      id,
      occurredAtMs: v.at,
      ...(v.model ? { model: v.model } : {}),
      inputTokens: input,
      outputTokens: output,
      ...(v.usage.known & 4 ? { cachedInputTokens: cached } : {}),
      ...(v.usage.known & 8 ? { cacheWriteInputTokens: written } : {}),
      ...(v.usage.known & 16 ? { reasoningOutputTokens: reasoning } : {}),
    });
    return entry ? [withUsageSession(entry, { sessionId: thread, cwd, title: firstPrompt })] : [];
  });
}

export function createCodexUsageStatistics(
  environment: NodeJS.ProcessEnv,
  options: SessionReadOptions = {},
): HarnessUsageStatisticsCapability {
  const home = path.resolve(
    environment.CODEX_HOME ||
      path.join(environment.HOME || environment.USERPROFILE || os.homedir(), ".codex"),
  );
  const groups = new Map<string, { thread: string; files: SourceFile[] }>();
  let names = new Map<string, string>();
  let namesStamp = "";
  async function threadNames(signal: AbortSignal): Promise<Map<string, string>> {
    const current = await stamp(path.join(home, "session_index.jsonl")).catch(() => "-");
    if (namesStamp === current) return names;
    names = await readThreadNames(home, signal);
    namesStamp = current;
    return names;
  }
  return {
    async listSources(signal): Promise<HarnessUsageSource[]> {
      const found = new Map<string, SourceFile[]>();
      async function visit(directory: string, depth: number): Promise<void> {
        signal.throwIfAborted();
        const entries = await readdir(directory, { withFileTypes: true }).catch(
          (error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
          },
        );
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          signal.throwIfAborted();
          const file = path.join(directory, entry.name);
          if (entry.isDirectory() && depth < 4) await visit(file, depth + 1);
          if (!entry.isFile()) continue;
          const thread = ROLLOUT.exec(entry.name)?.[1];
          if (!thread || (options.sessionId && thread !== options.sessionId)) continue;
          const list = found.get(thread) ?? [];
          list.push({ file, fingerprint: await stamp(file) });
          found.set(thread, list);
        }
      }
      await visit(path.join(home, "sessions"), 0);
      await visit(path.join(home, "archived_sessions"), 0);
      const indexStamp = options.sessionId
        ? ""
        : await stamp(path.join(home, "session_index.jsonl")).catch(() => "-");
      const result: HarnessUsageSource[] = [];
      groups.clear();
      for (const [thread, files] of found) {
        files.sort(
          (a, b) =>
            path.basename(a.file).localeCompare(path.basename(b.file)) ||
            a.file.localeCompare(b.file),
        );
        const id = path.join(home, `usage-thread-${thread}`);
        groups.set(id, { thread, files });
        result.push({ id, fingerprint: fingerprint(files, indexStamp) });
      }
      return result;
    },
    async readSource(id, signal): Promise<HarnessUsageEntry[]> {
      signal.throwIfAborted();
      const group = groups.get(id);
      if (!group) throw new Error("Unknown Codex usage source; list sources before reading");
      const kept: SourceFile[] = [];
      for (const candidate of group.files) {
        const name = path.basename(candidate.file).replace(/\.zst$/u, "");
        let duplicate = false;
        for (let i = 0; i < kept.length; i++) {
          const previous = kept[i];
          if (!previous) continue;
          if (path.basename(previous.file).replace(/\.zst$/u, "") !== name) continue;
          const relation = await copyRelation(previous.file, candidate.file, signal);
          if (relation === "equal" || relation === "b-prefix") {
            duplicate = true;
            break;
          }
          if (relation === "a-prefix") {
            kept.splice(i--, 1);
          }
        }
        if (!duplicate) kept.push(candidate);
      }
      const entries = await readCodexRollouts(
        kept.map(({ file }) => file),
        group.thread,
        signal,
        options,
      );
      // Do not cache a parse or prefix proof spanning an append/replacement.
      for (const file of group.files)
        if ((await stamp(file.file)) !== file.fingerprint)
          throw new Error("Codex rollout changed while reading; refresh to retry");
      const named = options.sessionId ? undefined : (await threadNames(signal)).get(group.thread);
      return named
        ? entries.map((entry) =>
            withUsageSession(entry, {
              sessionId: entry.sessionId,
              cwd: entry.cwd,
              title: named,
            }),
          )
        : entries;
    },
  };
}
