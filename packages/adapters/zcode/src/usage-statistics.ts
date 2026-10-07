import os from "node:os";
import path from "node:path";
import { lstat } from "node:fs/promises";

import type {
  HarnessUsageEntry,
  HarnessUsageSource,
  HarnessUsageStatisticsCapability,
} from "@codexhost/harness-adapter";
import {
  nativeTimeMs,
  usageEntryFromRequest,
  withUsageSession,
} from "@codexhost/harness-adapter/usage-statistics";

import { messageSchema, record, text } from "./protocol.js";
import { zcodeUsageRecord } from "./usage.js";

/** The ZCode CLI's database, an OpenCode-style store: `~/.zcode/cli/db/db.sqlite`. */
export function zcodeDatabasePath(environment: NodeJS.ProcessEnv): string {
  return path.join(
    environment.ZCODE_DATA_BASE_DIR?.trim() || environment.HOME || os.homedir(),
    ".zcode",
    "cli",
    "db",
    "db.sqlite",
  );
}

/**
 * Every assistant message in the ZCode CLI database, read-only, converted as the live meter
 * converts a `session/read` message: tokens are AI SDK totals (input with cache, output with
 * reasoning), cancelled placeholders and system messages are not requests, and a message whose
 * totals do not add up is not counted. A subagent's work is a session of its own, so its
 * messages are here too. `model_usage` is not read: its retention differs from the messages.
 */
export async function readZcodeUsage(file: string): Promise<HarnessUsageEntry[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const entries: HarnessUsageEntry[] = [];
    const directories = new Map<string, string>();
    const hasSessions = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session'")
      .get();
    if (hasSessions) {
      for (const row of database.prepare("SELECT id, directory FROM session").iterate()) {
        if (typeof row.directory === "string") directories.set(String(row.id), row.directory);
      }
    }
    for (const row of database.prepare("SELECT id, session_id, data FROM message").iterate()) {
      let data: Record<string, unknown>;
      try {
        data = record(JSON.parse(String(row.data)));
      } catch {
        continue;
      }
      if (data.role !== "assistant") continue;
      const modelId = text(data.modelId) || text(data.modelID);
      const providerId = text(data.providerId) || text(data.providerID);
      const parsed = messageSchema.safeParse({
        info: {
          ...data,
          messageId: String(row.id),
          sessionId: String(row.session_id),
          ...(modelId && providerId ? { model: { providerId, modelId } } : {}),
        },
        parts: [],
      });
      if (!parsed.success) continue;
      const usage = zcodeUsageRecord(parsed.data);
      const at = nativeTimeMs(parsed.data.info.time.created);
      const entry =
        usage.kind === "request" && at !== null && usageEntryFromRequest(usage.request, at);
      if (entry) {
        const sessionId = String(row.session_id);
        entries.push(withUsageSession(entry, { sessionId, cwd: directories.get(sessionId) }));
      }
    }
    return entries;
  } finally {
    database.close();
  }
}

export function createZcodeUsageStatistics(
  environment: NodeJS.ProcessEnv,
): HarnessUsageStatisticsCapability {
  return Object.freeze({
    async listSources(): Promise<HarnessUsageSource[]> {
      const file = zcodeDatabasePath(environment);
      const info = await lstat(file).catch(() => null);
      if (!info?.isFile()) return [];
      // Committed pages may sit in the write-ahead log until a checkpoint.
      const wal = await lstat(`${file}-wal`).catch(() => null);
      return [
        {
          id: file,
          fingerprint: `${info.ino}:${info.size}:${info.mtimeMs}:${wal ? `${wal.size}:${wal.mtimeMs}` : "-"}`,
        },
      ];
    },
    readSource: (id: string) => readZcodeUsage(id),
  });
}
