import { homedir, hostname } from "node:os";
import { mkdir, readdir, stat } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import * as c from "@codexhost/shared-contracts";
import type { Workspaces } from "./workspaces.ts";
import type { RpcRegistry } from "./transport.ts";

export async function peerEndpoint(
  method: string,
  url: URL,
  body: unknown,
  workspaces: Workspaces,
  rpc: RpcRegistry,
  epoch: string,
  version: string,
) {
  const manifest = () =>
    c.remotePeerManifestSchema.parse({
      version,
      epoch,
      platform: process.platform,
      hostname: hostname(),
      homeDir: homedir(),
      projects: workspaces
        .list()
        .filter((w) => !w.remote)
        .map((w) => ({ id: w.workspaceId, name: w.title, path: w.path, threadIds: w.sessionIds })),
    });
  const route = url.pathname.slice("/api/peer/v1/".length);
  if (method === "GET" && route === "manifest") return manifest();
  if (route === "dirs" && method === "GET") {
    const rawPath = url.searchParams.get("path")?.trim();
    const path = resolve(rawPath || homedir());
    const dirents = await readdir(path, { withFileTypes: true });
    const entries: { name: string; path: string; kind: "directory" }[] = [];
    for (const dirent of dirents) {
      const child = join(path, dirent.name);
      const isDir = dirent.isDirectory()
        ? true
        : dirent.isSymbolicLink()
          ? await stat(child).then(
              (s) => s.isDirectory(),
              () => false,
            )
          : false;
      if (isDir) entries.push({ name: dirent.name, path: child, kind: "directory" });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return {
      path,
      parentPath: dirname(path) === path ? null : dirname(path),
      homeDir: homedir(),
      entries,
    };
  }
  if (route === "dirs" && method === "POST") {
    const { parentPath, name } = c.remotePeerCreateDirParamsSchema
      .omit({ peerId: true })
      .parse(body);
    if (
      name === "." ||
      name === ".." ||
      /[\\/\0]/u.test(name) ||
      !(await stat(parentPath)).isDirectory()
    )
      throw Error("Invalid directory");
    const path = join(resolve(parentPath), name);
    await mkdir(path);
    return { path, name };
  }
  if (route === "workspaces") {
    let workspaceId: string;
    let title: string | undefined;
    if (method === "POST") {
      const p = c.remotePeerCreateWorkspaceParamsSchema.omit({ peerId: true }).parse(body);
      workspaceId = workspaces.create(p.path).workspace.workspaceId;
      title = p.title;
    } else if (method === "PATCH")
      ({ workspaceId, title } = c.remotePeerRenameWorkspaceParamsSchema
        .omit({ peerId: true })
        .parse(body));
    else if (method === "DELETE")
      ({ workspaceId } = c.remotePeerDeleteWorkspaceParamsSchema
        .omit({ peerId: true })
        .parse(body));
    else throw Error("Unknown method");
    if (!workspaces.get(workspaceId)) throw Error("Unknown workspace");
    if (title || method === "DELETE") {
      const reply = await rpc.dispatch(title ? "workspace/rename" : "workspace/delete", {
        args: { workspaceId, title },
      });
      if (!reply.ok) throw Error("Workspace mutation failed");
    }
    return { workspaceId, manifest: manifest() };
  }
  throw Error("Unknown peer endpoint");
}
