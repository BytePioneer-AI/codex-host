import { open, realpath } from "node:fs/promises";
import path from "node:path";

const MAX_METADATA_BYTES = 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Read only bounded session metadata, never transcript text or a client-supplied path. */
export async function nativeThreadSupportsReferences(input: {
  codexHome: string;
  threadId: string;
  readThread(): Promise<unknown>;
}): Promise<boolean> {
  try {
    const response = await input.readThread();
    const result = record(response) && record(response.result) ? response.result : null;
    const thread = result && record(result.thread) ? result.thread : null;
    if (thread?.id !== input.threadId || typeof thread.path !== "string") return false;
    const rollout = await realpath(thread.path);
    let allowed = false;
    for (const directory of ["sessions", "archived_sessions"]) {
      const root = await realpath(path.join(input.codexHome, directory)).catch(() => null);
      if (root === null) continue;
      const relative = path.relative(root, rollout);
      if (
        relative &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      ) {
        allowed = true;
        break;
      }
    }
    if (!allowed) return false;
    const file = await open(rollout, "r");
    try {
      if (!(await file.stat()).isFile()) return false;
      const bytes = Buffer.alloc(MAX_METADATA_BYTES);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const newline = bytes.subarray(0, bytesRead).indexOf(0x0a);
      if (newline < 0) return false;
      const line: unknown = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
      if (!record(line) || line.type !== "session_meta" || !record(line.payload)) return false;
      const metadata = line.payload;
      if (metadata.id !== input.threadId || !Array.isArray(metadata.dynamic_tools)) return false;
      return metadata.dynamic_tools.some((tool: unknown) => {
        if (!record(tool)) return false;
        if (tool.type === "namespace") {
          return (
            Array.isArray(tool.tools) &&
            tool.tools.some((item: unknown) => record(item) && item.name === "read_thread")
          );
        }
        return tool.name === "read_thread";
      });
    } finally {
      await file.close();
    }
  } catch {
    // Unknown, old-format, or inaccessible metadata must not enable a capability.
    return false;
  }
}
