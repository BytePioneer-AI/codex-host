import type { HarnessSessionImportSource } from "@codexhost/harness-adapter";
import type { HarnessSessionImportCandidate, NativeSessionRef } from "@codexhost/shared-contracts";
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";
import type { ClientSideConnection } from "@agentclientprotocol/sdk";

interface HermesSessionRow {
  sessionId: string;
  title?: unknown;
  updatedAt?: unknown;
  cwd?: unknown;
  running?: unknown;
}

interface HermesListSessionsResponse {
  sessions?: HermesSessionRow[];
}

function parseNativeRef(sessionId: string): NativeSessionRef {
  return nativeSessionRefSchema.parse({
    harnessId: "hermes",
    nativeSessionId: sessionId,
    formatVersion: 1,
  });
}

/**
 * candidate.updatedAt is a bounded epoch-ms integer and cwd is required; a
 * candidate that cannot satisfy both is skipped rather than fabricated.
 */
function projectCandidate(row: HermesSessionRow): HarnessSessionImportCandidate | null {
  const updatedAt =
    typeof row.updatedAt === "number" ? row.updatedAt : Date.parse(String(row.updatedAt));
  if (!Number.isFinite(updatedAt) || updatedAt < 0) return null;
  if (typeof row.cwd !== "string" || row.cwd.trim().length === 0) return null;
  return {
    nativeSessionId: row.sessionId,
    title: typeof row.title === "string" && row.title.trim().length > 0 ? row.title : null,
    updatedAt,
    cwd: row.cwd,
    running: typeof row.running === "boolean" ? row.running : null,
  };
}

export async function listHermesSessionCandidates(input: {
  connection: ClientSideConnection;
}): Promise<HarnessSessionImportCandidate[]> {
  const response = (await input.connection.request("session/list", {})) as unknown;
  const sessions =
    response && typeof response === "object"
      ? ((response as HermesListSessionsResponse).sessions ?? [])
      : [];
  const candidates: HarnessSessionImportCandidate[] = [];
  for (const row of sessions) {
    if (typeof row.sessionId !== "string" || row.sessionId.length === 0) continue;
    const candidate = projectCandidate(row);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

export async function resolveHermesSessionCandidate(input: {
  connection: ClientSideConnection;
  nativeSessionId: string;
}): Promise<HarnessSessionImportSource | null> {
  const response = (await input.connection.request("session/list", {})) as unknown;
  const sessions =
    response && typeof response === "object"
      ? ((response as HermesListSessionsResponse).sessions ?? [])
      : [];
  const row = sessions.find(({ sessionId }) => sessionId === input.nativeSessionId);
  if (!row) return null;
  const candidate = projectCandidate(row);
  if (!candidate) return null;
  return { candidate, nativeRef: parseNativeRef(row.sessionId) };
}
