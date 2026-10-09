/** Workspace registry and the `workspace/*` Remote surface. */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

import { type DataDir, requestOf } from "./store.ts";
import { RpcError, type RpcRegistry, type StreamRegistry, type StreamSink } from "./transport.ts";

export interface WorkspaceView {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceState {
  items: WorkspaceView[];
  archivedSessionIds: string[];
  pinnedSessionIds: string[];
}

const FILE = "workspaces.json";

export class Workspaces {
  private state: WorkspaceState;
  private readonly followers = new Set<StreamSink>();

  constructor(
    private readonly data: DataDir,
    private readonly defaultDirectory: string,
  ) {
    this.state = data.readJson<WorkspaceState>(FILE, {
      items: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    });
  }

  private save(): void {
    this.data.writeJson(FILE, this.state);
  }

  private broadcast(frame: unknown): void {
    for (const sink of this.followers) sink.push(frame);
  }

  private touch(workspace: WorkspaceView): void {
    workspace.updatedAt = new Date().toISOString();
    this.save();
    this.broadcast({ type: "upsert", workspace });
  }

  list(): readonly WorkspaceView[] {
    return this.state.items;
  }

  get(workspaceId: string): WorkspaceView | undefined {
    return this.state.items.find((item) => item.workspaceId === workspaceId);
  }

  byPath(path: string): WorkspaceView | undefined {
    return this.state.items.find((item) => item.path === path);
  }

  ownerOf(sessionId: string): WorkspaceView | undefined {
    return this.state.items.find((item) => item.sessionIds.includes(sessionId));
  }

  isArchived(sessionId: string): boolean {
    return this.state.archivedSessionIds.includes(sessionId);
  }

  create(path: string): { workspace: WorkspaceView; created: boolean } {
    const expanded = path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
    if (!isAbsolute(expanded))
      throw new RpcError("workspace/invalid-path", `Workspace path must be absolute: ${path}`, {
        path,
      });
    const absolute = resolve(expanded);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      throw new RpcError("workspace/invalid-path", `Not a directory: ${absolute}`, { path });
    }
    const existing = this.byPath(absolute);
    if (existing !== undefined) return { workspace: existing, created: false };
    const now = new Date().toISOString();
    const workspace: WorkspaceView = {
      workspaceId: randomUUID(),
      path: absolute,
      title: basename(absolute) || absolute,
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.state.items.push(workspace);
    this.save();
    this.broadcast({ type: "upsert", workspace });
    this.broadcast({
      type: "order",
      workspaceIds: this.state.items.map((item) => item.workspaceId),
    });
    return { workspace, created: true };
  }

  /** Attach a session to the workspace owning `cwd` (creating one when needed). */
  attachSession(
    sessionId: string,
    workspaceId: string | undefined,
    cwd: string | undefined,
  ): WorkspaceView {
    let workspace = workspaceId === undefined ? undefined : this.get(workspaceId);
    if (workspace === undefined && cwd !== undefined)
      workspace = this.byPath(resolve(cwd)) ?? this.create(cwd).workspace;
    if (workspace === undefined)
      throw new RpcError("workspace/invalid-path", "Session needs a workspace or cwd", {
        path: cwd ?? "",
      });
    if (!workspace.sessionIds.includes(sessionId)) {
      workspace.sessionIds.unshift(sessionId);
      this.touch(workspace);
    }
    return workspace;
  }

  detachSession(sessionId: string): void {
    for (const workspace of this.state.items) {
      const index = workspace.sessionIds.indexOf(sessionId);
      if (index >= 0) {
        workspace.sessionIds.splice(index, 1);
        this.touch(workspace);
      }
    }
  }

  register(rpc: RpcRegistry, streams: StreamRegistry): void {
    rpc.register("workspace/create", (args) => this.create(requestOf<{ path: string }>(args).path));
    rpc.register("workspace/initializeDefault", () => {
      if (this.state.items.length > 0) return undefined;
      mkdirSync(this.defaultDirectory, { recursive: true });
      return { workspace: this.create(this.defaultDirectory).workspace };
    });
    rpc.register("workspace/rename", (args) => {
      const request = requestOf<{ workspaceId: string; title: string }>(args);
      const workspace = this.require(request.workspaceId);
      workspace.title = request.title;
      this.touch(workspace);
      return { workspace };
    });
    rpc.register("workspace/delete", (args) => {
      const request = requestOf<{ workspaceId: string }>(args);
      this.require(request.workspaceId);
      this.state.items = this.state.items.filter(
        (item) => item.workspaceId !== request.workspaceId,
      );
      this.save();
      this.broadcast({ type: "remove", workspaceId: request.workspaceId });
      return { deleted: true };
    });
    rpc.register("workspace/insertBefore", (args) => {
      const request = requestOf<{ workspaceId: string; beforeWorkspaceId?: string }>(args);
      const workspace = this.require(request.workspaceId);
      const rest = this.state.items.filter((item) => item !== workspace);
      const index =
        request.beforeWorkspaceId === undefined
          ? rest.length
          : rest.findIndex((item) => item.workspaceId === request.beforeWorkspaceId);
      rest.splice(index < 0 ? rest.length : index, 0, workspace);
      this.state.items = rest;
      this.save();
      const workspaceIds = rest.map((item) => item.workspaceId);
      this.broadcast({ type: "order", workspaceIds });
      return { workspaceIds };
    });
    rpc.register("workspace/insertSessionBefore", (args) => {
      const request = requestOf<{
        workspaceId: string;
        sessionId: string;
        beforeSessionId?: string;
      }>(args);
      const workspace = this.require(request.workspaceId);
      for (const other of this.state.items) {
        if (other !== workspace && other.sessionIds.includes(request.sessionId)) {
          other.sessionIds = other.sessionIds.filter((id) => id !== request.sessionId);
          this.touch(other);
        }
      }
      const rest = workspace.sessionIds.filter((id) => id !== request.sessionId);
      const index =
        request.beforeSessionId === undefined ? rest.length : rest.indexOf(request.beforeSessionId);
      rest.splice(index < 0 ? rest.length : index, 0, request.sessionId);
      workspace.sessionIds = rest;
      this.touch(workspace);
      return { workspace };
    });
    const setMembership =
      (
        key: "archivedSessionIds" | "pinnedSessionIds",
        frame: "archived" | "pinned",
        add: boolean,
      ) =>
      (args: Record<string, unknown>) => {
        const { sessionId } = requestOf<{ sessionId: string }>(args);
        const current = this.state[key].filter((id) => id !== sessionId);
        if (add) current.push(sessionId);
        this.state[key] = current;
        this.save();
        this.broadcast({ type: frame, [key]: current });
        return { [key]: current };
      };
    rpc.register("workspace/archiveSession", setMembership("archivedSessionIds", "archived", true));
    rpc.register(
      "workspace/unarchiveSession",
      setMembership("archivedSessionIds", "archived", false),
    );
    rpc.register("workspace/pinSession", setMembership("pinnedSessionIds", "pinned", true));
    rpc.register("workspace/unpinSession", setMembership("pinnedSessionIds", "pinned", false));
    streams.register("workspace/follow", (_args, sink) => {
      this.followers.add(sink);
      sink.onClose(() => this.followers.delete(sink));
      sink.push({ type: "baseline", value: this.state });
    });
  }

  private require(workspaceId: string): WorkspaceView {
    const workspace = this.get(workspaceId);
    if (workspace === undefined)
      throw new RpcError("workspace/not-found", `Unknown workspace ${workspaceId}`, {
        workspaceId,
      });
    return workspace;
  }
}
