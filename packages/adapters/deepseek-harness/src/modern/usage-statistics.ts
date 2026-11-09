import os from "node:os";
import path from "node:path";
import { lstat, readFile, readdir } from "node:fs/promises";
import { zstdDecompressSync } from "node:zlib";

import type {
  HarnessUsageEntry,
  HarnessUsageSource,
  HarnessUsageStatisticsCapability,
} from "@codexhost/harness-adapter";
import {
  usageEntryFromRequest,
  usageSessionTitle,
  withUsageSession,
} from "@codexhost/harness-adapter/usage-statistics";

import type { ModernJournalEvent } from "./journal.js";
import { deepSeekUsageRecord } from "./usage-metering.js";

const SESSION_FILE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/u;
const ZSTD_MAGIC = 0xfd2fb528;

/** dsh's folder: `$DSH_HOME`, else `~/.dsh`. */
export function dshHome(environment: NodeJS.ProcessEnv): string {
  return environment.DSH_HOME || path.join(environment.HOME || os.homedir(), ".dsh");
}

/**
 * The complete zstd frames of a file dsh appends one frame per batch to. Node decompresses only
 * the first frame of a buffer, so frames are found from their headers and block sizes. A frame
 * still being written at the end is left out; skippable frames are skipped.
 */
export function zstdFrames(buffer: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const magic = buffer.readUInt32LE(offset);
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      offset += 8 + buffer.readUInt32LE(offset + 4);
      continue;
    }
    if (magic !== ZSTD_MAGIC) throw new Error("dsh session file is not zstd");
    const start = offset;
    const descriptor = buffer[offset + 4] ?? 0;
    const single = (descriptor >> 5) & 1;
    offset += 5 + (single ? 0 : 1);
    offset += [0, 1, 2, 4][descriptor & 3] ?? 0;
    offset += [single, 2, 4, 8][descriptor >> 6] ?? 0;
    for (;;) {
      if (offset + 3 > buffer.length) return frames;
      const header = buffer.readUIntLE(offset, 3);
      const type = (header >> 1) & 3;
      if (type === 3) throw new Error("dsh session file has a reserved zstd block");
      offset += 3 + (type === 1 ? 1 : header >>> 3);
      if (header & 1) break;
    }
    if ((descriptor >> 2) & 1) offset += 4;
    if (offset > buffer.length) return frames;
    frames.push(buffer.subarray(start, offset));
  }
  return frames;
}

/**
 * Every model request in one dsh session file. Its lines are the journal events the live meter
 * reads, so the same record function applies. A fork seeded from another session repeats that
 * session's messages with the same IDs and times (verified on local sessions), so the Host's
 * dedup counts them once; a subagent's session is a folder of its own.
 */
export async function readDshUsage(file: string): Promise<HarnessUsageEntry[]> {
  const buffer = await readFile(file);
  const text = file.endsWith(".zstd")
    ? zstdFrames(buffer)
        .map((frame) => zstdDecompressSync(frame).toString("utf8"))
        .join("")
    : buffer.toString("utf8");
  const entries: HarnessUsageEntry[] = [];
  // The journal opens with a `"type":"session"` header naming the session and its cwd.
  let session: { sessionId?: string; cwd?: string; title?: string } = {};
  for (const line of text.split("\n")) {
    if (entries.length === 0 && line.startsWith('{"type":"session"')) {
      try {
        const header = JSON.parse(line) as Record<string, unknown>;
        const title = usageSessionTitle(header.title ?? header.name);
        session = {
          ...(typeof header.id === "string" ? { sessionId: header.id } : {}),
          ...(typeof header.cwd === "string" ? { cwd: header.cwd } : {}),
          ...(title ? { title } : {}),
        };
      } catch {
        // A damaged header only loses the attribution.
      }
      continue;
    }
    if (!line.includes('"assistant/message"')) continue;
    let event: ModernJournalEvent;
    try {
      event = JSON.parse(line) as ModernJournalEvent;
    } catch {
      continue;
    }
    const record = deepSeekUsageRecord(event, true);
    const entry = record.kind === "request" && usageEntryFromRequest(record.request, event.time);
    if (entry) entries.push(withUsageSession(entry, session));
  }
  return entries;
}

export function createDshUsageStatistics(
  environment: NodeJS.ProcessEnv,
): HarnessUsageStatisticsCapability {
  return Object.freeze({
    async listSources(signal: AbortSignal): Promise<HarnessUsageSource[]> {
      const root = path.join(dshHome(environment), "sessions");
      const sources: HarnessUsageSource[] = [];
      for (const project of await readdir(root).catch(() => [])) {
        for (const session of await readdir(path.join(root, project)).catch(() => [])) {
          signal.throwIfAborted();
          const directory = path.join(root, project, session);
          // A session carried over to a newer format leaves the older file behind.
          const latest = (await readdir(directory).catch(() => []))
            .map((name) => ({ name, version: Number(SESSION_FILE.exec(name)?.[1] ?? 1) }))
            .filter(({ name }) => SESSION_FILE.test(name))
            .sort((left, right) => right.version - left.version)[0];
          if (!latest) continue;
          const file = path.join(directory, latest.name);
          const info = await lstat(file).catch(() => null);
          if (info?.isFile() && info.size > 0) {
            sources.push({ id: file, fingerprint: `${info.ino}:${info.size}:${info.mtimeMs}` });
          }
        }
      }
      return sources;
    },
    readSource: (id: string) => readDshUsage(id),
  });
}
