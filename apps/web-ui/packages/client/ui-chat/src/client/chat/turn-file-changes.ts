/** Per-Turn file-change totals derived from settled edit/write results. */
import { useSyncExternalStore } from "react";
import { diffTotals, type DiffHunk } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ChatNodeStore } from "../contract/snapshot.ts";

/** One file's accumulated additions, removals and hunks. */
export interface FileChange {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  readonly hunks: readonly DiffHunk[];
}

const NO_FILES: readonly FileChange[] = [];
const EMPTY = { getSnapshot: () => undefined, subscribe: () => () => {} };

/**
 * Per path, the changes of the latest successful root call carrying
 * `meta.diffs`: the Host reports each file's cumulative changes, so later
 * calls supersede earlier ones instead of adding to them.
 * @param blocks - the Turn's root tool-call blocks, in order.
 * @returns one entry per path, first-seen order.
 */
export function fileChanges(blocks: readonly unknown[]): FileChange[] {
  const byPath = new Map<string, DiffHunk[]>();
  for (const block of blocks) {
    const { parentCallId, isError, meta } = block as {
      parentCallId?: unknown;
      isError?: boolean;
      meta?: { diffs?: unknown };
    };
    if (parentCallId !== undefined || isError === true || !Array.isArray(meta?.diffs)) continue;
    const latest = new Map<string, DiffHunk[]>();
    for (const hunk of meta.diffs as DiffHunk[]) {
      if (typeof hunk?.path !== "string") continue;
      latest.set(hunk.path, [...(latest.get(hunk.path) ?? []), hunk]);
    }
    for (const [path, hunks] of latest) byPath.set(path, hunks);
  }
  return [...byPath].map(([path, hunks]) => ({ path, ...diffTotals(hunks), hunks }));
}

/**
 * Observe one Turn's file changes; re-renders only when its tool calls change.
 * @param nodeStore - Chat node store.
 * @param turn - Turn number, or undefined before any Turn exists.
 * @returns the Turn's changed files.
 */
export function useTurnFileChanges(
  nodeStore: ChatNodeStore,
  turn: number | undefined,
): readonly FileChange[] {
  const source = turn === undefined ? EMPTY : nodeStore.turnDataSource(turn, "tool-call");
  const tools = useSyncExternalStore(source.subscribe, source.getSnapshot);
  // Cheap to recompute: the source array changes only with its members.
  return tools === undefined ? NO_FILES : fileChanges(tools.map((tool) => tool.root));
}

/** @param files - changed files. @returns the summed +/- across them. */
export function sumChanges(files: readonly FileChange[]): { added: number; removed: number } {
  return {
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
  };
}

/** @param path - a file path. @returns its last segment. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}
