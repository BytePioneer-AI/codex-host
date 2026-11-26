import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readDesktopGlobalState } from "./desktop-global-state.js";

export interface RemoteProjectMetadata {
  id: string;
  hostId: string;
  name: string;
  path: string;
  threadIds: string[];
}
/** Read only Desktop's explicit remote project registrations. Never inspect remote files. */
export async function readRemoteProjectMetadata(
  file = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), ".codex-global-state.json"),
): Promise<RemoteProjectMetadata[]> {
  try {
    const state = (await readDesktopGlobalState(dirname(file), file)) as Record<string, unknown>;
    const projects = state["remote-projects"];
    if (!Array.isArray(projects)) return [];
    const order = Array.isArray(state["project-order"])
      ? (state["project-order"] as unknown[])
      : [];
    const assigned = state["thread-project-assignments"] as
      Record<string, { projectKind?: string; projectId?: string }> | undefined;
    return projects
      .flatMap((p: unknown) => {
        if (!p || typeof p !== "object") return [];
        const v = p as Record<string, unknown>;
        if (
          typeof v.id !== "string" ||
          typeof v.hostId !== "string" ||
          typeof v.remotePath !== "string" ||
          typeof v.label !== "string" ||
          !order.includes(v.id)
        )
          return [];
        return [
          {
            id: v.id,
            hostId: v.hostId,
            name: v.label,
            path: v.remotePath,
            threadIds: Object.entries(assigned ?? {}).flatMap(([id, a]) =>
              a?.projectKind === "remote" && a.projectId === v.id ? [id] : [],
            ),
          },
        ];
      })
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  } catch (error) {
    const { syscall, path } = error as NodeJS.ErrnoException;
    if (syscall === "open" && path === file) return [];
    throw error;
  }
}
