import { createTwoFilesPatch } from "diff";
import type { HostFileChange, HostToolOutput } from "@codexhost/harness-adapter";
import type { ToolCallUpdate } from "@agentclientprotocol/sdk";

const MAX_DIFF_BYTES = 1024 * 1024;
const MAX_DIFFS = 32;

/** Hermes also converts hunk snippets to ACP oldText/newText, losing file coordinates. */
export function hermesFileChanges(update: ToolCallUpdate): HostFileChange[] {
  const changes: HostFileChange[] = [];
  let bytes = 0;
  for (const block of update.content ?? []) {
    if (block.type !== "diff") continue;
    const { path, oldText, newText } = block;
    if (!path.trim() || /[\0\r\n]/u.test(path) || typeof newText !== "string") continue;
    if (oldText === newText) continue;
    bytes += Buffer.byteLength(oldText ?? "") + Buffer.byteLength(newText);
    if (bytes > MAX_DIFF_BYTES || changes.length === MAX_DIFFS) return [];
    // A missing oldText may mean a fragment with no removed lines, not a new file.
    changes.push({
      path,
      kind: "update",
      diffScope: "fragment",
      unifiedDiff: createTwoFilesPatch(path, path, oldText ?? "", newText, "", "", {
        context: 3,
      }),
    });
  }
  return changes;
}

export function hermesToolOutput(update: ToolCallUpdate): HostToolOutput | null {
  const content: HostToolOutput["content"] = [];
  for (const block of update.content ?? []) {
    if (block.type !== "content") continue;
    if (block.content.type === "text" && block.content.text) {
      content.push({ type: "text", text: block.content.text });
    } else if (block.content.type === "image") {
      content.push({
        type: "image",
        mimeType: block.content.mimeType,
        base64Data: block.content.data,
      });
    }
  }
  if (!content.length && typeof update.rawOutput === "string" && update.rawOutput) {
    content.push({ type: "text", text: update.rawOutput });
  }
  return content.length ? { content } : null;
}
