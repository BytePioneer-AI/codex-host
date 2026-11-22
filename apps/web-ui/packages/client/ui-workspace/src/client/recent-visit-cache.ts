/** Origin-local open-tab identities, never a title/history cache or proof of Host ownership. */
import type { SessionTarget } from "@deepseek-ai/dsh-api-session-controller/client";
import { SessionId } from "@deepseek-ai/dsh-session/types";

export interface RecentVisit {
  readonly sessionId: SessionId;
  readonly target: SessionTarget;
  readonly lastVisitedAt: number;
}

const CACHE_KEY = "codexhost.web.session-tabs.v2:local";
const PREVIOUS_CACHE_KEY = "codexhost.web.session-tabs.v1:local";
const LEGACY_CACHE_KEY = "codexhost.web.recent-visits.v1:local";
/** Corrupt or pathological payload protection, not a tab-count or eviction policy. */
const MAX_CACHE_CHARS = 1024 * 1024;

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

function decode(raw: string | null, version: 1 | 2): readonly RecentVisit[] {
  if (raw === null || raw.length > MAX_CACHE_CHARS) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !record(value) ||
      Object.keys(value).length !== 2 ||
      value.version !== version ||
      !Array.isArray(value.entries)
    )
      return [];
    const entries: RecentVisit[] = [];
    const seen = new Set<SessionId>();
    const now = Date.now();
    for (const entry of value.entries) {
      if (!record(entry)) continue;
      const fields = Object.keys(entry);
      if (version === 2 && fields.length !== 3) continue;
      if (fields.length !== 2 && (fields.length !== 3 || !Object.hasOwn(entry, "lastVisitedAt")))
        continue;
      const sessionId = id(entry.sessionId);
      if (sessionId === undefined || seen.has(sessionId)) continue;
      // Untimed tab records receive a grace period; reading does not expire or reorder them.
      const lastVisitedAt = Object.hasOwn(entry, "lastVisitedAt") ? entry.lastVisitedAt : now;
      if (
        typeof lastVisitedAt !== "number" ||
        !Number.isSafeInteger(lastVisitedAt) ||
        lastVisitedAt < 0 ||
        lastVisitedAt > now
      )
        continue;
      const parsedTarget = target(entry.target, sessionId);
      if (parsedTarget === undefined) continue;
      seen.add(sessionId);
      entries.push({ sessionId, target: parsedTarget, lastVisitedAt });
    }
    return entries;
  } catch {
    return [];
  }
}

/** Passive tabs never replay their complete stale snapshot into another browser tab. */
export class RecentVisitCache {
  private readonly enabled =
    typeof window !== "undefined" && /^https?:$/u.test(window.location.protocol);
  private reported = false;

  constructor(private readonly onFailure: () => void) {}

  read(): readonly RecentVisit[] {
    if (!this.enabled) return [];
    try {
      return this.latest();
    } catch {
      this.failed();
      return [];
    }
  }

  /** Preserve stored order; update existing identities in place and append only explicit new opens. */
  update(visits: readonly RecentVisit[], remove?: (entry: RecentVisit) => boolean): void {
    if (!this.enabled) return;
    try {
      const entries = this.latest().filter((entry) => remove?.(entry) !== true);
      const positions = new Map(entries.map((entry, index) => [entry.sessionId, index]));
      for (const entry of visits) {
        if (remove?.(entry) === true) continue;
        const index = positions.get(entry.sessionId);
        if (index === undefined) {
          positions.set(entry.sessionId, entries.length);
          entries.push(entry);
        } else {
          entries[index] = entry;
        }
      }
      const next = JSON.stringify({
        version: 2,
        entries: entries.map((entry) => ({
          sessionId: entry.sessionId,
          lastVisitedAt: entry.lastVisitedAt,
          target:
            typeof entry.target === "string"
              ? entry.target
              : {
                  parentSessionId: entry.target.parentSessionId,
                  childSessionId: entry.target.childSessionId,
                  mode: entry.target.mode,
                },
        })),
      });
      if (next.length > MAX_CACHE_CHARS) {
        this.failed();
        return;
      }
      if (localStorage.getItem(CACHE_KEY) !== next) localStorage.setItem(CACHE_KEY, next);
      localStorage.removeItem(PREVIOUS_CACHE_KEY);
      localStorage.removeItem(LEGACY_CACHE_KEY);
    } catch {
      this.failed();
    }
  }

  private latest(): readonly RecentVisit[] {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw !== null) return decode(raw, 2);
    const previous = localStorage.getItem(PREVIOUS_CACHE_KEY);
    return decode(previous ?? localStorage.getItem(LEGACY_CACHE_KEY), 1);
  }

  private failed(): void {
    if (this.reported) return;
    this.reported = true;
    try {
      this.onFailure();
    } catch {
      // Failure feedback must not turn optional persistence into a navigation failure.
    }
  }
}
