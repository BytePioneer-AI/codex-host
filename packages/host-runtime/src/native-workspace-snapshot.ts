import { open } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import {
  clientWorkspaceSnapshotSchema,
  type ClientWorkspaceSnapshot,
} from "@codexhost/shared-contracts";

/** Read Desktop's persisted metadata, never infer projects from execution cwd or write its file. */
export async function readNativeWorkspaceSnapshot(
  environment: NodeJS.ProcessEnv,
): Promise<ClientWorkspaceSnapshot> {
  const file = path.join(
    environment.CODEX_HOME ?? path.join(homedir(), ".codex"),
    ".codex-global-state.json",
  );
  let text: string;
  try {
    const handle = await open(file, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
        throw new Error("Invalid or oversized native workspace metadata");
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { projects: [], assignments: {}, projectless: [], pinned: [] };
    throw error;
  }
  if (Buffer.byteLength(text) > 32 * 1024 * 1024)
    throw new Error("Native workspace metadata exceeds its read limit");
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid native workspace metadata");
  const state = parsed as Record<string, unknown>;
  const order = state["project-order"] ?? [];
  const local = state["local-projects"] ?? {};
  const assigned = state["thread-project-assignments"] ?? {};
  if (
    !Array.isArray(order) ||
    !order.every((id) => typeof id === "string") ||
    !local ||
    typeof local !== "object" ||
    Array.isArray(local) ||
    !assigned ||
    typeof assigned !== "object" ||
    Array.isArray(assigned)
  )
    throw new Error("Invalid native project metadata");
  return clientWorkspaceSnapshotSchema.parse({
    projects: Object.values(local)
      .filter((value) => value && typeof value === "object" && order.includes(value.id))
      .map(({ id, name, rootPaths }) => ({ id, name, rootPaths })),
    assignments: Object.fromEntries(
      Object.entries(assigned).flatMap(([id, value]) => {
        if (!value || typeof value !== "object") return [];
        const entry = value as Record<string, unknown>;
        return entry.projectKind === "local" ? [[id, entry.projectId]] : [];
      }),
    ),
    projectless: state["projectless-thread-ids"] ?? [],
    pinned: state["pinned-thread-ids"] ?? [],
  });
}
