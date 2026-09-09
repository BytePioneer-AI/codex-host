import { createTwoFilesPatch } from "diff";
import type { HostFileChange } from "@codexhost/harness-adapter";

function header(path: string, side: "a" | "b"): string {
  return path.startsWith("/") || /^[A-Za-z]:\//u.test(path) ? path : `${side}/${path}`;
}

function mergeGroup(group: readonly HostFileChange[]): HostFileChange[] {
  const first = group[0];
  if (!first || group.length === 1) return first ? [first] : [];
  const snapshots = group.map(({ snapshot }) => snapshot);
  if (snapshots.some((snapshot) => snapshot === undefined)) return [...group];

  const before = snapshots[0]?.before ?? null;
  let after = before;
  for (const snapshot of snapshots) {
    if (!snapshot || snapshot.before !== after) return [...group];
    after = snapshot.after;
  }
  if (before === after) return [];

  const kind = before === null ? "add" : after === null ? "delete" : "update";
  const oldHeader = kind === "add" ? "/dev/null" : header(first.path, "a");
  const newHeader = kind === "delete" ? "/dev/null" : header(first.path, "b");
  return [
    {
      path: first.path,
      kind,
      unifiedDiff: createTwoFilesPatch(oldHeader, newHeader, before ?? "", after ?? "", "", "", {
        context: 3,
      }),
      snapshot: { before, after },
    },
  ];
}

/** Collapses only continuous, complete native states into a true Turn-level net diff. */
export function mergeFileChangesByPath(changes: readonly HostFileChange[]): HostFileChange[] {
  const groups = new Map<string, HostFileChange[]>();
  for (const change of changes) {
    const group = groups.get(change.path);
    if (group) group.push(change);
    else groups.set(change.path, [change]);
  }
  return [...groups.values()].flatMap(mergeGroup);
}
