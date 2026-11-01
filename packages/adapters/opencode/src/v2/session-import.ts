import fs from "node:fs";
import path from "node:path";

import type { OpenCodeClient, SessionInfo } from "@opencode/client";
import type { HarnessSessionImportSource } from "@codexhost/harness-adapter";
import {
  sessionImportCandidate,
  sessionImportTitle,
} from "@codexhost/harness-adapter/session-import";
import type { HarnessSessionImportCandidate } from "@codexhost/shared-contracts";

import { v2Ref } from "./state.js";

const PAGE_SIZE = 200;
// A runaway or repeating cursor must not turn discovery into an endless read.
const MAX_PAGES = 10_000;

type ActiveSessions = Awaited<ReturnType<OpenCodeClient["session"]["active"]>>;

function existingDirectory(directory: unknown): string | null {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) return null;
  try {
    return fs.statSync(directory).isDirectory() ? directory : null;
  } catch {
    return null;
  }
}

function candidate(
  info: SessionInfo,
  active: ActiveSessions,
): HarnessSessionImportCandidate | null {
  // Child Sessions belong to their parent and archived ones were put away natively.
  if (info.parentID || info.time.archived !== undefined) return null;
  // Kept as OpenCode reports it: resume requires the Session's own directory.
  const cwd = existingDirectory(info.location.directory);
  if (!cwd) return null;
  return sessionImportCandidate({
    nativeSessionId: info.id,
    cwd,
    title: sessionImportTitle(info.title),
    updatedAt: info.time.updated,
    // This server only knows its own executions; another process may still hold the Session.
    running: active[info.id] ? true : null,
  });
}

/** Every top-level Session the native service lists, across all projects. */
export async function listV2SessionCandidates(
  client: OpenCodeClient,
): Promise<HarnessSessionImportCandidate[]> {
  const active = await client.session.active();
  const candidates = new Map<string, HarnessSessionImportCandidate>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await client.session.list({
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    for (const info of response.data) {
      const entry = candidate(info, active);
      if (entry) candidates.set(entry.nativeSessionId, entry);
    }
    const next = response.cursor.next;
    if (!next || cursors.has(next)) break;
    cursors.add(next);
    cursor = next;
  }
  return [...candidates.values()];
}

/** Re-read the selected Session from the native service; null when it is gone or ineligible. */
export async function resolveV2SessionCandidate(
  client: OpenCodeClient,
  nativeSessionId: string,
): Promise<HarnessSessionImportSource | null> {
  // A listing, not `session.get`: absence is then an ordinary answer, never a guessed error class.
  const active = await client.session.active();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await client.session.list({
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    const info = response.data.find((entry) => entry.id === nativeSessionId);
    if (info) {
      const entry = candidate(info, active);
      // Native history cannot attest to earlier unattended access, so none is assumed.
      return entry ? { candidate: entry, nativeRef: v2Ref(info, "default") } : null;
    }
    const next = response.cursor.next;
    if (!next || cursors.has(next)) break;
    cursors.add(next);
    cursor = next;
  }
  return null;
}
