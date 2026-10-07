import type {
  HarnessPluginContext,
  HarnessUsageStatisticsAdapter,
} from "@codexhost/harness-adapter/plugin";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import { createCodexUsageStatistics } from "./usage-statistics.js";

/** No inspect/open/warmup: native Codex session operations remain owned by Codex. */
export function createUsageStatisticsAdapter(
  context: HarnessPluginContext,
): HarnessUsageStatisticsAdapter {
  const abort = new AbortController();
  const reader = createCodexUsageStatistics(context.environment);
  return {
    harnessId: harnessIdSchema.parse("codex-usage"),
    usageStatistics: {
      listSources: (signal) => reader.listSources(AbortSignal.any([signal, abort.signal])),
      readSource: (id, signal) => reader.readSource(id, AbortSignal.any([signal, abort.signal])),
    },
    close: async () => {
      abort.abort();
    },
  };
}
