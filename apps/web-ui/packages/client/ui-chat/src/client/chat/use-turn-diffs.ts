/** Expansion-owned full diffs; summaries remain the only eagerly retained data. */
import { useEffect, useState } from "react";
import type { DiffHunk } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ChatViewInjected } from "../contract/slots.ts";
import type { FileChange } from "./turn-file-changes.ts";

export function useTurnDiffs(
  turn: number,
  files: readonly FileChange[],
  expandedPaths: ReadonlySet<string>,
  load: ChatViewInjected["loadTurnDiffs"],
) {
  const [loaded, setLoaded] = useState<
    Readonly<Record<string, { revision: string; diffs: readonly DiffHunk[] }>>
  >({});
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const wanted = JSON.stringify(
    files
      .filter((file) => expandedPaths.has(file.path) && file.hunks === undefined)
      .map((file) => [file.path, file.revision]),
  );
  useEffect(() => {
    const targets = (JSON.parse(wanted) as Array<[string, string]>).filter(
      ([path, revision]) => loaded[path]?.revision !== revision,
    );
    if (!load || targets.length === 0) return;
    let active = true;
    setError(undefined);
    void Promise.all(
      targets.map(
        async ([path, revision]) =>
          [
            path,
            { revision, diffs: (await load(turn, path)).filter((diff) => diff.path === path) },
          ] as const,
      ),
    ).then(
      (files) => {
        if (!active) return;
        setLoaded((held) => ({ ...held, ...Object.fromEntries(files) }));
      },
      (cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [turn, wanted, load, loaded, retry]);
  return {
    diffs: (file: FileChange) =>
      file.hunks ??
      (loaded[file.path]?.revision === file.revision ? loaded[file.path]?.diffs : undefined),
    error,
    retry: () => setRetry((value) => value + 1),
  };
}
