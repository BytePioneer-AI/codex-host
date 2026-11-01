import type { Stats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  HarnessUsageEntry,
  HarnessUsageSource,
  HarnessUsageStatisticsCapability,
} from "@codexhost/harness-adapter";
import {
  HarnessUsageSourceChangedError,
  jsonlRecords,
  nativeTimeMs,
  withUsageSession,
} from "@codexhost/harness-adapter/usage-statistics";

import { nativeBrainRoot } from "./fork.js";

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** The home agy resolves `~/.gemini` against: `USERPROFILE` on Windows, `HOME` elsewhere. */
function antigravityHome(environment: NodeJS.ProcessEnv): string {
  return (
    (process.platform === "win32" ? environment.USERPROFILE : environment.HOME) || os.homedir()
  );
}

/**
 * The transcript holding every step of one Conversation. `transcript_full.jsonl` and the files
 * under `chunks/` repeat the same steps, so only this one is read.
 */
function transcriptPath(brainRoot: string, conversationId: string): string {
  return path.join(brainRoot, conversationId, ".system_generated", "logs", "transcript.jsonl");
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** A missing path is null; any other failure must not hide usage, so it propagates. */
async function lstatIfPresent(target: string): Promise<Stats | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** A transcript's identity, size and modification time, or null when it has nothing to read. */
async function transcriptFingerprint(file: string): Promise<string | null> {
  const logs = path.dirname(file);
  // A link below the Conversation could point the read outside agy's store.
  for (const directory of [path.dirname(logs), logs]) {
    if (!(await lstatIfPresent(directory))?.isDirectory()) return null;
  }
  const info = await lstatIfPresent(file);
  return info?.isFile() && info.size > 0 ? `${info.ino}:${info.size}:${info.mtimeMs}` : null;
}

async function listTranscripts(
  brainRoot: string,
  signal: AbortSignal,
): Promise<HarnessUsageSource[]> {
  signal.throwIfAborted();
  const conversations = await opendir(brainRoot).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!conversations) return [];
  const sources: HarnessUsageSource[] = [];
  for await (const entry of conversations) {
    signal.throwIfAborted();
    if (!entry.isDirectory()) continue;
    const file = transcriptPath(brainRoot, entry.name);
    const fingerprint = await transcriptFingerprint(file);
    if (fingerprint) sources.push({ id: file, fingerprint });
  }
  return sources;
}

/**
 * Every model request in one Conversation's `transcript.jsonl`: agy writes one `PLANNER_RESPONSE`
 * step per request with its `input_tokens`, `cache_read_tokens`, `output_tokens` and UTC
 * `created_at`. Verified on Antigravity CLI 1.4.6 transcripts: `input_tokens` excludes cache reads
 * (a follow-up request's `cache_read_tokens` is about the previous request's whole prompt), so
 * input is recombined to include them. The transcript records neither the model, cache writes,
 * thinking tokens nor the working directory; they stay unknown. The entry ID leaves out the
 * Conversation, so a copy of a request in a derived Conversation deduplicates with the original.
 */
export async function readAntigravityUsage(
  file: string,
  signal: AbortSignal,
): Promise<HarnessUsageEntry[]> {
  const sessionId = path.basename(path.resolve(file, "..", "..", ".."));
  // A step written again replaces its earlier record rather than counting twice.
  const requests = new Map<number, HarnessUsageEntry>();
  for await (const record of jsonlRecords(file, '"input_tokens"', signal)) {
    if (record.type !== "PLANNER_RESPONSE") continue;
    const step = count(record.step_index);
    const input = count(record.input_tokens);
    const output = count(record.output_tokens);
    const cached = count(record.cache_read_tokens);
    const at = nativeTimeMs(record.created_at);
    if (step === null || input === null || output === null || at === null) continue;
    requests.set(
      step,
      withUsageSession(
        {
          id: `${String(record.created_at)}:${step}:${input}:${cached ?? "-"}:${output}`,
          occurredAtMs: at,
          inputTokens: input + (cached ?? 0),
          ...(cached !== null ? { cachedInputTokens: cached } : {}),
          outputTokens: output,
        },
        { sessionId },
      ),
    );
  }
  return [...requests.values()];
}

/** Read-only access to agy's own transcripts; never starts agy or calls its Language Server. */
export function createAntigravityUsageStatistics(
  environment: NodeJS.ProcessEnv,
): HarnessUsageStatisticsCapability {
  const brainRoot = nativeBrainRoot(antigravityHome(environment));
  /** Fingerprints of the latest listing; a read must still match the one it was listed with. */
  let listed = new Map<string, string>();
  return Object.freeze({
    async listSources(signal: AbortSignal) {
      const sources = await listTranscripts(brainRoot, signal);
      listed = new Map(sources.map(({ id, fingerprint }) => [id, fingerprint]));
      return sources;
    },
    async readSource(id: string, signal: AbortSignal) {
      const expected = listed.get(id);
      let entries: HarnessUsageEntry[];
      try {
        entries = await readAntigravityUsage(id, signal);
      } catch (error) {
        // A listed transcript removed before it was opened is a changed source, not a failure.
        if (expected !== undefined && isMissing(error)) {
          throw new HarnessUsageSourceChangedError(
            "Antigravity transcript disappeared before reading; refresh to retry",
          );
        }
        throw error;
      }
      // agy appends steps while a Turn runs. A read the listing no longer describes is not
      // returned, so the Host lists again and retries instead of caching it under that listing.
      if (expected !== undefined && (await transcriptFingerprint(id)) !== expected) {
        throw new HarnessUsageSourceChangedError(
          "Antigravity transcript changed while reading; refresh to retry",
        );
      }
      return entries;
    },
  });
}
