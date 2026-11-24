import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { resolve, dirname, join, relative, isAbsolute } from "node:path";
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

function isRealServerVersion(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== "0.0.0";
}

/** Resolve the advertised server version, preferring an injected release version and skipping placeholder `0.0.0`. */
export function resolveServerVersion(
  injected: string | undefined,
  candidateFiles: readonly string[],
): string {
  if (isRealServerVersion(injected)) return injected.trim();
  for (const candidate of candidateFiles) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
      if (isRealServerVersion(parsed.version)) return parsed.version.trim();
    } catch {
      /* Try next metadata candidate. */
    }
  }
  return "0.0.0";
}

async function resolveCanonicalPath(targetPath: string): Promise<string> {
  const resolved = resolve(targetPath);
  const missingTail: string[] = [];
  let cursor = resolved;
  for (;;) {
    try {
      const real = await realpath(cursor);
      return missingTail.length ? join(real, ...missingTail.reverse()) : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return resolved;
      const base = cursor.slice(
        parent.endsWith("/") || parent.endsWith("\\") ? parent.length : parent.length + 1,
      );
      missingTail.push(base);
      cursor = parent;
    }
  }
}

function isPathWithinRoot(candidate: string, root: string): boolean {
  const normCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const normRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const rel = relative(normRoot, normCandidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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

export interface PeerEndpointOptions {
  attachments?: boolean;
  workspaceFiles?: boolean;
  officePreview?: boolean;
}

export async function peerEndpoint(
  method: string,
  url: URL,
  body: unknown,
  workspaces: Workspaces,
  rpc: RpcRegistry,
  epoch: string | undefined,
  version: string,
  allowedRoots?: readonly string[],
  options?: PeerEndpointOptions,
) {
  const collectAllowedRoots = async (): Promise<string[]> => {
    const rawRoots = [
      homedir(),
      ...(allowedRoots ?? []),
      ...workspaces
        .list()
        .filter((w) => !w.remote)
        .map((w) => w.path),
    ];
    const canonical = new Set<string>();
    for (const root of rawRoots) {
      if (!root) continue;
      try {
        canonical.add(await resolveCanonicalPath(root));
      } catch {
        canonical.add(resolve(root));
      }
    }
    return [...canonical];
  };
  const assertWithinAllowedRoots = async (
    targetPath: string,
    roots: readonly string[],
    message: string,
  ): Promise<string> => {
    const canonical = await resolveCanonicalPath(targetPath);
    if (!roots.some((root) => isPathWithinRoot(canonical, root))) {
      throw new PeerEndpointError(403, message);
    }
    return canonical;
  };
  const manifest = () => {
    if (!epoch) throw new PeerEndpointError(503, "Host realtime channel is not ready");
    const capabilities: c.RemotePeerCapabilities = {
      ...(options?.attachments ? { attachments: 1 } : {}),
      ...(options?.workspaceFiles ? { workspaceFiles: 1 } : {}),
      ...(options?.officePreview ? { officePreview: 1 } : {}),
    };
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
      ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
    });
  };
  const route = url.pathname.slice("/api/peer/v1/".length);
  if (method === "GET" && route === "manifest") return manifest();
  if (route === "dirs" && method === "GET") {
    const rawPath = url.searchParams.get("path");
    if (rawPath !== null && rawPath.length > 0 && !isAbsolute(rawPath)) {
      throw new PeerEndpointError(400, "Directory path must be absolute");
    }
    const path = resolve(rawPath !== null && rawPath.length > 0 ? rawPath : homedir());
    try {
      const roots = await collectAllowedRoots();
      const canonicalPath = await assertWithinAllowedRoots(
        path,
        roots,
        "Directory is outside allowed roots",
      );
      const dirents = await readdir(canonicalPath, { withFileTypes: true });
      const entries: { name: string; path: string; kind: "directory" }[] = [];
      for (const dirent of dirents) {
        const child = join(path, dirent.name);
        let isDir = false;
        if (dirent.isDirectory()) {
          isDir = true;
        } else if (dirent.isSymbolicLink()) {
          const targetReal = await realpath(join(canonicalPath, dirent.name)).catch(() => null);
          if (targetReal && roots.some((root) => isPathWithinRoot(targetReal, root))) {
            isDir = await stat(targetReal).then(
              (s) => s.isDirectory(),
              () => false,
            );
          }
        }
        if (isDir) entries.push({ name: dirent.name, path: child, kind: "directory" });
      }
      entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      const candidateParent = dirname(path);
      let parentPath: string | null = null;
      if (candidateParent !== path) {
        const canonicalParent = await resolveCanonicalPath(candidateParent).catch(() => null);
        if (canonicalParent && roots.some((root) => isPathWithinRoot(canonicalParent, root))) {
          parentPath = candidateParent;
        }
      }
      return {
        path,
        parentPath,
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
    if (!isAbsolute(parentPath)) {
      throw new PeerEndpointError(400, "Parent directory path must be absolute");
    }
    try {
      const roots = await collectAllowedRoots();
      const resolvedParent = resolve(parentPath);
      const canonicalParent = await assertWithinAllowedRoots(
        resolvedParent,
        roots,
        "Parent directory is outside allowed roots",
      );
      const parentStats = await stat(canonicalParent);
      if (!parentStats.isDirectory())
        throw new PeerEndpointError(400, "Parent path is not a directory");
      await mkdir(join(canonicalParent, name));
      return { path: join(resolvedParent, name), name };
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
        if (!isAbsolute(p.path)) {
          throw new PeerEndpointError(400, "Workspace path must be absolute");
        }
        const roots = await collectAllowedRoots();
        const canonicalPath = await assertWithinAllowedRoots(
          p.path,
          roots,
          "Workspace path is outside allowed roots",
        );
        workspaceId = workspaces.create(canonicalPath).workspace.workspaceId;
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
