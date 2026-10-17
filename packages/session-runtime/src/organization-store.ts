import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { OwnedSessionDataStore } from "./ownership-lock.js";

export interface LocalWorkspace {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
  origin: "web";
}
export interface LocalOrganizationState {
  version: 1;
  items: LocalWorkspace[];
  archivedSessionIds: string[];
  pinnedSessionIds: string[];
}
export const LOCAL_ORGANIZATION_FILE = "organization-v1.json";
export function emptyLocalOrganization(): LocalOrganizationState {
  return { version: 1, items: [], archivedSessionIds: [], pinnedSessionIds: [] };
}
function validateOrganizationState(value: unknown): LocalOrganizationState {
  if (!value || typeof value !== "object") throw new Error("organization-schema-unsupported");
  const state = value as LocalOrganizationState;
  if (
    state.version !== 1 ||
    !Array.isArray(state.items) ||
    !Array.isArray(state.archivedSessionIds) ||
    !Array.isArray(state.pinnedSessionIds)
  )
    throw new Error("organization-schema-unsupported");
  const ids = new Set<string>(),
    members = new Set<string>();
  for (const workspace of state.items) {
    if (
      !workspace ||
      typeof workspace.workspaceId !== "string" ||
      !workspace.workspaceId ||
      ids.has(workspace.workspaceId) ||
      workspace.origin !== "web" ||
      typeof workspace.path !== "string" ||
      !isAbsolute(workspace.path) ||
      typeof workspace.title !== "string" ||
      !Array.isArray(workspace.sessionIds) ||
      !Number.isFinite(Date.parse(workspace.createdAt)) ||
      !Number.isFinite(Date.parse(workspace.updatedAt))
    )
      throw new Error("organization-schema-invalid");
    ids.add(workspace.workspaceId);
    for (const id of workspace.sessionIds) {
      if (typeof id !== "string" || !id || members.has(id))
        throw new Error("organization-schema-invalid");
      members.add(id);
    }
  }
  for (const refs of [state.archivedSessionIds, state.pinnedSessionIds])
    if (refs.some((id) => typeof id !== "string" || !id) || new Set(refs).size !== refs.length)
      throw new Error("organization-schema-invalid");
  return state;
}

/** Organization for this one owner only. External project/pin projection is not persisted here. */
export class LocalSessionOrganization {
  private state: LocalOrganizationState;
  private listeners = new Set<() => void>();
  constructor(
    private readonly data: Pick<OwnedSessionDataStore, "readJson" | "writeJson">,
    private readonly owns: (id: string) => boolean,
  ) {
    this.state = validateOrganizationState(
      data.readJson(LOCAL_ORGANIZATION_FILE, emptyLocalOrganization()),
    );
  }
  snapshot(): LocalOrganizationState {
    return structuredClone(this.state);
  }
  list(): LocalWorkspace[] {
    return this.snapshot().items;
  }
  get(id: string): LocalWorkspace | undefined {
    return this.list().find((item) => item.workspaceId === id);
  }
  ownerOf(id: string): LocalWorkspace | undefined {
    return this.list().find((item) => item.sessionIds.includes(id));
  }
  isArchived(id: string): boolean {
    return this.state.archivedSessionIds.includes(id);
  }
  pinnedSessionIds(): string[] {
    return [...this.state.pinnedSessionIds];
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private save(next: LocalOrganizationState): void {
    this.data.writeJson(LOCAL_ORGANIZATION_FILE, next);
    this.state = next;
    for (const listener of this.listeners) listener();
  }
  private requireSession(id: string): void {
    if (!this.owns(id)) throw new Error("session-not-found");
  }
  private requireWorkspace(state: LocalOrganizationState, id: string): LocalWorkspace {
    const workspace = state.items.find((item) => item.workspaceId === id);
    if (!workspace) throw new Error("workspace-not-found");
    return workspace;
  }
  create(path: string): { workspace: LocalWorkspace; created: boolean } {
    if (!isAbsolute(path)) throw new Error("workspace-invalid-path");
    const absolute = resolve(path),
      existing = this.state.items.find((item) => item.path === absolute);
    if (existing) return { workspace: structuredClone(existing), created: false };
    try {
      if (!statSync(absolute).isDirectory()) throw new Error("workspace-invalid-path");
    } catch {
      throw new Error("workspace-invalid-path");
    }
    const now = new Date().toISOString();
    const workspace: LocalWorkspace = {
      workspaceId: randomUUID(),
      path: absolute,
      title: absolute.split(/[\\/]/).pop() || absolute,
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
      origin: "web",
    };
    const next = this.snapshot();
    next.items.push(workspace);
    this.save(next);
    return { workspace: structuredClone(workspace), created: true };
  }
  attachSession(
    id: string,
    workspaceId: string | undefined,
    cwd: string | undefined,
  ): LocalWorkspace {
    // A newly created session may not yet be in its caller's index; core commits it first.
    this.requireSession(id);
    let workspace = workspaceId ? this.get(workspaceId) : undefined;
    if (!workspace && cwd) workspace = this.create(cwd).workspace;
    if (!workspace) throw new Error("workspace-invalid-path");
    return this.insertSessionBefore(workspace.workspaceId, id);
  }
  rename(id: string, title: string): LocalWorkspace {
    if (typeof title !== "string" || title.length > 4096)
      throw new Error("workspace-title-invalid");
    const next = this.snapshot(),
      workspace = this.requireWorkspace(next, id);
    workspace.title = title;
    workspace.updatedAt = new Date().toISOString();
    this.save(next);
    return structuredClone(workspace);
  }
  delete(id: string): void {
    const next = this.snapshot();
    this.requireWorkspace(next, id);
    next.items = next.items.filter((item) => item.workspaceId !== id);
    this.save(next);
  }
  insertBefore(id: string, before?: string): string[] {
    const next = this.snapshot(),
      workspace = this.requireWorkspace(next, id);
    next.items = next.items.filter((item) => item.workspaceId !== id);
    const at =
      before === undefined
        ? next.items.length
        : next.items.findIndex((item) => item.workspaceId === before);
    next.items.splice(at < 0 ? next.items.length : at, 0, workspace);
    this.save(next);
    return next.items.map((item) => item.workspaceId);
  }
  insertSessionBefore(workspaceId: string, id: string, before?: string): LocalWorkspace {
    this.requireSession(id);
    const next = this.snapshot(),
      workspace = this.requireWorkspace(next, workspaceId);
    for (const item of next.items)
      item.sessionIds = item.sessionIds.filter((existing) => existing !== id);
    const at = before === undefined ? 0 : workspace.sessionIds.indexOf(before);
    workspace.sessionIds.splice(at < 0 ? workspace.sessionIds.length : at, 0, id);
    workspace.updatedAt = new Date().toISOString();
    this.save(next);
    return structuredClone(workspace);
  }
  setArchived(id: string, value: boolean): string[] {
    return this.membership("archivedSessionIds", id, value);
  }
  setPinned(id: string, value: boolean): string[] {
    return this.membership("pinnedSessionIds", id, value);
  }
  private membership(
    key: "archivedSessionIds" | "pinnedSessionIds",
    id: string,
    value: boolean,
  ): string[] {
    this.requireSession(id);
    const next = this.snapshot();
    next[key] = next[key].filter((existing) => existing !== id);
    if (value) next[key].push(id);
    this.save(next);
    return [...next[key]];
  }
}
