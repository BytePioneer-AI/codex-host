import { homedir, hostname } from "node:os";
import { mkdir, readdir, stat } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { ZodError } from "zod";
import * as c from "@codexhost/shared-contracts";
import type { Workspaces } from "./workspaces.ts";
import type { RpcRegistry } from "./transport.ts";

/** Structured client-safe error raised by `/api/peer/v1/*` handlers. */
export class PeerEndpointError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function mapFsError(error: unknown, fallback: string): PeerEndpointError {
  if (error instanceof PeerEndpointError) return error;
  if (error instanceof ZodError)
    return new PeerEndpointError(400, "Invalid peer request parameters");
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return new PeerEndpointError(404, "Directory not found");
  if (code === "ENOTDIR") return new PeerEndpointError(400, "Path is not a directory");
  if (code === "EACCES" || code === "EPERM") return new PeerEndpointError(403, "Permission denied");
  if (code === "EEXIST") return new PeerEndpointError(409, "Directory already exists");
  return new PeerEndpointError(400, fallback);
}

export async function peerEndpoint(
  method: string,
  url: URL,
  body: unknown,
  workspaces: Workspaces,
  rpc: RpcRegistry,
  epoch: string | undefined,
  version: string,
) {
  const manifest = () => {
    if (!epoch) throw new PeerEndpointError(503, "Host realtime channel is not ready");
    return c.remotePeerManifestSchema.parse({
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
  };
  const route = url.pathname.slice("/api/peer/v1/".length);
  if (method === "GET" && route === "manifest") return manifest();
  if (route === "dirs" && method === "GET") {
    const rawPath = url.searchParams.get("path");
    const path = resolve(rawPath !== null && rawPath.length > 0 ? rawPath : homedir());
    try {
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
    } catch (error) {
      throw mapFsError(error, "Unable to list directory");
    }
  }
  if (route === "dirs" && method === "POST") {
    let parentPath: string;
    let name: string;
    try {
      ({ parentPath, name } = c.remotePeerCreateDirParamsSchema.omit({ peerId: true }).parse(body));
    } catch (error) {
      throw mapFsError(error, "Invalid directory parameters");
    }
    if (name === "." || name === ".." || /[\\/\0]/u.test(name)) {
      throw new PeerEndpointError(400, "Invalid directory name");
    }
    try {
      const parentStats = await stat(parentPath);
      if (!parentStats.isDirectory())
        throw new PeerEndpointError(400, "Parent path is not a directory");
      const path = join(resolve(parentPath), name);
      await mkdir(path);
      return { path, name };
    } catch (error) {
      throw mapFsError(error, "Unable to create directory");
    }
  }
  if (route === "workspaces") {
    let workspaceId: string;
    let title: string | undefined;
    try {
      if (method === "POST") {
        const p = c.remotePeerCreateWorkspaceParamsSchema.omit({ peerId: true }).parse(body);
        workspaceId = workspaces.create(p.path).workspace.workspaceId;
        title = p.title;
      } else if (method === "PATCH") {
        ({ workspaceId, title } = c.remotePeerRenameWorkspaceParamsSchema
          .omit({ peerId: true })
          .parse(body));
      } else if (method === "DELETE") {
        ({ workspaceId } = c.remotePeerDeleteWorkspaceParamsSchema
          .omit({ peerId: true })
          .parse(body));
      } else {
        throw new PeerEndpointError(405, "Method not allowed");
      }
    } catch (error) {
      throw mapFsError(error, "Invalid workspace request");
    }
    if (!workspaces.get(workspaceId)) throw new PeerEndpointError(404, "Unknown workspace");
    if (title || method === "DELETE") {
      const reply = await rpc.dispatch(title ? "workspace/rename" : "workspace/delete", {
        args: { workspaceId, title },
      });
      if (!reply.ok) throw new PeerEndpointError(400, "Workspace mutation failed");
    }
    return { workspaceId, manifest: manifest() };
  }
  throw new PeerEndpointError(404, "Unknown peer endpoint");
}
