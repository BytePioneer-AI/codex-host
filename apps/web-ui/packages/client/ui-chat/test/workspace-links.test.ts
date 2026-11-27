import type { WorkspaceFileStat } from "@deepseek-ai/dsh-api-workspace-files/types";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { RemoteError, type RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import { describe, expect, it, vi } from "vitest";
import { openWorkspaceLink } from "../src/client/open-workspace-link.ts";
import { parseFileLink } from "../../ui-primitives/src/markdown/file-link.ts";
import { filesRoot } from "../../ui-sidebar-files/src/client/root.ts";

const sessionId = "workspace-session" as SessionId;
const cwd = "D:/Demo Workspace";

function destinations() {
  return {
    mounted: createSnapshotStore<SessionId | undefined>(sessionId),
    openTabIn: vi.fn(),
    openResourceIn: vi.fn(),
  };
}

function openLink(
  href: string,
  workspaceFiles: Parameters<typeof openWorkspaceLink>[0],
  sidebar: Parameters<typeof openWorkspaceLink>[1],
) {
  const link = parseFileLink(href);
  if (link === undefined) throw new Error(`Not a local link: ${href}`);
  return openWorkspaceLink(workspaceFiles, sidebar, sessionId, cwd, link.path, link.line);
}

function notAFile(path: string, kind: "directory" | "symlink"): RemoteResult<WorkspaceFileStat> {
  return {
    ok: false,
    error: new RemoteError("workspace-file/not-regular-file", `Not a regular file: ${path}`, {
      path,
      kind,
    }),
  };
}

function regularFile(path: string): RemoteResult<WorkspaceFileStat> {
  return { ok: true, value: { absolutePath: `${cwd}/${path}`, bytes: 8, version: "v1" } };
}

describe("open a local Markdown workspace link in chat", () => {
  it.each([
    ["notes.v2", "notes.v2"],
    ["D:/Demo%20Workspace/%E5%9B%BE%E8%A1%A8/", "D:/Demo Workspace/图表/"],
    [".", "."],
  ])("opens directory %s in Files and not in a preview", async (href, path) => {
    const sidebar = destinations();
    await openLink(
      href,
      { stat: async (_session, target) => notAFile(target, "directory") },
      sidebar,
    );
    expect(sidebar.openTabIn).toHaveBeenCalledWith(sessionId, "files", {
      params: { directory: path },
    });
    expect(sidebar.openResourceIn).not.toHaveBeenCalled();
  });

  it.each([
    ["README", undefined],
    ["README#L7", { params: { line: 7 } }],
  ])("opens regular file %s in the session preview", async (href, options) => {
    const sidebar = destinations();
    await openLink(href, { stat: async () => regularFile("README") }, sidebar);
    expect(sidebar.openResourceIn).toHaveBeenCalledWith(
      sessionId,
      `dsh-resource://file/session/${sessionId}/README`,
      options,
    );
    expect(sidebar.openTabIn).not.toHaveBeenCalled();
  });

  it("keeps non-directory errors on the preview path", async () => {
    const sidebar = destinations();
    await openLink("alias", { stat: async () => notAFile("alias", "symlink") }, sidebar);
    expect(sidebar.openResourceIn).toHaveBeenCalledWith(
      sessionId,
      `dsh-resource://file/session/${sessionId}/alias`,
      undefined,
    );
    expect(sidebar.openTabIn).not.toHaveBeenCalled();
  });

  it("does not open a result after switching sessions during the lookup", async () => {
    const sidebar = destinations();
    const pending = Promise.withResolvers<RemoteResult<WorkspaceFileStat>>();
    const opening = openLink("reports", { stat: () => pending.promise }, sidebar);
    sidebar.mounted.set("another-session" as SessionId);
    pending.resolve(notAFile("reports", "directory"));
    await opening;
    expect(sidebar.openTabIn).not.toHaveBeenCalled();
    expect(sidebar.openResourceIn).not.toHaveBeenCalled();
  });
});

describe("Files root navigation", () => {
  it.each([
    [cwd, ".", false, cwd],
    [cwd, undefined, false, cwd],
    [cwd, "notes.v2", false, `${cwd}/notes.v2`],
    [undefined, ".", true, "."],
    [undefined, undefined, true, "."],
    [undefined, "notes.v2", true, "notes.v2"],
    [undefined, undefined, false, undefined],
  ])("resolves cwd=%s and directory=%s (remote availability: %s)", (base, target, ready, root) => {
    expect(filesRoot(base, target, ready)).toBe(root);
  });
});
