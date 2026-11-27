import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-files/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { fileAddressFor } from "@deepseek-ai/dsh-util-workspace-path";

export async function openWorkspaceLink(
  workspaceFiles: Pick<Context["remote"]["workspaceFiles"], "stat">,
  sidebar: Pick<Context["sidebarRight"], "mounted" | "openTabIn" | "openResourceIn">,
  sessionId: SessionId,
  cwd: string | undefined,
  path: string,
  line?: number,
): Promise<void> {
  const meta = await workspaceFiles.stat(sessionId, path);
  if (sidebar.mounted.getSnapshot() !== sessionId) return;
  if (
    !meta.ok &&
    meta.error.code === "workspace-file/not-regular-file" &&
    meta.error.details.kind === "directory"
  ) {
    sidebar.openTabIn(sessionId, "files", { params: { directory: meta.error.details.path } });
    return;
  }
  sidebar.openResourceIn(
    sessionId,
    fileAddressFor(sessionId, cwd, path),
    line === undefined ? undefined : { params: { line } },
  );
}
