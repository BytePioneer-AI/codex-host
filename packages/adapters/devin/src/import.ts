import type { HarnessSessionImportSource } from "@codexhost/harness-adapter";
import type { HarnessSessionImportCandidate, NativeSessionRef } from "@codexhost/shared-contracts";
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";
import type { ClientSideConnection } from "@agentclientprotocol/sdk";

interface DevinSessionRow {
  sessionId: string;
  title?: unknown;
  updatedAt?: unknown;
  cwd?: unknown;
  _meta?: unknown;
}

interface DevinListSessionsResponse {
  sessions?: DevinSessionRow[];
}

function parseNativeRef(sessionId: string): NativeSessionRef {
  return nativeSessionRefSchema.parse({
    harnessId: "devin",
    nativeSessionId: sessionId,
    formatVersion: 1,
  });
}

function rowIsLocked(row: DevinSessionRow): boolean | null {
  const meta = row._meta;
  if (!meta || typeof meta !== "object") return null;
  const locked = (meta as Record<string, unknown>)["cognition.ai/isLocked"];
  return typeof locked === "boolean" ? locked : null;
}

/**
 * candidate.updatedAt is a bounded epoch-ms integer and cwd is required; a
 * candidate that cannot satisfy both is skipped rather than fabricated.
 */
function projectCandidate(row: DevinSessionRow): HarnessSessionImportCandidate | null {
  const updatedAt =
    typeof row.updatedAt === "number" ? row.updatedAt : Date.parse(String(row.updatedAt));
  if (!Number.isFinite(updatedAt) || updatedAt < 0) return null;
  if (typeof row.cwd !== "string" || row.cwd.trim().length === 0) return null;
  return {
    nativeSessionId: row.sessionId,
    title: typeof row.title === "string" && row.title.trim().length > 0 ? row.title : null,
    updatedAt,
    cwd: row.cwd,
    running: rowIsLocked(row),
  };
}

async function listRows(connection: ClientSideConnection): Promise<DevinSessionRow[]> {
  const response = (await connection.request("session/list", {})) as unknown;
  return response && typeof response === "object"
    ? ((response as DevinListSessionsResponse).sessions ?? [])
    : [];
}

export async function listDevinSessionCandidates(input: {
  connection: ClientSideConnection;
}): Promise<HarnessSessionImportCandidate[]> {
  const candidates: HarnessSessionImportCandidate[] = [];
  for (const row of await listRows(input.connection)) {
    if (typeof row.sessionId !== "string" || row.sessionId.length === 0) continue;
    const candidate = projectCandidate(row);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

export async function resolveDevinSessionCandidate(input: {
  connection: ClientSideConnection;
  nativeSessionId: string;
}): Promise<HarnessSessionImportSource | null> {
  const row = (await listRows(input.connection)).find(
    ({ sessionId }) => sessionId === input.nativeSessionId,
  );
  if (!row) return null;
  const candidate = projectCandidate(row);
  if (!candidate) return null;
  return { candidate, nativeRef: parseNativeRef(row.sessionId) };
}
