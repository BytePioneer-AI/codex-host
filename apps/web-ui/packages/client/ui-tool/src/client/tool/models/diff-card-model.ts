/** Pure diff-card derivation from raw file-mutation calls and result metadata. @module */
import type { DiffBlockProps, DiffHunk } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ToolCallBlock } from "./tool-call-model.ts";
import { parsedToolCall } from "./raw-tool-call.ts";

/** Room for a path, one removed/added pair, and three context lines on each side. */
export const CHAT_DIFF_MAX_LINES = 9;

/**
 * The {@link DiffBlock} props this derivation owns. Picked off the primitive's
 * props so the two stay in step; `maxLines`/`className` belong to each render
 * site.
 */
export interface DiffCardModel {
  /**
   * The props {@link DiffBlock} draws. Held as a nested object so a render site
   * spreads exactly the primitive's own surface and can never leak a
   * neighbouring field into it.
   */
  card: Pick<DiffBlockProps, "diffs">;
}

/**
 * Narrow opaque result metadata's `diffs` to well-formed hunks.
 * @param diffs - the metadata field to validate.
 * @returns the validated hunks, or null when the payload is not usable.
 */
function narrowDiffs(diffs: unknown): DiffHunk[] | null {
  if (!Array.isArray(diffs) || diffs.length === 0) return null;
  const out: DiffHunk[] = [];
  for (const hunk of diffs) {
    if (typeof hunk !== "object" || hunk === null) return null;
    const { path, oldText, newText } = hunk as Record<string, unknown>;
    if (typeof path !== "string") return null;
    if (oldText !== null && typeof oldText !== "string") return null;
    if (typeof newText !== "string") return null;
    out.push({ path, oldText, newText });
  }
  return out;
}

type IntendedDiff = { tool: "write" | "edit" | "str_replace_editor"; diff: DiffHunk };

function intendedDiff(block: ToolCallBlock): IntendedDiff | null {
  const parsed = parsedToolCall(block);
  if (parsed === null) return null;
  if (parsed.name === "str_replace_editor") {
    const { command, path, file_text: fileText, old_str: oldText, new_str: newText } = parsed.args;
    if (typeof path !== "string" || path.trim() === "") return null;
    if (command === "create") {
      if (fileText !== undefined && typeof fileText !== "string") return null;
      return {
        tool: "str_replace_editor",
        diff: { path, oldText: null, newText: fileText ?? "" },
      };
    }
    if (command === "str_replace") {
      if (oldText !== undefined && typeof oldText !== "string") return null;
      if (newText !== undefined && typeof newText !== "string") return null;
      return {
        tool: "str_replace_editor",
        diff: { path, oldText: oldText ?? null, newText: newText ?? "" },
      };
    }
    return null;
  }
  const path = typeof parsed.args.file_path === "string" ? parsed.args.file_path : parsed.args.path;
  if (typeof path !== "string" || path.trim() === "") return null;
  if (parsed.name === "write") {
    const { content } = parsed.args;
    return typeof content === "string"
      ? { tool: "write", diff: { path, oldText: null, newText: content } }
      : null;
  }
  if (parsed.name !== "edit") return null;
  const { old_string: oldText, new_string: newText, replace_all: replaceAll } = parsed.args;
  if (typeof oldText !== "string" || typeof newText !== "string") return null;
  if (replaceAll !== undefined && typeof replaceAll !== "boolean") return null;
  return { tool: "edit", diff: { path, oldText: oldText || null, newText } };
}

function hunkFromFileArg(value: unknown): DiffHunk | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const path =
    typeof record.path === "string"
      ? record.path
      : typeof record.file_path === "string"
        ? record.file_path
        : "";
  if (path.trim() === "") return null;
  if (
    record.kind === "add" ||
    (typeof record.content === "string" && record.old_string === undefined)
  ) {
    const newText =
      typeof record.content === "string"
        ? record.content
        : typeof record.new_string === "string"
          ? record.new_string
          : "";
    return { path, oldText: null, newText };
  }
  if (typeof record.old_string === "string" && typeof record.new_string === "string") {
    return { path, oldText: record.old_string || null, newText: record.new_string };
  }
  return null;
}

function intendedHunks(
  block: ToolCallBlock,
): { tool: "write" | "edit" | "str_replace_editor"; diffs: DiffHunk[] } | null {
  const parsed = parsedToolCall(block);
  if (parsed === null) return null;
  if (parsed.name === "str_replace_editor") {
    const intended = intendedDiff(block);
    return intended === null ? null : { tool: intended.tool, diffs: [intended.diff] };
  }
  if (parsed.name !== "edit" && parsed.name !== "write") return null;
  if (Array.isArray(parsed.args.files) && parsed.args.files.length > 0) {
    const diffs: DiffHunk[] = [];
    for (const file of parsed.args.files) {
      const hunk = hunkFromFileArg(file);
      if (hunk === null) return null;
      diffs.push(hunk);
    }
    return { tool: parsed.name, diffs };
  }
  const intended = intendedDiff(block);
  return intended === null ? null : { tool: intended.tool, diffs: [intended.diff] };
}

function appliedDiffs(meta: unknown): DiffHunk[] | "empty" | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const diffs = (meta as Record<string, unknown>).diffs;
  if (!Array.isArray(diffs)) return null;
  if (diffs.length === 0) return "empty";
  return narrowDiffs(diffs);
}

/**
 * Derive running diffs for root write/edit and `str_replace_editor`
 * create/replace calls, plus applied settled diffs from result metadata.
 * Settled `meta.diffs` render even when the call arguments were incomplete.
 * A successful write with valid empty metadata uses its argument-derived
 * whole-file diff, matching create and identical-overwrite presentation;
 * `str_replace_editor` settles through Generic because it has no result view.
 * @param block - running or settled Tool block.
 * @returns the diff-card props, or null for the generic path.
 */
export function diffCardModel(block: ToolCallBlock): DiffCardModel | null {
  if (block.parentCallId !== undefined) return null;
  const intended = intendedHunks(block);
  if (!("kind" in block)) return intended === null ? null : { card: { diffs: intended.diffs } };
  if (intended?.tool === "str_replace_editor") return null;
  if (block.isError) return null;
  const applied = appliedDiffs(block.meta);
  if (applied !== null && applied !== "empty") return { card: { diffs: applied } };
  if (intended === null) return null;
  return intended.tool === "write" ? { card: { diffs: intended.diffs } } : null;
}
