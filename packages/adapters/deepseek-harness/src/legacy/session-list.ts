import path from "node:path";

import type { SessionSummary } from "@deepseek-ai/dsh-host-apiproxy/api";

import {
  DEEPSEEK_MODERN_SESSION_CWD_MAX_LENGTH,
  DEEPSEEK_MODERN_SESSION_ID_MAX_LENGTH,
  DEEPSEEK_MODERN_SESSION_TITLE_MAX_LENGTH,
  type DeepSeekModernSessionCandidate,
} from "@codexhost/shared-contracts";

interface LegacySessionProjections {
  readonly asOfSeq?: number;
  readonly values?: Record<string, unknown>;
}

function validSessionId(value: string): boolean {
  return (
    value.trim().length > 0 &&
    !value.includes("\0") &&
    value.length <= DEEPSEEK_MODERN_SESSION_ID_MAX_LENGTH
  );
}

function canonicalAbsoluteCwd(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.trim().length > 0 &&
    !value.includes("\0") &&
    path.isAbsolute(value) &&
    path.resolve(value) === value &&
    value.length <= DEEPSEEK_MODERN_SESSION_CWD_MAX_LENGTH
  );
}

function titleFromProjections(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const projections = value as LegacySessionProjections;
  if (typeof projections.values !== "object" || projections.values === null) return null;
  const title = projections.values.title;
  if (typeof title !== "string") return null;
  const trimmed = title.trim();
  return trimmed.length > 0 &&
    !trimmed.includes("\0") &&
    trimmed.length <= DEEPSEEK_MODERN_SESSION_TITLE_MAX_LENGTH
    ? trimmed
    : null;
}

/**
 * Convert a validated Legacy DSH 'session.list' payload into importable
 * candidates. The Legacy RPC client already enforces the wire schema, so this
 * converter only applies the codexhost import eligibility rules shared with the
 * Modern path: skip subagents and blank sessions, and require a canonical
 * absolute cwd.
 */
export function parseLegacySessionCandidates(
  items: readonly SessionSummary[],
): DeepSeekModernSessionCandidate[] {
  const candidates: DeepSeekModernSessionCandidate[] = [];
  for (const item of items) {
    if (!validSessionId(item.sessionId)) continue;
    if (item.origin === "subagent" || item.blank) continue;
    if (!canonicalAbsoluteCwd(item.cwd)) continue;
    candidates.push({
      nativeSessionId: item.sessionId,
      title: titleFromProjections(item.projections),
      updatedAt: item.updatedAt,
      cwd: item.cwd,
      running: item.running,
    });
  }
  return candidates;
}
