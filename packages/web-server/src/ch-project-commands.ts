import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { ChHostClient } from "./ch-host-client.ts";
import type { DataDir } from "./store.ts";
import { RpcError } from "./transport.ts";
import { nativeProjectWorkspaceId, type ProjectCommands, type Workspaces } from "./workspaces.ts";

/** Project mutations share the native catalog and never edit the Web workspace file. */
export function nativeProjectCommands(
  host: Pick<ChHostClient, "request">,
  workspaces: Workspaces,
  refresh: () => Promise<void>,
  assignSession: (sessionId: string, projectId: string) => Promise<void>,
): ProjectCommands {
  let pending = Promise.resolve();
  const mutate = <T>(operation: () => Promise<T>): Promise<T | undefined> => {
    const result = pending.then(async () => {
      await refresh();
      return workspaces.usesNativeProjects ? operation() : undefined;
    });
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const projectId = (workspaceId: string) => {
    const id = workspaces.get(workspaceId)?.projectId;
    if (!id) throw new RpcError("workspace/not-found", "The Codex project is no longer available.");
    return id;
  };
  const refreshCommitted = async () => {
    try {
      await refresh();
    } catch {
      throw new RpcError(
        "workspace/refresh-failed",
        "Codex confirmed the change. Refresh the project list.",
      );
    }
  };
  return {
    create: (path) =>
      mutate(async () => {
        const expanded = path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
        if (!isAbsolute(expanded) || !(await stat(expanded).catch(() => undefined))?.isDirectory())
          throw new RpcError("workspace/invalid-path", "Choose an existing absolute folder.", {
            path,
          });
        const absolute = resolve(expanded);
        const existing = workspaces.byPath(absolute);
        if (existing) return { workspace: existing, created: false };
        const { project } = await host.request<{ project: { id: string } }>("project/create", {
          name: basename(absolute) || absolute,
          roots: [{ path: absolute }],
          idempotencyKey: randomUUID(),
        });
        await refreshCommitted();
        const workspace = workspaces.get(nativeProjectWorkspaceId(project.id));
        if (!workspace)
          throw new RpcError(
            "workspace/refresh-failed",
            "Codex confirmed the new project. Refresh the project list.",
          );
        workspaces.appendToDisplayOrderIfPresent(workspace.workspaceId);
        return { workspace, created: true };
      }),
    rename: (workspaceId, title) =>
      mutate(async () => {
        await host.request("project/update", { projectId: projectId(workspaceId), name: title });
        await refreshCommitted();
        const workspace = workspaces.get(workspaceId);
        if (!workspace)
          throw new RpcError("workspace/not-found", "The Codex project is no longer available.");
        return { workspace };
      }),
    delete: (workspaceId) =>
      mutate(async () => {
        await host.request("project/delete", { projectId: projectId(workspaceId) });
        await refreshCommitted();
        if (workspaces.get(workspaceId))
          throw new RpcError(
            "workspace/refresh-failed",
            "Codex confirmed the removal. Refresh the project list.",
          );
        workspaces.removeFromDisplayOrder(workspaceId);
        return { deleted: true };
      }),
    insertBefore: (workspaceId, beforeWorkspaceId) =>
      mutate(async () => {
        if (
          workspaces.isRemote(workspaceId) ||
          (beforeWorkspaceId !== undefined && workspaces.isRemote(beforeWorkspaceId))
        ) {
          return undefined;
        }
        if (workspaceId !== beforeWorkspaceId) {
          await host.request("project/move", {
            projectId: projectId(workspaceId),
            beforeProjectId: beforeWorkspaceId ? projectId(beforeWorkspaceId) : null,
          });
          await refreshCommitted();
          workspaces.reorderDisplayOrderIfPresent(workspaceId, beforeWorkspaceId);
        }
        return { workspaceIds: workspaces.list().map((workspace) => workspace.workspaceId) };
      }),
    insertSessionBefore: (workspaceId, sessionId, beforeSessionId) =>
      mutate(async () => {
        const target = workspaces.get(workspaceId);
        // Persist a cross-project move in Codex first; a failure leaves the projection untouched.
        if (!target?.sessionIds.includes(sessionId))
          await assignSession(sessionId, projectId(workspaceId));
        return {
          workspace: workspaces.placeNativeSession(workspaceId, sessionId, beforeSessionId),
        };
      }),
  };
}

const ADOPTED_WEB_WORKSPACES = "adopted-web-workspaces.json";

/**
 * Give folders opened as Workspaces in Web a native project, once.
 * Before native projects, such a folder was a Workspace only in Web. The native catalog lists
 * Codex projects alone, so the folder would vanish and its Threads would move to whichever
 * project root contains them. Each adopted folder is recorded as soon as its project exists, so
 * an interrupted run resumes and a project removed afterwards is not created again.
 * @param refresh Reads the current native catalog into `workspaces`.
 * @param data Web data directory; holds the adoption record, leaving the Workspace file as is.
 * @throws when a folder cannot be checked or created; the next start resumes from the record.
 */
export async function adoptWebWorkspaces(
  host: Pick<ChHostClient, "request">,
  workspaces: Workspaces,
  refresh: () => Promise<void>,
  data: DataDir,
): Promise<void> {
  const record = data.readJson<{ paths?: string[]; complete?: boolean }>(
    ADOPTED_WEB_WORKSPACES,
    {},
  );
  if (record.complete) return;
  await refresh();
  // The compatible catalog still shows these Workspaces itself.
  if (!workspaces.usesNativeProjects) return;
  const adopted = [...(record.paths ?? [])];
  let created = false;
  for (const path of workspaces.unadoptedWebWorkspacePaths()) {
    if (adopted.some((done) => relative(done, path) === "")) continue;
    const folder = await stat(path).catch((error: NodeJS.ErrnoException) => {
      // Only a folder known to be gone is skipped; any other failure is retried next start.
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
      throw error;
    });
    if (!folder?.isDirectory()) continue;
    await host.request("project/create", {
      name: basename(path) || path,
      roots: [{ path }],
      idempotencyKey: randomUUID(),
    });
    adopted.push(path);
    created = true;
    data.writeJson(ADOPTED_WEB_WORKSPACES, { paths: adopted, complete: false });
  }
  data.writeJson(ADOPTED_WEB_WORKSPACES, { paths: adopted, complete: true });
  if (created) await refresh();
}
