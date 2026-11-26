import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ChHostClient } from "./ch-host-client.ts";
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
