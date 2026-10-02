import type { HarnessSessionImportSource } from "@codexhost/harness-adapter";
import {
  harnessSessionImportCandidateSchema,
  nativeSessionRefSchema,
  type HarnessSessionImportCandidate,
} from "@codexhost/shared-contracts";
import { readHermesSessions, type HermesSessionListOptions } from "./gateway-session-list.js";

/** Native SessionDB timestamps are epoch seconds; never invent cwd or activity. */
function projectCandidate(value: unknown): HarnessSessionImportCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.last_active !== "number" ||
    !Number.isFinite(row.last_active) ||
    row.last_active < 0
  )
    return null;
  const parsed = harnessSessionImportCandidateSchema.safeParse({
    nativeSessionId: row.id,
    title: typeof row.title === "string" && row.title.trim() ? row.title : null,
    updatedAt: Math.trunc(row.last_active * 1000),
    cwd: row.cwd,
    // A fresh metadata reader cannot establish another process's idle state.
    running: null,
  });
  return parsed.success ? parsed.data : null;
}

export async function listHermesSessionCandidates(
  input: HermesSessionListOptions,
): Promise<HarnessSessionImportCandidate[]> {
  const candidates = new Map<string, HarnessSessionImportCandidate>();
  for (const row of await readHermesSessions(input)) {
    const candidate = projectCandidate(row);
    if (candidate && !candidates.has(candidate.nativeSessionId))
      candidates.set(candidate.nativeSessionId, candidate);
  }
  return [...candidates.values()];
}

export async function resolveHermesSessionCandidate(
  input: HermesSessionListOptions & { nativeSessionId: string },
): Promise<HarnessSessionImportSource | null> {
  const candidates = await listHermesSessionCandidates(input);
  const candidate = candidates.find((row) => row.nativeSessionId === input.nativeSessionId);
  if (!candidate) return null;
  return {
    candidate,
    nativeRef: nativeSessionRefSchema.parse({
      harnessId: "hermes",
      nativeSessionId: candidate.nativeSessionId,
      formatVersion: 1,
    }),
  };
}
