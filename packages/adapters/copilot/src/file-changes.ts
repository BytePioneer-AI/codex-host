import type { SessionEvent } from "@github/copilot-sdk";
import type { HostFileChange } from "@codexhost/harness-adapter";

type Completion = Extract<SessionEvent, { type: "tool.execution_complete" }>["data"];

/** Only pair a native committed mutation with its own native unified diff. */
export function nativeFileChanges(data: Completion): HostFileChange[] {
  const diff = data.result?.detailedContent;
  if (!diff || diff.length > 256 * 1024 || !data.fileEdits?.length) return [];
  const edits = [...data.fileEdits];
  const changes: HostFileChange[] = [];
  const canonical = (value: string) => value.replaceAll("\\", "/").replace(/^\/+/, "");
  for (const section of diff.trimStart().split(/(?=^diff --git )/mu)) {
    if (
      !section.startsWith("diff --git ") ||
      !/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/mu.test(section)
    )
      continue;
    const oldPath = section.match(/^--- a\/(.+)$/mu)?.[1];
    const newPath = section.match(/^\+\+\+ b\/(.+)$/mu)?.[1];
    const index = edits.findIndex((edit) => {
      const header = edit.kind === "delete" ? oldPath : newPath;
      return header !== undefined && canonical(header) === canonical(edit.path);
    });
    const edit = edits[index];
    if (!edit || !["create", "edit", "delete"].includes(edit.kind)) continue;
    edits.splice(index, 1);
    changes.push({
      path: edit.path,
      kind: edit.kind === "create" ? "add" : edit.kind === "delete" ? "delete" : "update",
      unifiedDiff: section,
    });
  }
  return changes;
}
