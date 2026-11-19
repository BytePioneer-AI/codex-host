/** Compact cumulative file summaries, using the same bounded line comparison as DiffBlock. */
import { createHash } from "node:crypto";
import { structuredPatch } from "diff";
import type { WebFileDiff, WebTurnFileSummary } from "@codexhost/shared-contracts";

function contentLines(text: string): string[] {
  if (text === "") return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

export function summarizeTurnDiffs(
  diffs: readonly WebFileDiff[],
  previous: readonly WebTurnFileSummary[] = [],
): WebTurnFileSummary[] {
  const files = new Map<string, WebFileDiff[]>();
  for (const diff of diffs) {
    const hunks = files.get(diff.path);
    if (hunks) hunks.push(diff);
    else files.set(diff.path, [diff]);
  }
  const previousByPath = new Map(previous.map((file) => [file.path, file]));
  return [...files].map(([path, hunks]) => {
    const revision = createHash("sha256").update(JSON.stringify(hunks)).digest("hex").slice(0, 16);
    const held = previousByPath.get(path);
    if (held?.revision === revision) return held;
    let added = 0;
    let removed = 0;
    for (const diff of hunks) {
      const oldLines = contentLines(diff.oldText ?? "");
      const newLines = contentLines(diff.newText);
      const normalize = (lines: string[]) => lines.map((line) => `${line}\n`).join("");
      const patches = structuredPatch(
        "",
        "",
        normalize(oldLines),
        normalize(newLines),
        undefined,
        undefined,
        {
          context: 3,
          maxEditLength: 256,
        },
      )?.hunks ?? [
        { lines: [...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)] },
      ];
      for (const patch of patches)
        for (const line of patch.lines) {
          if (line.startsWith("+")) added++;
          if (line.startsWith("-")) removed++;
        }
    }
    return { path, added, removed, revision };
  });
}
