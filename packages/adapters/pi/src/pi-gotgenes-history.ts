import type { HarnessResult, HostThreadSnapshot } from "@codexhost/harness-adapter";
import { activePiEntries, type PiSessionHistory } from "./pi-history.js";
import {
  gotgenesId,
  gotgenesRecord,
  gotgenesToolRecord,
  mergeGotgenesRecord,
  isRecord,
  type GotgenesRecord,
  type GotgenesSubagents,
} from "./pi-gotgenes-subagents.js";
import { childHistory } from "./pi-workflow-child-history.js";

/** Parent-owned receipts survive plugin reload and preserve the latest run of a resumed worker. */
export function gotgenesHistory(history: PiSessionHistory): GotgenesRecord[] {
  const records = new Map<string, GotgenesRecord>();
  for (const entry of activePiEntries(history)) {
    const message = entry.message;
    const parsed =
      entry.type === "custom" && entry.customType === "subagents:record"
        ? gotgenesRecord(entry.data)
        : isRecord(message) && message.role === "toolResult" && typeof message.toolName === "string"
          ? gotgenesToolRecord(message.toolName, message)
          : null;
    if (!parsed) continue;
    records.set(parsed.id, mergeGotgenesRecord(records.get(parsed.id), parsed));
  }
  return [...records.values()];
}
export function restoreGotgenes(history: PiSessionHistory, observer: GotgenesSubagents): void {
  observer.observe(gotgenesHistory(history), false);
}
export async function readGotgenesChild(
  history: PiSessionHistory,
  parentSessionId: string,
  id: string,
  live?: GotgenesRecord,
): Promise<HarnessResult<HostThreadSnapshot>> {
  const saved = gotgenesHistory(history).find((entry) => entry.id === id);
  const record = live?.outputFile ? live : saved;
  if (!record?.outputFile)
    return {
      ok: false,
      error: {
        code: "sessionNotFound",
        message: "Pi subagent has not published its Session transcript path",
        retryable: true,
      },
    };
  try {
    return {
      ok: true,
      value: await childHistory(record.outputFile, parentSessionId, gotgenesId(id), true),
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "unavailable",
        message: error instanceof Error ? error.message : "Pi child transcript unavailable",
        retryable: true,
      },
    };
  }
}
