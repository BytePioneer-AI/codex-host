import type {
  ModernJournalEvent,
  ModernJournalHeader,
  ModernJournalOpenRequest,
  ModernJournalLiveItem,
} from "../modern/journal.js";
import {
  DEEPSEEK_V4_FIRST_VERSION,
  DEEPSEEK_V4_PROFILE,
  type DeepSeekAssistantBaseline,
} from "./v4.js";
export { DEEPSEEK_V4_PROFILE };

export type DeepSeekModernVersion = string;

/** First DSH release that writes Session Format V4; older CLIs are refused before Web starts. */
export const DEEPSEEK_MINIMUM_VERSION = DEEPSEEK_V4_FIRST_VERSION;

interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
}

const MINIMUM = parseSemVer(DEEPSEEK_MINIMUM_VERSION);

function parseSemVer(value: string): SemVer | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
  if (!match) return undefined;
  const prerelease = match[4]
    ? match[4].split(".").map((part) => (/^\d+$/u.test(part) ? Number(part) : part))
    : [];
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function compareSemVer(left: SemVer, right: SemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0
        ? 1
        : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "number" && typeof rightPart === "string") return -1;
    if (typeof leftPart === "string" && typeof rightPart === "number") return 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

/** True for a normative SemVer at or above {@link DEEPSEEK_MINIMUM_VERSION}. */
export function isSupportedDeepSeekVersion(version: string): boolean {
  const parsed = parseSemVer(version);
  return parsed !== undefined && MINIMUM !== undefined && compareSemVer(parsed, MINIMUM) >= 0;
}

/** Session Format V4 rules, bound to the probed CLI version that native locators record. */
export interface DeepSeekModernProfile {
  readonly version: DeepSeekModernVersion;
  readonly checkpointPrefix: "v4-turn-end:";
  readonly matchesForkTail: (
    expectedPrefix: readonly ModernJournalEvent[],
    childEvents: readonly ModernJournalEvent[],
  ) => boolean;
  readonly snapshotKeys: readonly string[];
  readonly parseHeader: (value: unknown, expected: ModernJournalOpenRequest) => ModernJournalHeader;
  readonly parseHistoryRecord: (value: unknown, remainingEvents: number) => ModernJournalEvent[];
  readonly parseLiveItem: (value: unknown) => ModernJournalLiveItem;
  readonly parseAssistantBaseline: (value: unknown) => DeepSeekAssistantBaseline;
  readonly inheritedEventCount: (
    header: ModernJournalHeader,
    events: readonly ModernJournalEvent[],
  ) => number | undefined;
  readonly validateEvent: (event: ModernJournalEvent) => void;
  readonly validateContent: (value: unknown) => void;
  readonly validateChunk: (value: unknown) => void;
  readonly settlementUsage: (data: Record<string, unknown>) => unknown;
}

export function deepSeekModernProfile(version: DeepSeekModernVersion): DeepSeekModernProfile {
  return DEEPSEEK_V4_PROFILE.version === version
    ? DEEPSEEK_V4_PROFILE
    : Object.freeze({ ...DEEPSEEK_V4_PROFILE, version });
}
