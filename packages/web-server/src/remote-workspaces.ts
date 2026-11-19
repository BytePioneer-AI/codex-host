import type { WorkspaceView } from "./workspaces.ts";

export interface RemoteWorkspaceHost {
  hostId: string;
  online: boolean;
  displayName?: string | undefined;
  state?: string | undefined;
  projects?: Array<{ id: string; name: string; path: string; threadIds: string[] }> | undefined;
}
export function remoteHostDisplayName(
  host: Pick<RemoteWorkspaceHost, "hostId" | "displayName">,
): string {
  return (
    host.displayName ??
    (host.hostId.startsWith("remote-control:")
      ? "Remote Control"
      : host.hostId.replace(/^remote-ssh-(?:discovered|codex-managed):/u, ""))
  );
}
/** Group only within a native registered remote project; never resolve remote paths locally. */
export function remoteWorkspaceGroups(
  hosts: Iterable<RemoteWorkspaceHost>,
  threads: Iterable<{ sessionId: string; hostId: string; threadId: string; cwd: string }>,
): WorkspaceView[] {
  const rows = [...threads];
  return [...hosts].flatMap((host) => {
    const remote = {
      hostId: host.hostId,
      displayName: remoteHostDisplayName(host),
      state: host.online
        ? "connected"
        : host.state === "connected"
          ? "disconnected"
          : (host.state ?? "disconnected"),
    };
    const normalize = (path: string) => {
      const p = path.replaceAll("\\", "/").replace(/\/+$/u, "");
      return /^[a-z]:/iu.test(p) ? p.toLowerCase() : p;
    };
    const projects = host.projects ?? [];
    const groups = [
      ...projects.map((project) => ({ project, ids: [] as string[] })),
      { project: undefined, ids: [] as string[] },
    ];
    for (const row of rows.filter((row) => row.hostId === host.hostId)) {
      const exact = projects.find((project) => project.threadIds.includes(row.threadId));
      const cwd = normalize(row.cwd);
      const match =
        exact ??
        projects
          .filter((project) => {
            const root = normalize(project.path);
            return cwd === root || cwd.startsWith(root + "/");
          })
          .sort((a, b) => b.path.length - a.path.length)[0];
      groups.find((group) => group.project === match)?.ids.push(row.sessionId);
    }
    return groups
      .filter((group) => group.project || group.ids.length || projects.length === 0)
      .map(({ project, ids }) => ({
        workspaceId:
          "remote-workspace:" +
          Buffer.from(JSON.stringify([host.hostId, project?.id ?? null])).toString("base64url"),
        path: project?.path ?? "",
        title: project?.name ?? remote.displayName,
        sessionIds: ids,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        remote,
      }));
  });
}
