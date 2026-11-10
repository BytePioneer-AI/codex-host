/** Origin-local visit hints, never a title/history cache or proof of Host ownership. */
import type { SessionTarget } from "@deepseek-ai/dsh-api-session-controller/client";
import { SessionId } from "@deepseek-ai/dsh-session/types";

export interface RecentVisit {
  readonly sessionId: SessionId;
  readonly target: SessionTarget;
  readonly lastVisitedAt: number;
}

export const OTHER_VISIT_LIMIT = 6;
export const VISIT_MAX_AGE_MS = 30 * 60 * 1000;
const CACHE_KEY = "codexhost.web.recent-visits.v1:local";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function id(value: unknown): SessionId | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? SessionId(value)
    : undefined;
}

/** Rebuild the public discriminated address rather than casting untrusted JSON. */
function target(value: unknown, sessionId: SessionId): SessionTarget | undefined {
  if (typeof value === "string") return value === sessionId ? sessionId : undefined;
  if (!record(value) || Object.keys(value).length !== 3) return undefined;
  const parent = id(value.parentSessionId);
  const child = id(value.childSessionId);
  const mode = value.mode;
  if (
    parent === undefined ||
    child !== sessionId ||
    parent === child ||
    (mode !== "one-shot" && mode !== "continuable" && mode !== "unknown")
  )
    return undefined;
  return { parentSessionId: parent, childSessionId: child, mode };
}

function decode(raw: string | null, now: number): readonly RecentVisit[] {
  if (raw === null || raw.length > 32768) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !record(value) ||
      Object.keys(value).length !== 2 ||
      value.version !== 1 ||
      !Array.isArray(value.entries) ||
      value.entries.length > OTHER_VISIT_LIMIT + 1
    )
      return [];
    const visits: RecentVisit[] = [];
    for (const entry of value.entries) {
      if (!record(entry) || Object.keys(entry).length !== 3) continue;
      const sessionId = id(entry.sessionId);
      const lastVisitedAt = entry.lastVisitedAt;
      if (
        sessionId === undefined ||
        typeof lastVisitedAt !== "number" ||
        !Number.isSafeInteger(lastVisitedAt) ||
        lastVisitedAt < 0 ||
        lastVisitedAt > now ||
        now - lastVisitedAt >= VISIT_MAX_AGE_MS
      )
        continue;
      const parsedTarget = target(entry.target, sessionId);
      if (parsedTarget !== undefined)
        visits.push({ sessionId, target: parsedTarget, lastVisitedAt });
    }
    return newest(visits);
  } catch {
    return [];
  }
}

function newest(entries: readonly RecentVisit[]): RecentVisit[] {
  const seen = new Set<SessionId>();
  return [...entries]
    .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
    .filter((entry) => {
      if (seen.has(entry.sessionId)) return false;
      seen.add(entry.sessionId);
      return true;
    });
}

export function boundVisits(
  entries: readonly RecentVisit[],
  currentId?: SessionId,
): readonly RecentVisit[] {
  let others = 0;
  const seen = new Set<SessionId>();
  return entries.filter((entry) => {
    if (seen.has(entry.sessionId)) return false;
    seen.add(entry.sessionId);
    return entry.sessionId === currentId || others++ < OTHER_VISIT_LIMIT;
  });
}

/** No storage listeners: a passive old tab cannot replay its stale working set into another tab. */
export class RecentVisitCache {
  private readonly enabled =
    typeof window !== "undefined" && /^https?:$/u.test(window.location.protocol);
  private reported = false;

  constructor(private readonly onFailure: () => void) {}

  read(now = Date.now()): readonly RecentVisit[] {
    if (!this.enabled) return [];
    try {
      return decode(localStorage.getItem(CACHE_KEY), now);
    } catch {
      this.failed();
      return [];
    }
  }

  /** Merge only actual visit mutations with the latest origin record, never the tab's whole stale snapshot. */
  update(
    visits: readonly RecentVisit[],
    currentId?: SessionId,
    remove?: (entry: RecentVisit) => boolean,
  ): void {
    if (!this.enabled) return;
    try {
      const now = Date.now();
      const raw = localStorage.getItem(CACHE_KEY);
      const validVisits = visits.filter(
        (entry) => entry.lastVisitedAt <= now && now - entry.lastVisitedAt < VISIT_MAX_AGE_MS,
      );
      const merged = newest([...validVisits, ...decode(raw, now)]).filter(
        (entry) => remove?.(entry) !== true,
      );
      // Passive expiry/invalidation must not re-cap another tab's six-plus-current set
      // using this tab's different selection. Only an actual visit changes that cap.
      const bounded =
        validVisits.length === 0
          ? merged.slice(0, OTHER_VISIT_LIMIT + 1)
          : boundVisits(merged, currentId);
      if (raw === null && bounded.length === 0) return;
      const next = JSON.stringify({
        version: 1,
        entries: bounded.map((entry) => ({
          sessionId: entry.sessionId,
          target:
            typeof entry.target === "string"
              ? entry.target
              : {
                  parentSessionId: entry.target.parentSessionId,
                  childSessionId: entry.target.childSessionId,
                  mode: entry.target.mode,
                },
          lastVisitedAt: entry.lastVisitedAt,
        })),
      });
      if (next !== raw) localStorage.setItem(CACHE_KEY, next);
    } catch {
      this.failed();
    }
  }

  private failed(): void {
    if (this.reported) return;
    this.reported = true;
    try {
      this.onFailure();
    } catch {
      // Failure feedback must not turn an optional cache into a navigation failure.
    }
  }
}
