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
import type { SessionMessageInfo } from "@opencode/client";

import { v2UsageRequest } from "./v2/usage.js";

function parseRowData(data: unknown): unknown {
  try {
    return JSON.parse(String(data));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** OpenCode's database: `$OPENCODE_DB`, else `opencode.db` in `$XDG_DATA_HOME/opencode`. */
export function openCodeDatabasePath(environment: NodeJS.ProcessEnv): string | null {
  const home = environment.HOME || environment.USERPROFILE || os.homedir();
  const directory = path.join(
    environment.XDG_DATA_HOME || path.join(home, ".local", "share"),
    "opencode",
  );
  const configured = environment.OPENCODE_DB;
  if (configured === ":memory:") return null;
  return configured ? path.resolve(directory, configured) : path.join(directory, "opencode.db");
}

async function fingerprint(file: string): Promise<string | null> {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile()) return null;
  // Committed pages may sit in the write-ahead log until a checkpoint.
  const wal = await lstat(`${file}-wal`).catch(() => null);
  return `${info.ino}:${info.size}:${info.mtimeMs}:${wal ? `${wal.size}:${wal.mtimeMs}` : "-"}`;
}

/**
 * Every assistant message in OpenCode's database, read-only. OpenCode 2 keeps messages in
 * `session_message`; on its first start it copies every 1.x `message` into it with the same ID
 * and records `migration.v1-v2` completed, after which the old table is not written. Until then
 * the 1.x rows not yet copied are read too. A subagent's work is a session of its own, so its
 * messages are here as well. Title and compaction usage is not a message and is not counted,
 * as in the live meter.
 */
export async function readOpenCodeUsage(file: string): Promise<HarnessUsageEntry[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = new Set(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String(row.name)),
    );
    // Working directory of each session, from whichever session tables this version has.
    const directories = new Map<string, string>();
    for (const table of ["session", "session_v2"]) {
      if (!tables.has(table)) continue;
      for (const row of database.prepare(`SELECT id, directory FROM ${table}`).iterate()) {
        if (typeof row.directory === "string") directories.set(String(row.id), row.directory);
      }
    }
    const entries = new Map<string, HarnessUsageEntry>();
    const add = (message: SessionMessageInfo, createdAtMs: unknown, session: unknown): void => {
      let request;
      try {
        request = v2UsageRequest(message, true);
      } catch {
        return;
      }
      const at = nativeTimeMs(createdAtMs);
      const entry = request && at !== null && usageEntryFromRequest(request, at);
      if (entry && !entries.has(entry.id)) {
        const sessionId = typeof session === "string" ? session : undefined;
        entries.set(
          entry.id,
          withUsageSession(entry, {
            sessionId,
            cwd: sessionId === undefined ? undefined : directories.get(sessionId),
          }),
        );
      }
    };
    if (tables.has("session_message")) {
      for (const row of database
        .prepare("SELECT id, session_id, data FROM session_message WHERE type = 'assistant'")
        .iterate()) {
        const data = parseRowData(row.data);
        if (!isRecord(data)) continue;
        add(
          { ...data, id: String(row.id), type: "assistant" } as unknown as SessionMessageInfo,
          isRecord(data.time) ? data.time.created : undefined,
          row.session_id,
        );
      }
    }
    const migrated =
      tables.has("kv") &&
      /"phase"\s*:\s*"completed"/u.test(
        String(
          database.prepare("SELECT value FROM kv WHERE key = 'migration.v1-v2'").get()?.value ?? "",
        ),
      );
    if (tables.has("message") && !migrated) {
      for (const row of database.prepare("SELECT id, session_id, data FROM message").iterate()) {
        const data = parseRowData(row.data);
        if (!isRecord(data) || data.role !== "assistant" || typeof data.modelID !== "string") {
          continue;
        }
        add(
          {
            id: String(row.id),
            type: "assistant",
            model: { id: data.modelID, providerID: data.providerID },
            tokens: data.tokens,
            time: data.time,
          } as unknown as SessionMessageInfo,
          isRecord(data.time) ? data.time.created : undefined,
          row.session_id,
        );
      }
    }
    return [...entries.values()];
  } finally {
    database.close();
  }
}

export function createOpenCodeUsageStatistics(
  environment: NodeJS.ProcessEnv,
): HarnessUsageStatisticsCapability {
  return Object.freeze({
    async listSources(): Promise<HarnessUsageSource[]> {
      const file = openCodeDatabasePath(environment);
      const stamp = file ? await fingerprint(file) : null;
      return file && stamp ? [{ id: file, fingerprint: stamp }] : [];
    },
    readSource: (id: string) => readOpenCodeUsage(id),
  });
}
