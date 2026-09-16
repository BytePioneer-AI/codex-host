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

export type DeepSeekModernVersion = "0.1.2-rc.1" | "0.1.5-rc.1" | "0.1.5-rc.2";

/**
 * 0.1.5-rc.2 only refines the DSH Web client UI on top of rc.1, so it reuses the
 * exact V015 journal/Remote semantics while keeping its own executable version
 * for checkpoint and session locators.
 */
const DEEPSEEK_V015_RC2_PROFILE = Object.freeze<DeepSeekModernProfile>({
  ...DEEPSEEK_V015_PROFILE,
  version: "0.1.5-rc.2",
});

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
  if (version === "0.1.5-rc.2") return DEEPSEEK_V015_RC2_PROFILE;
  throw new TypeError("DeepSeek Harness only supports 0.1.2-rc.1, 0.1.5-rc.1 and 0.1.5-rc.2");
}

export function isDeepSeekV015Version(version: DeepSeekModernVersion): boolean {
  return version === "0.1.5-rc.1" || version === "0.1.5-rc.2";
}

export function isDeepSeekV015(profile: DeepSeekModernProfile): boolean {
  return isDeepSeekV015Version(profile.version);
}
