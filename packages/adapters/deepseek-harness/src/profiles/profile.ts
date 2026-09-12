import type {
  ModernJournalEvent,
  ModernJournalHeader,
  ModernJournalOpenRequest,
  ModernJournalLiveItem,
} from "../modern/journal.js";
import type { DeepSeekV015AssistantBaseline } from "./v015.js";
import { DEEPSEEK_V012_PROFILE } from "./v012.js";
import { DEEPSEEK_V015_PROFILE } from "./v015.js";
export { DEEPSEEK_V012_PROFILE, DEEPSEEK_V015_PROFILE };

export type DeepSeekModernVersion = "0.1.2-rc.1" | "0.1.5-rc.1";

/** Selected once from the executable's exact version; no cross-profile fallback. */
export interface DeepSeekModernProfile {
  readonly version: DeepSeekModernVersion;
  readonly checkpointPrefix: "turn-end:" | "v3-turn-end:";
  readonly matchesForkTail: (
    expectedPrefix: readonly ModernJournalEvent[],
    childEvents: readonly ModernJournalEvent[],
  ) => boolean;
  readonly sessionFormatVersion: 0 | 3;
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
  if (version === "0.1.2-rc.1") return DEEPSEEK_V012_PROFILE;
  if (version === "0.1.5-rc.1") return DEEPSEEK_V015_PROFILE;
  throw new TypeError("DeepSeek Harness only supports 0.1.2-rc.1 and 0.1.5-rc.1");
}

export function isDeepSeekV015(profile: DeepSeekModernProfile): boolean {
  return profile.version === "0.1.5-rc.1";
}
