import type { JsonObject } from "@codexhost/protocol-core";
import { officialThreadListPageFromResponse } from "./thread-list-aggregator.js";

interface NativeArchiveConfirmationInput {
  threadId: string;
  isNativeOwner(): Promise<boolean>;
  initializeOfficial(): Promise<void>;
  currentGeneration(): number | null;
  requestOfficial(params: JsonObject): Promise<JsonObject>;
}

/** A bounded native-only read. Absence, failure and exhausted budgets all remain unknown. */
export async function confirmNativeThreadArchived(
  input: NativeArchiveConfirmationInput,
): Promise<{ confirmed: boolean }> {
  const deadline = Date.now() + 10_000;
  let generation: number | null = null;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const withinBudget = (): boolean => active && Date.now() < deadline;
  const read = async (): Promise<boolean> => {
    if (!(await input.isNativeOwner()) || !withinBudget()) return false;
    await input.initializeOfficial();
    if (!withinBudget()) return false;
    generation = input.currentGeneration();
    if (generation === null) return false;
    const current = (): boolean => withinBudget() && input.currentGeneration() === generation;
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      if (!current()) return false;
      const response = await input.requestOfficial({ archived: true, limit: 100, cursor });
      if (!current()) return false;
      const result = officialThreadListPageFromResponse(response);
      if (result.data.some((thread) => thread.id === input.threadId)) return true;
      cursor = result.nextCursor;
      if (cursor === null || seen.has(cursor)) return false;
      seen.add(cursor);
    }
    return false;
  };
  try {
    const expired = Promise.withResolvers<false>();
    timer = setTimeout(() => {
      active = false;
      expired.resolve(false);
    }, 10_000);
    // The losing read stays observed, and checks `active` before doing any more work.
    const confirmed = await Promise.race([read().catch(() => false), expired.promise]);
    return {
      confirmed: confirmed && withinBudget() && input.currentGeneration() === generation,
    };
  } finally {
    active = false;
    clearTimeout(timer);
  }
}
