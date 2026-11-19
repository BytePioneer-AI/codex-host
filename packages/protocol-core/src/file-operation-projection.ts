import type { HostItem, HostItemOutcome } from "@codexhost/harness-adapter";
import type { JsonObject } from "@codexhost/shared-contracts";

export function isFileMutatingTool(toolName: string): boolean {
  return [
    "edit",
    "editfile",
    "fileedit",
    "strreplace",
    "searchreplace",
    "applypatch",
    "replace",
    "multiedit",
    "write",
    "writefile",
    "filewrite",
    "create",
    "createfile",
  ].includes(toolName.toLowerCase().replaceAll(/[_-]/g, ""));
}

interface FileOperationEntry {
  item: HostItem;
  outcome: HostItemOutcome | null;
}

/** Preserve actual file operations alongside Desktop's single cumulative file card.
 * Anchors refer to non-file Items, so clients can restore the original transcript order.
 */
export function projectFileOperations(
  entries: readonly FileOperationEntry[],
  visibleItems: readonly JsonObject[],
  project: (entry: FileOperationEntry) => JsonObject,
): JsonObject[] {
  const tools = new Set(
    entries.flatMap(({ item }) =>
      item.type === "toolExecution" && isFileMutatingTool(item.toolName) ? [item.itemId] : [],
    ),
  );
  const visible = new Set(visibleItems.map((item) => item.id));
  const operations: JsonObject[] = [];
  let beforeItemId: string | null = null;
  for (const entry of [...entries].reverse()) {
    const { item, outcome } = entry;
    // A native patch linked to an already represented call contributes to the
    // cumulative diff, not a second invocation in the transcript.
    if (
      item.type === "fileChange" &&
      item.sourceItemIds?.length &&
      item.sourceItemIds.every((id) => tools.has(id))
    )
      continue;
    const projected = project(entry);
    if (item.type === "fileChange" || tools.has(item.itemId)) {
      if (outcome?.status === "cancelled") projected.status = "interrupted";
      if (outcome?.status === "failed") projected.error = { message: outcome.error.message };
      if (outcome?.status === "cancelled" && outcome.reason)
        projected.error = { message: outcome.reason };
      operations.push({ beforeItemId, item: projected });
    } else if (typeof projected.id === "string" && visible.has(projected.id)) {
      beforeItemId = projected.id;
    }
  }
  return operations.reverse();
}
