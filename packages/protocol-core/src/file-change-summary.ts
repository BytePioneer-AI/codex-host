import path from "node:path";
import { diffArrays, formatPatch, parsePatch, type StructuredPatch } from "diff";
import type { HostFileChange } from "@codexhost/harness-adapter";

export function filePathKey(file: string, cwd: string): string {
  const windows = /^[a-z]:[/\\]/i.test(cwd) || /^[a-z]:[/\\]/i.test(file);
  const paths = windows ? path.win32 : path.posix;
  const resolved = paths.resolve(cwd, file).replaceAll("\\", "/");
  return windows ? resolved.toLowerCase() : resolved;
}

// Unknown, unchanged lines retain their identity. Only lines supplied by native
// patches acquire text; no filesystem snapshot or invented context is needed.
interface Line {
  text?: string;
}

function composePatches(changes: HostFileChange[]): StructuredPatch["hunks"] | null {
  if (changes.some((change) => change.diffScope === "fragment")) return null;
  const original: Line[] = [];
  const current: Line[] = [];
  for (const change of changes) {
    let patches: StructuredPatch[];
    try {
      patches = parsePatch(change.unifiedDiff);
    } catch {
      return null;
    }
    const [patch] = patches;
    if (!patch || patches.length !== 1) return null;
    const hunks = patch.hunks;
    for (const hunk of [...hunks].reverse()) {
      const start = hunk.oldStart - 1;
      while (current.length < start + hunk.oldLines) {
        const line: Line = {};
        original.push(line);
        current.push(line);
      }
      const replacement: Line[] = [];
      let offset = start;
      for (const [i, entry] of hunk.lines.entries()) {
        const operation = entry[0];
        if (operation === "\\") continue;
        const text = entry.slice(1) + (hunk.lines[i + 1]?.startsWith("\\") ? "" : "\n");
        if (operation === "+") replacement.push({ text });
        else {
          const line = current[offset++];
          if (!line || (line.text !== undefined && line.text !== text)) return null;
          line.text = text;
          if (operation === " ") replacement.push(line);
        }
      }
      current.splice(start, hunk.oldLines, ...replacement);
    }
  }
  const hunks: StructuredPatch["hunks"] = [];
  let oldStart = 1;
  let newStart = 1;
  let hunk: StructuredPatch["hunks"][number] | undefined;
  for (const part of diffArrays(original, current, {
    comparator: (a, b) => a === b || (a.text !== undefined && a.text === b.text),
  })) {
    if (!part.added && !part.removed) {
      hunk = undefined;
      oldStart += part.count;
      newStart += part.count;
      continue;
    }
    if (!hunk) {
      hunk = { oldStart, newStart, oldLines: 0, newLines: 0, lines: [] };
      hunks.push(hunk);
    }
    for (const line of part.value) {
      const text = line.text;
      if (text === undefined) return null;
      hunk.lines.push((part.added ? "+" : "-") + text.replace(/\n$/, ""));
      if (!text.endsWith("\n")) hunk.lines.push("\\ No newline at end of file");
    }
    if (part.added) {
      hunk.newLines += part.count;
      newStart += part.count;
    } else {
      hunk.oldLines += part.count;
      oldStart += part.count;
    }
  }
  return hunks;
}

/** One display entry per path; never treat unrelated local fragments as snapshots. */
export function summarizeFileChanges(changes: HostFileChange[], cwd: string): HostFileChange[] {
  const groups = new Map<string, [HostFileChange, ...HostFileChange[]]>();
  for (const change of changes) {
    const key = filePathKey(change.path, cwd);
    const group = groups.get(key);
    if (group) group.push(change);
    else groups.set(key, [change]);
  }
  return [...groups.values()].flatMap((group) => {
    const first = group[0];
    if (group.length === 1) return [first];
    const last = group.at(-1) ?? first;
    const hunks = composePatches(group);
    const kind = last.kind === "delete" ? "delete" : first.kind === "add" ? "add" : "update";
    if (hunks) {
      if (hunks.length === 0 && (first.kind !== "add") === (last.kind !== "delete")) return [];
      return [
        {
          path: first.path,
          kind,
          unifiedDiff: formatPatch({
            oldFileName: first.kind === "add" ? "/dev/null" : `a/${first.path}`,
            newFileName: last.kind === "delete" ? "/dev/null" : `b/${first.path}`,
            oldHeader: "",
            newHeader: "",
            hunks,
          }),
        },
      ];
    }
    // Fragments without a common coordinate system cannot yield a net patch.
    // Keep their original content, grouped under one file, rather than dropping edits.
    const bodies = group.map(({ unifiedDiff }) => {
      const start = unifiedDiff.indexOf("@@");
      return start < 0 ? unifiedDiff : unifiedDiff.slice(start);
    });
    const headerEnd = first.unifiedDiff.indexOf("@@");
    const header = headerEnd < 0 ? "" : first.unifiedDiff.slice(0, headerEnd);
    return [
      {
        path: first.path,
        kind,
        unifiedDiff: header + bodies.join("\n"),
        diffScope: "fragment" as const,
      },
    ];
  });
}
