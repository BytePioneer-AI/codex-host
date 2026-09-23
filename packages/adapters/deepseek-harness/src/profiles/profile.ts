import type {
  ModernJournalEvent,
  ModernJournalHeader,
  ModernJournalOpenRequest,
  ModernJournalLiveItem,
} from "../modern/journal.js";
import type { DeepSeekV015AssistantBaseline } from "./v015.js";
import { DEEPSEEK_V012_PROFILE } from "./v012.js";
import { DEEPSEEK_V015_PROFILE } from "./v015.js";
import { DEEPSEEK_V017_PROFILE } from "./v017.js";
export { DEEPSEEK_V012_PROFILE, DEEPSEEK_V015_PROFILE, DEEPSEEK_V017_PROFILE };

export type DeepSeekModernVersion = string;

/** Selected once from the executable version; native V0/V3 records remain strictly validated. */
export interface DeepSeekModernProfile {
  readonly version: DeepSeekModernVersion;
  readonly checkpointPrefix: "turn-end:" | "v3-turn-end:" | "v4-turn-end:";
  readonly matchesForkTail: (
    expectedPrefix: readonly ModernJournalEvent[],
    childEvents: readonly ModernJournalEvent[],
  ) => boolean;
  readonly sessionFormatVersion: 0 | 3 | 4;
  readonly assistantStream: boolean;
  readonly snapshotKeys: readonly string[];
  readonly parseHeader: (value: unknown, expected: ModernJournalOpenRequest) => ModernJournalHeader;
  readonly parseHistoryRecord: (value: unknown, remainingEvents: number) => ModernJournalEvent[];
  readonly parseLiveItem: (value: unknown) => ModernJournalLiveItem;
  readonly parseAssistantBaseline?: (value: unknown) => DeepSeekV015AssistantBaseline;
  readonly inheritedEventCount: (
    header: ModernJournalHeader,
    events: readonly ModernJournalEvent[],
  ) => number | undefined;
  readonly validateEvent: (event: ModernJournalEvent) => void;
  readonly validateContent: (value: unknown) => void;
  readonly validateChunk: (value: unknown) => void;
  readonly settlementUsage?: (data: Record<string, unknown>) => unknown;
}

export function deepSeekModernProfile(version: DeepSeekModernVersion): DeepSeekModernProfile {
  // Only the verified V4 tag selects V4; other unknown versions retain strict V3 admission.
  const base = /^0\.1\.2(?:-|\+|$)/u.test(version)
    ? DEEPSEEK_V012_PROFILE
    : version === "0.1.7-rc.1"
      ? DEEPSEEK_V017_PROFILE
      : DEEPSEEK_V015_PROFILE;
  return base.version === version ? base : Object.freeze({ ...base, version });
}

export function isDeepSeekV015(profile: DeepSeekModernProfile): boolean {
  return profile.sessionFormatVersion === 3;
}

export function hasDeepSeekModernStream(profile: DeepSeekModernProfile): boolean {
  return profile.sessionFormatVersion >= 3;
}
