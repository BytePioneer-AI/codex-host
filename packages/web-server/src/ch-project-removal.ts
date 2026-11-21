import { resolve } from "node:path";
import type { ChHostClient } from "./ch-host-client.ts";
import { RpcError } from "./transport.ts";
import type { WorkspaceView } from "./workspaces.ts";

/** Native project mutations invalidate workspace snapshots already being read. */
export class ChProjectRemoval {
  revision = 0;

  constructor(private readonly host: ChHostClient) {}

  async remove(workspace: WorkspaceView): Promise<void> {
    const snapshot = await this.host.projects([]);
    const projects = snapshot.projects.filter((project) =>
      project.rootPaths.some((root) => resolve(root) === workspace.path),
    );
    if (!projects.length) return;
    // A Web row names one folder, not necessarily an entire native project.
    // Do not expand the user's confirmation to sibling roots or other projects.
    const project = projects[0]!;
    if (projects.length !== 1 || project.rootPaths.length !== 1)
      throw new RpcError(
        "workspace/ambiguous-project",
        "This folder belongs to multiple projects or a multi-folder project. Remove the project in Codex Desktop.",
      );
    if (!this.host.removeProject)
      throw new RpcError(
        "workspace/native-delete-unavailable",
        "Native project removal is unavailable. Update and open codexhost Desktop.",
      );
    this.revision++;
    try {
      await this.host.removeProject(project.id, workspace.path);
      const confirmed = await this.host.projects([]);
      if (confirmed.projects.some((item) => item.id === project.id))
        throw new RpcError(
          "workspace/native-delete-unconfirmed",
          "Codex has not confirmed project removal. Refresh before retrying.",
        );
    } finally {
      this.revision++;
    }
  }
}
