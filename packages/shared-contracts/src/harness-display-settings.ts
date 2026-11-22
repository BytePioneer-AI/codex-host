import { z } from "zod";

export const HARNESS_DISPLAY_GET_METHOD = "codexhost/harness/display-settings/get";
export const HARNESS_DISPLAY_CHANGED_METHOD = "codexhost/harness/display-settings/changed";
export const HARNESS_DISPLAY_CAPABILITIES_METHOD =
  "codexhost/harness/display-settings/capabilities";
export const harnessDisplayCapabilitiesSchema = z.object({ events: z.boolean() });

export const HARNESS_DISPLAY_SET_METHOD = "codexhost/harness/display-settings/set";

/** Machine-local presentation only; never changes Harness availability or enablement. */
export const harnessDisplayEntriesSchema = z
  .array(
    z.strictObject({
      agent: z.string().min(1).max(128),
      section: z.enum(["main", "more", "auto"]),
    }),
  )
  .max(256)
  .refine(
    (entries) => new Set(entries.map((entry) => entry.agent)).size === entries.length,
    "Duplicate Harness IDs",
  );
export const harnessDisplaySettingsSchema = z.strictObject({
  entries: harnessDisplayEntriesSchema.nullable(),
});
export const harnessDisplayGetSchema = z.strictObject({});
export const harnessDisplaySetSchema = z.strictObject({
  entries: harnessDisplayEntriesSchema,
  /** Import legacy Desktop preferences only if no shared settings exist yet. */
  initializeOnly: z.boolean().optional(),
});
export type HarnessDisplayEntries = z.infer<typeof harnessDisplayEntriesSchema>;
export type HarnessDisplaySettings = z.infer<typeof harnessDisplaySettingsSchema>;
export type HarnessDisplaySet = z.infer<typeof harnessDisplaySetSchema>;

/** Display preference only; this order never registers or enables a Harness. */
export const DEFAULT_HARNESS_DISPLAY_ORDER: readonly string[] = [
  "pi",
  "claude-code",
  "deepseek-harness",
  "opencode",
  "grok",
  "omp",
  "antigravity",
  "kiro-cli",
  "codebuddy",
  "workbuddy",
  "cursor-cli",
  "hermes",
  "qoder",
  "qoder-cn",
  "kimi-code",
  "zcode",
];

/** Codex is pinned first; saved Main/More order precedes missing catalog entries. */
export function orderHarnessDisplay<T extends { readonly id: string; readonly name: string }>(
  catalog: readonly T[],
  entries: HarnessDisplayEntries = [],
): T[] {
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const recorded = new Set(entries.map((entry) => entry.agent));
  const ranks = new Map(DEFAULT_HARNESS_DISPLAY_ORDER.map((id, rank) => [id, rank]));
  const missing = catalog
    .filter((item) => item.id !== "codex" && !recorded.has(item.id))
    .toSorted(
      (a, b) =>
        (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
  const all = [
    ...entries,
    ...missing.map((item) => ({ agent: item.id, section: "auto" as const })),
  ];
  const ordered = all
    .filter((entry) => entry.agent !== "codex" && byId.has(entry.agent))
    .toSorted((a, b) => Number(a.section === "more") - Number(b.section === "more"));
  const codex = byId.get("codex");
  return [
    ...(codex ? [codex] : []),
    ...ordered.flatMap((entry) => {
      const item = byId.get(entry.agent);
      return item ? [item] : [];
    }),
  ];
}
