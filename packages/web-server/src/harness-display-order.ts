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
 * Official Codex leads when available; absent entries never lead.
 */
const WEB_LEADING_HARNESS = "codex";

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
    notInstalled?: Array<{ id: string; name: string; installUrl?: string }>;
  },
>(catalog: T, entries: HarnessDisplayEntries = []) {
  const notInstalled = catalog.notInstalled ?? [];
  const notInstalledIds = new Set(notInstalled.map((item) => item.id));
  const sectionByAgent = new Map(entries.map((entry) => [entry.agent, entry.section]));
  const ordered = leadingFirst(
    orderHarnessDisplay([...catalog.groups, ...catalog.failures, ...notInstalled], entries),
  );
  const rank = new Map(ordered.map((item, index) => [item.id, index]));
  const moreHarnesses = ordered
    .filter((item) => {
      if (item.id === WEB_LEADING_HARNESS) return false;
      const section = sectionByAgent.get(item.id);
      return section && section !== "auto" ? section === "more" : notInstalledIds.has(item.id);
    })
    .sort((a, b) => Number(notInstalledIds.has(a.id)) - Number(notInstalledIds.has(b.id)))
    .map((item) => item.id);
  const byRank = (a: { id: string }, b: { id: string }) =>
    (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity);
  return {
    ...catalog,
    groups: [...catalog.groups].sort(byRank) as T["groups"],
    failures: [...catalog.failures].sort(byRank) as T["failures"],
    ...(catalog.notInstalled === undefined
      ? {}
      : { notInstalled: [...notInstalled].sort(byRank) as T["notInstalled"] }),
    harnessOrder: ordered.map((item) => item.id),
    moreHarnesses,
  };
}
