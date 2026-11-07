/** Read the same machine-local presentation settings as Desktop; never write GUI state. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  harnessDisplayEntriesSchema,
  orderHarnessDisplay,
  type HarnessDisplayEntries,
} from "@codexhost/shared-contracts";

export async function readHarnessDisplayEntries(directory: string): Promise<HarnessDisplayEntries> {
  try {
    return harnessDisplayEntriesSchema.parse(
      JSON.parse(await readFile(join(directory, "harness-display-settings-v1.json"), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn("Harness display settings unavailable; using default order.");
    return [];
  }
}

/**
 * Web has no official Codex; the local Codex CLI takes the leading place Desktop gives it.
 * A Harness that is not installed is absent from the catalog and so never leads.
 */
const WEB_LEADING_HARNESS = "codex-cli";

function leadingFirst<T extends { id: string }>(items: readonly T[]): T[] {
  return [
    ...items.filter((item) => item.id === WEB_LEADING_HARNESS),
    ...items.filter((item) => item.id !== WEB_LEADING_HARNESS),
  ];
}

export function withHarnessDisplayOrder<
  T extends {
    groups: Array<{ id: string; name: string }>;
    failures: Array<{ id: string; name: string }>;
  },
>(catalog: T, entries: HarnessDisplayEntries = []) {
  const ordered = leadingFirst(
    orderHarnessDisplay([...catalog.groups, ...catalog.failures], entries),
  );
  const rank = new Map(ordered.map((item, index) => [item.id, index]));
  return {
    ...catalog,
    groups: [...catalog.groups].sort(
      (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity),
    ) as T["groups"],
    failures: [...catalog.failures].sort(
      (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity),
    ) as T["failures"],
    harnessOrder: ordered.map((item) => item.id),
  };
}
