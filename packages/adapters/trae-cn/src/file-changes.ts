import type { HostFileChange, HostFileChangeItem } from "@codexhost/harness-adapter";
import { hostItemIdSchema } from "@codexhost/shared-contracts";
import { createTwoFilesPatch } from "diff";
import { record, TraeError } from "./errors.js";

export function hasFileEditHistory(value: unknown): boolean {
  return (
    record(value) &&
    Array.isArray(value.items) &&
    value.items.some((item) => record(item) && item.fileDiffs !== undefined)
  );
}

/** A message snapshot is the complete native before/after image, not a tool preview. */
export function projectFileChanges(
  message: Record<string, unknown>,
): HostFileChangeItem | undefined {
  if (message.fileDiffs === undefined) return undefined;
  if (
    !Array.isArray(message.fileDiffs) ||
    !Array.isArray(message.fileDiffSourceIds) ||
    !message.fileDiffSourceIds.every((id) => typeof id === "string" && id.trim())
  )
    throw new TraeError("protocolError", "Invalid native file diff identities");
  const changes = message.fileDiffs.map((diff) => {
    if (
      !record(diff) ||
      typeof diff.file_path !== "string" ||
      !diff.file_path.trim() ||
      typeof diff.before_content !== "string" ||
      typeof diff.after_content !== "string"
    )
      throw new TraeError("protocolError", "Native file diff lacks complete contents");
    const kind: HostFileChange["kind"] | undefined =
      diff.file_action === "added"
        ? "add"
        : diff.file_action === "modified"
          ? "update"
          : diff.file_action === "deleted"
            ? "delete"
            : undefined;
    if (!kind) throw new TraeError("unsupported", "Unknown native file action");
    const path = diff.file_path.replaceAll("\\", "/");
    return {
      path,
      kind,
      unifiedDiff: createTwoFilesPatch(
        kind === "add" ? "/dev/null" : path,
        kind === "delete" ? "/dev/null" : path,
        diff.before_content,
        diff.after_content,
        "",
        "",
        { context: 3 },
      ),
    };
  });
  if (!changes.length) return undefined;
  if (typeof message.message_id !== "string" || !message.message_id)
    throw new TraeError("protocolError", "Native file diff has no assistant message identity");
  return {
    type: "fileChange",
    itemId: hostItemIdSchema.parse(`${message.message_id}.files`),
    changes,
    sourceItemIds: message.fileDiffSourceIds.map((id) => hostItemIdSchema.parse(`${id}.tool`)),
  };
}
