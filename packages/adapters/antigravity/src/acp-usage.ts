import type { HostUsage, HostUsageRequest } from "@codexhost/harness-adapter";

import type { AntigravityPromptUsage } from "./acp-types.js";

export interface AntigravitySessionUsageTrackerOptions {
  nativeSessionId: string;
  homedir: string;
  initialContextUsedTokens?: number;
  initialContextWindowTokens?: number;
}

export function normalizeAntigravityUsageModel(rawModel: unknown): {
  model?: string;
  provider?: string;
} {
  if (typeof rawModel !== "string" || !rawModel.trim()) return {};
  return { model: rawModel.trim() };
}

export class AntigravitySessionUsageTracker {
  constructor(_options: AntigravitySessionUsageTrackerOptions) {}

  currentUsage(): HostUsage | null {
    return null;
  }

  recordContextWindow(_used: number, _size: number): HostUsage | null {
    throw new Error("AntigravitySessionUsageTracker stub");
  }

  recordTurnPromptUsage(_input: {
    usage?: AntigravityPromptUsage;
    model?: string;
    firstOutputAtMs?: number;
    completedAtMs?: number;
  }): {
    usage: HostUsage | null;
    fallbackRequest?: HostUsageRequest;
  } {
    throw new Error("AntigravitySessionUsageTracker stub");
  }

  async replayHistoricalRequests(_signal?: AbortSignal): Promise<{
    requests: HostUsageRequest[];
    complete: boolean;
    usage: HostUsage | null;
  }> {
    throw new Error("AntigravitySessionUsageTracker stub");
  }

  async collectNewTranscriptRequests(_input?: {
    firstOutputAtMs?: number;
    completedAtMs?: number;
    signal?: AbortSignal;
  }): Promise<{
    requests: HostUsageRequest[];
    complete: boolean;
    usage: HostUsage | null;
  }> {
    throw new Error("AntigravitySessionUsageTracker stub");
  }
}
