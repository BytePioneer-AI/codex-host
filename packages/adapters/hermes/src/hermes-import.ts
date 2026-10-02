import type { HarnessSessionImportSource } from "@codexhost/harness-adapter";
import type { HarnessSessionImportCandidate, NativeSessionRef } from "@codexhost/shared-contracts";
import {
  sessionImportCandidate,
  sessionImportTitle,
} from "@codexhost/harness-adapter/session-import";
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";
import type { ClientSideConnection } from "@agentclientprotocol/sdk";

interface HermesSessionRow {
  sessionId: string;
  title?: unknown;
  updatedAt?: unknown;
  cwd?: unknown;
  running?: unknown;
}

/** Native rows are untrusted: anything that is not an object with a string ID is dropped. */
function sessionRows(response: unknown): HermesSessionRow[] {
  const sessions: unknown =
    response && typeof response === "object" ? (response as { sessions?: unknown }).sessions : null;
  return Array.isArray(sessions)
    ? sessions.filter(
        (row): row is HermesSessionRow =>
          typeof row === "object" &&
          row !== null &&
          typeof (row as { sessionId?: unknown }).sessionId === "string",
      )
    : [];
}

function parseNativeRef(sessionId: string): NativeSessionRef {
  return nativeSessionRefSchema.parse({
    harnessId: "hermes",
    nativeSessionId: sessionId,
    formatVersion: 1,
  });
}

/** A row that cannot satisfy the shared candidate contract is skipped, never fabricated. */
function projectCandidate(row: HermesSessionRow): HarnessSessionImportCandidate | null {
  return sessionImportCandidate({
    nativeSessionId: row.sessionId,
    title: sessionImportTitle(row.title),
    updatedAt: row.updatedAt,
    cwd: row.cwd,
    running: row.running,
  });
}

export async function listHermesSessionCandidates(input: {
  connection: ClientSideConnection;
}): Promise<HarnessSessionImportCandidate[]> {
  const response = (await input.connection.request("session/list", {})) as unknown;
  return sessionRows(response).flatMap((row) => projectCandidate(row) ?? []);
}

export async function resolveHermesSessionCandidate(input: {
  connection: ClientSideConnection;
  nativeSessionId: string;
}): Promise<HarnessSessionImportSource | null> {
  const response = (await input.connection.request("session/list", {})) as unknown;
  const row = sessionRows(response).find(({ sessionId }) => sessionId === input.nativeSessionId);
  if (!row) return null;
  const candidate = projectCandidate(row);
  if (!candidate) return null;
  return { candidate, nativeRef: parseNativeRef(row.sessionId) };
}
