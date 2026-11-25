/** Workspace registry and the `workspace/*` Remote surface. */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { ThreadCatalogReadParams } from "@codexhost/shared-contracts";

import { type DataDir, requestOf } from "./store.ts";
import { RpcError, type RpcRegistry, type StreamRegistry, type StreamSink } from "./transport.ts";

export interface WorkspaceView {
  remote?: { hostId: string; displayName: string; state: string; color?: string };
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
  origin?: "web" | "codexhost";
  projectId?: string;
}

export interface ProjectCommands {
  create(path: string): Promise<{ workspace: WorkspaceView; created: boolean } | undefined>;
  rename(workspaceId: string, title: string): Promise<{ workspace: WorkspaceView } | undefined>;
  delete(workspaceId: string): Promise<{ deleted: true } | undefined>;
  insertBefore(
    workspaceId: string,
    beforeWorkspaceId?: string,
  ): Promise<{ workspaceIds: string[] } | undefined>;
  insertSessionBefore(
    workspaceId: string,
    sessionId: string,
    beforeSessionId?: string,
  ): Promise<{ workspace: WorkspaceView } | undefined>;
}

export function nativeProjectWorkspaceId(projectId: string): string {
  return `codex-project:${projectId}`;
}

function insertSessionId(ids: readonly string[], sessionId: string, beforeId?: string): string[] {
  const rest = ids.filter((id) => id !== sessionId);
  const index = beforeId === undefined ? rest.length : rest.indexOf(beforeId);
  rest.splice(index < 0 ? rest.length : index, 0, sessionId);
  return rest;
}

interface WorkspaceState {
  /** Web-created assignments keyed by the Host-qualified Web Session ID. */
  remoteProjectIds?: Record<string, string>;
  items: WorkspaceView[];
  archivedSessionIds: string[];
  pinnedSessionIds: string[];
  /** Local folders explicitly removed from the Web workspace list. */
  deletedPaths?: string[];
  /** Set once workspaces are reordered in Web; native project roots then stop following the
   * GUI project order. */
  manualOrder?: boolean;
  /** Unified sidebar display order across local and remote workspaces (local Hub only). */
  displayOrder?: string[];
}

const FILE = "workspaces.json";

function remoteWorkspaceHostId(workspaceId: string): string | undefined {
  if (!workspaceId.startsWith("remote-workspace:")) return undefined;
  const payload = workspaceId.slice("remote-workspace:".length);
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      parsed[0]
    ) {
      return parsed[0];
    }
  } catch {
    /* Non-base64url remote workspace IDs have no encoded hostId. */
  }
  return undefined;
}

/**
 * Merge persisted `displayOrder` (retaining offline remote slots) with currently visible workspaces.
 * Unseen remote workspaces whose host already appears in `displayOrder` slot right after that
 * host's last known entry; all other unseen workspaces append to the tail in incoming order.
 */
function mergeDisplayOrder(
  displayOrder: readonly string[] | undefined,
  visible: readonly WorkspaceView[],
): string[] {
  if (!displayOrder || displayOrder.length === 0) {
    return [...new Set(visible.map((workspace) => workspace.workspaceId))];
  }
  const knownOrder: string[] = [];
  const knownSet = new Set<string>();
  for (const id of displayOrder) {
    if (!knownSet.has(id)) {
      knownSet.add(id);
      knownOrder.push(id);
    }
  }
  const visibleById = new Map(visible.map((workspace) => [workspace.workspaceId, workspace]));
  const lastHostIndex = new Map<string, number>();
  for (const [i, id] of knownOrder.entries()) {
    const hostId = visibleById.get(id)?.remote?.hostId ?? remoteWorkspaceHostId(id);
    if (hostId !== undefined) lastHostIndex.set(hostId, i);
  }
  const insertAfter = new Map<number, string[]>();
  const tail: string[] = [];
  for (const workspace of visible) {
    const id = workspace.workspaceId;
    if (knownSet.has(id)) continue;
    knownSet.add(id);
    const hostId = workspace.remote?.hostId ?? remoteWorkspaceHostId(id);
    const hostSlot = hostId === undefined ? undefined : lastHostIndex.get(hostId);
    if (hostSlot !== undefined) {
      let bucket = insertAfter.get(hostSlot);
      if (!bucket) {
        bucket = [];
        insertAfter.set(hostSlot, bucket);
      }
      bucket.push(id);
    } else {
      tail.push(id);
    }
  }
  const merged: string[] = [];
  for (const [i, id] of knownOrder.entries()) {
    merged.push(id);
    const after = insertAfter.get(i);
    if (after) merged.push(...after);
  }
  merged.push(...tail);
  return merged;
}

function workspacePath(path: string): string {
  const expanded = path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
  if (!isAbsolute(expanded))
    throw new RpcError("workspace/invalid-path", `Workspace path must be absolute: ${path}`, {
      path,
    });
  return resolve(expanded);
}

interface NativeProject {
  name: string;
  rootPaths: string[];
}

/** One native project root folder and every project that lists it. */
interface ProjectRoot {
  path: string;
  title: string;
  /** Each project listing the folder, with the folder's position among its roots. */
  listings: { project: NativeProject; index: number }[];
}

/** The distinct root folders of the native projects, in project order then root order.
 *
 * Several projects may list the same folder. A folder that is the first root of a project
 * carries that project's name (the earliest such project); any other folder uses its folder
 * name, or the full path when that name is empty (the filesystem root). Titles are compared
 * between different folders only. Duplicate project names fall back to full paths; a folder
 * name falls back to its full path if it matches another folder or a project name. */
function projectRoots(projects: readonly NativeProject[]): ProjectRoot[] {
  const named = new Map<string, NativeProject>();
  for (const project of projects) {
    const first = project.rootPaths[0];
    if (first !== undefined && !named.has(resolve(first))) named.set(resolve(first), project);
  }
  const roots = new Map<string, ProjectRoot & { named: boolean }>();
  for (const project of projects)
    for (const [index, root] of project.rootPaths.entries()) {
      const path = resolve(root);
      const listed = roots.get(path);
      if (listed) {
        listed.listings.push({ project, index });
        continue;
      }
      const owner = named.get(path);
      roots.set(path, {
        path,
        title: owner ? owner.name : basename(path) || path,
        listings: [{ project, index }],
        named: owner !== undefined,
      });
    }
  const counts = new Map<string, number>();
  const nameCounts = new Map<string, number>();
  for (const root of roots.values()) {
    counts.set(root.title, (counts.get(root.title) ?? 0) + 1);
    if (root.named) nameCounts.set(root.title, (nameCounts.get(root.title) ?? 0) + 1);
  }
  return [...roots.values()].map(({ named: isNamed, ...root }) => {
    // A project name only conflicts with another project name; a folder name
    // conflicts with any other root title.
    const conflicting = ((isNamed ? nameCounts : counts).get(root.title) ?? 0) > 1;
    return conflicting ? { ...root, title: root.path } : root;
  });
}

/** Sidebar title of every native project root folder, keyed by resolved path. */
export function projectRootTitles(projects: readonly NativeProject[]): Map<string, string> {
  return new Map(projectRoots(projects).map((root) => [root.path, root.title]));
}

/** One native Thread section and the Workspaces of the Desktop projects placed in it. */
export interface ThreadSectionView {
  id: string;
  name: string;
  threadIds: string[];
  /** Omitted when Desktop placed no registered project in the section. */
  workspaceIds?: string[];
}

/**
 * The root folders of the Desktop projects in each section, in the section's project order and
 * then root order.
 *
 * A Workspace is one folder, and a project may list several folders. A folder titled after a
 * project (its first root) takes that project's place, so it stays out of sections when that
 * project does; any other folder joins the first section and project listing it.
 */
function sectionRootPaths(
  projects: readonly { id: string; rootPaths: readonly string[] }[],
  sectionProjects: Readonly<Record<string, readonly string[]>>,
  sectionIds: readonly string[],
): Map<string, string[]> {
  // Same naming owner as `projectRoots`: the earliest project whose first root is the folder.
  const namedBy = new Map<string, string>();
  for (const project of projects) {
    const first = project.rootPaths[0];
    if (first !== undefined && !namedBy.has(resolve(first)))
      namedBy.set(resolve(first), project.id);
  }
  const byId = new Map(projects.map((project) => [project.id, project]));
  const listed = new Set<string>();
  const placed = new Set<string>();
  const result = new Map<string, string[]>();
  for (const sectionId of sectionIds) {
    const paths: string[] = [];
    for (const projectId of sectionProjects[sectionId] ?? []) {
      if (listed.has(projectId)) continue;
      listed.add(projectId);
      for (const root of byId.get(projectId)?.rootPaths ?? []) {
        const path = resolve(root);
        const owner = namedBy.get(path);
        if (placed.has(path) || (owner !== undefined && owner !== projectId)) continue;
        placed.add(path);
        paths.push(path);
      }
    }
    result.set(sectionId, paths);
  }
  return result;
}

/** Title the pre-deduplication logic assigned to a project root. */
function legacyProjectRootTitle(project: { name: string }, index: number, path: string): string {
  return index === 0 ? project.name : basename(path);
}

/**
 * Whether a Web workspace title is a default an older build gave this folder, not a custom one.
 * Older builds used the project name for every root, then folder names, then the full path for
 * a folder shared by several projects; a shared folder could get its default from any project
 * listing it.
 */
function isLegacyDefaultTitle(
  title: string,
  path: string,
  listings: ProjectRoot["listings"],
): boolean {
  return (
    title === path ||
    listings.some(
      ({ project, index }) =>
        title === project.name || title === legacyProjectRootTitle(project, index, path),
    )
  );
}

export class Workspaces {
  private state: WorkspaceState;
  private nativeWorkspaces: WorkspaceView[] | undefined;
  private nativeRoots = new Map<string, string[]>();
  private legacyAssignments: Readonly<Record<string, string>> = {};
  private readonly followers = new Set<StreamSink>();
  private referenceGroups: Map<string, string | undefined> | undefined;
  private referenceProjectless: ReadonlySet<string> = new Set();
  private referencePins: string[] | undefined;
  private referenceProjectRoots: ReadonlySet<string> = new Set();
  private referenceArchives: string[] | undefined;
  private remoteArchives: readonly string[] = [];
  private remoteGroups: WorkspaceView[] = [];

  setRemoteGroups(groups: WorkspaceView[]): void {
    const previousOrder = this.list().map((group) => group.workspaceId);
    const previous = new Map(this.remoteGroups.map((group) => [group.workspaceId, group]));
    this.remoteGroups = groups;
    const current = new Set(groups.map((group) => group.workspaceId));
    for (const id of previous.keys())
      if (!current.has(id)) this.broadcast({ type: "remove", workspaceId: id });
    for (const workspace of groups)
      if (JSON.stringify(previous.get(workspace.workspaceId)) !== JSON.stringify(workspace))
        this.broadcast({ type: "upsert", workspace });
    const nextOrder = this.list().map((group) => group.workspaceId);
    if (JSON.stringify(previousOrder) !== JSON.stringify(nextOrder))
      this.broadcast({
        type: "order",
        workspaceIds: nextOrder,
      });
  }

  /** Remove persisted sidebar order entries belonging to a permanently removed remote host. */
  removeRemoteHostOrder(hostId: string): void {
    const current = this.state.displayOrder;
    if (!current || current.length === 0) return;
    const remoteHostIds = new Map(
      this.remoteGroups.flatMap((group) =>
        group.remote ? [[group.workspaceId, group.remote.hostId] as const] : [],
      ),
    );
    const encodedPrefix = `remote-workspace:${encodeURIComponent(hostId)}:`;
    const next = current.filter(
      (id) =>
        remoteWorkspaceHostId(id) !== hostId &&
        remoteHostIds.get(id) !== hostId &&
        !id.startsWith(encodedPrefix),
    );
    if (next.length === current.length) return;
    const { displayOrder, ...rest } = this.state;
    void displayOrder;
    const state: WorkspaceState = next.length > 0 ? { ...rest, displayOrder: next } : rest;
    this.data.writeJson(FILE, state);
    this.state = state;
  }

  constructor(
    private readonly data: DataDir,
    private readonly defaultDirectory: string,
    private readonly referenceOnlyDefault = false,
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

  rememberRemoteProject(sessionId: string, projectId: string): void {
    (this.state.remoteProjectIds ??= {})[sessionId] = projectId;
    this.save();
  }

  remoteProjectId(sessionId: string): string | undefined {
    return this.state.remoteProjectIds?.[sessionId];
  }

  private broadcast(frame: unknown): void {
    for (const sink of this.followers) sink.push(frame);
  }

  private touch(workspace: WorkspaceView): void {
    workspace.updatedAt = new Date().toISOString();
    this.save();
    const visible = this.list().find((item) => item.workspaceId === workspace.workspaceId);
    if (visible) this.broadcast({ type: "upsert", workspace: visible });
  }

  list(): readonly WorkspaceView[] {
    const references = this.referenceGroups;
    const items = this.state.items;
    let base: WorkspaceView[];
    if (this.nativeWorkspaces) {
      base = [...this.remoteGroups, ...this.nativeWorkspaces];
    } else if (!references) {
      base = [...this.remoteGroups, ...items];
    } else {
      const allowedRoots = new Set(
        [...references.values()].filter((path): path is string => path !== undefined),
      );
      base = [
        ...this.remoteGroups,
        ...items
          .filter((workspace) => {
            // Legacy automatic rows from the previous build are hidden, not deleted.
            const legacyReference =
              workspace.origin === undefined &&
              workspace.sessionIds.length > 0 &&
              workspace.sessionIds.some((id) => references.has(id)) &&
              workspace.sessionIds.every((id) => references.has(id) || id.startsWith("draft-"));
            return (
              workspace.origin === "web" ||
              !(workspace.origin === "codexhost" || legacyReference) ||
              allowedRoots.has(workspace.path) ||
              this.referenceProjectRoots.has(workspace.path)
            );
          })
          .map((workspace) => ({
            ...workspace,
            sessionIds: workspace.sessionIds.filter(
              (id) =>
                !references.has(id) ||
                references.get(id) === workspace.path ||
                (workspace.origin === "web" &&
                  references.get(id) === undefined &&
                  !this.referenceProjectless.has(id)),
            ),
          })),
      ];
    }
    if (!this.state.displayOrder || this.state.displayOrder.length === 0) return base;
    const visibleById = new Map(base.map((workspace) => [workspace.workspaceId, workspace]));
    return mergeDisplayOrder(this.state.displayOrder, base).flatMap((id) => {
      const workspace = visibleById.get(id);
      return workspace ? [workspace] : [];
    });
  }

  isRemote(workspaceId: string): boolean {
    return this.remoteGroups.some((group) => group.workspaceId === workspaceId);
  }

  appendToDisplayOrderIfPresent(workspaceId: string): void {
    const current = this.state.displayOrder;
    if (!current || current.length === 0 || current.includes(workspaceId)) return;
    const state: WorkspaceState = {
      ...this.state,
      displayOrder: [...current, workspaceId],
    };
    this.data.writeJson(FILE, state);
    this.state = state;
  }

  removeFromDisplayOrder(workspaceId: string): void {
    const current = this.state.displayOrder;
    if (!current || !current.includes(workspaceId)) return;
    const next = current.filter((id) => id !== workspaceId);
    const { displayOrder, ...rest } = this.state;
    void displayOrder;
    const state: WorkspaceState = next.length > 0 ? { ...rest, displayOrder: next } : rest;
    this.data.writeJson(FILE, state);
    this.state = state;
  }

  reorderDisplayOrder(workspaceId: string, beforeWorkspaceId?: string): { workspaceIds: string[] } {
    const visible = this.list();
    if (!visible.some((item) => item.workspaceId === workspaceId))
      throw new RpcError("workspace/not-found", `Unknown workspace ${workspaceId}`, {
        workspaceId,
      });
    const currentVisibleIds = visible.map((item) => item.workspaceId);
    if (beforeWorkspaceId === workspaceId) return { workspaceIds: currentVisibleIds };
    const merged = mergeDisplayOrder(this.state.displayOrder, visible);
    const rest = merged.filter((id) => id !== workspaceId);
    const index = beforeWorkspaceId === undefined ? rest.length : rest.indexOf(beforeWorkspaceId);
    rest.splice(index < 0 ? rest.length : index, 0, workspaceId);
    if (rest.every((id, i) => id === merged[i])) return { workspaceIds: currentVisibleIds };
    const rank = new Map(rest.map((id, i) => [id, i]));
    const nextItems = [...this.state.items].sort(
      (left, right) =>
        (rank.get(left.workspaceId) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(right.workspaceId) ?? Number.MAX_SAFE_INTEGER),
    );
    const state: WorkspaceState = {
      ...this.state,
      items: nextItems,
      displayOrder: rest,
      manualOrder: true,
    };
    this.data.writeJson(FILE, state);
    this.state = state;
    const workspaceIds = this.list().map((item) => item.workspaceId);
    this.broadcast({ type: "order", workspaceIds });
    return { workspaceIds };
  }

  reorderDisplayOrderIfPresent(workspaceId: string, beforeWorkspaceId?: string): void {
    if (!this.state.displayOrder || this.state.displayOrder.length === 0) return;
    this.reorderDisplayOrder(workspaceId, beforeWorkspaceId);
  }

  get usesNativeProjects(): boolean {
    return this.nativeWorkspaces !== undefined;
  }

  syncNativeProjects(
    projects: readonly { id: string; name: string; rootPaths: string[] }[],
    groups: ReadonlyMap<string, string | undefined>,
    legacyAssignments: Readonly<Record<string, string>>,
  ): void {
    const before = this.list();
    const previous = new Map(this.nativeWorkspaces?.map((item) => [item.projectId, item]));
    const members = new Map<string, string[]>();
    for (const [sessionId, projectId] of groups) {
      if (projectId === undefined) continue;
      const entries = members.get(projectId) ?? [];
      if (!members.has(projectId)) members.set(projectId, entries);
      entries.push(sessionId);
    }
    const now = new Date().toISOString();
    this.nativeRoots = new Map(projects.map((project) => [project.id, project.rootPaths]));
    this.legacyAssignments = legacyAssignments;
    this.nativeWorkspaces = projects.map((project) => {
      const current = members.get(project.id) ?? [];
      const memberIds = new Set(current);
      // Keep the order sessions already had in Web; only newly listed members are appended.
      const kept = (previous.get(project.id)?.sessionIds ?? []).filter((id) => memberIds.has(id));
      const keptIds = new Set(kept);
      return {
        workspaceId: nativeProjectWorkspaceId(project.id),
        projectId: project.id,
        path: project.rootPaths[0] ?? "",
        title: project.name,
        sessionIds: [...kept, ...current.filter((id) => !keptIds.has(id))],
        createdAt: previous.get(project.id)?.createdAt ?? now,
        updatedAt: previous.get(project.id)?.updatedAt ?? now,
        origin: "codexhost",
      };
    });
    this.publishWorkspaceChanges(before);
  }

  updateNativeProjectMember(sessionId: string, projectId: string | undefined): void {
    if (!this.nativeWorkspaces || !projectId) return;
    const item = this.nativeWorkspaces.find((workspace) => workspace.projectId === projectId);
    if (!item) return;
    this.detachFromOtherNativeProjects(sessionId, item, new Date().toISOString());
    if (item.sessionIds.includes(sessionId)) return;
    item.sessionIds = [...item.sessionIds, sessionId];
    this.broadcast({ type: "upsert", workspace: item });
  }

  /** Show a session only in its native project, at the requested place; Codex owns membership. */
  placeNativeSession(
    workspaceId: string,
    sessionId: string,
    beforeSessionId?: string,
  ): WorkspaceView {
    const workspace = this.require(workspaceId);
    const now = new Date().toISOString();
    this.detachFromOtherNativeProjects(sessionId, workspace, now);
    workspace.sessionIds = insertSessionId(workspace.sessionIds, sessionId, beforeSessionId);
    workspace.updatedAt = now;
    this.broadcast({ type: "upsert", workspace });
    return workspace;
  }

  private detachFromOtherNativeProjects(
    sessionId: string,
    target: WorkspaceView,
    now: string,
  ): void {
    for (const other of this.nativeWorkspaces ?? []) {
      if (other === target || !other.sessionIds.includes(sessionId)) continue;
      other.sessionIds = other.sessionIds.filter((id) => id !== sessionId);
      other.updatedAt = now;
      this.broadcast({ type: "upsert", workspace: other });
    }
  }

  private publishWorkspaceChanges(before: readonly WorkspaceView[]): void {
    const previous = new Map(
      before.map((workspace) => [workspace.workspaceId, JSON.stringify(workspace)]),
    );
    const after = this.list();
    const ids = new Set(after.map((workspace) => workspace.workspaceId));
    for (const workspaceId of previous.keys())
      if (!ids.has(workspaceId)) this.broadcast({ type: "remove", workspaceId });
    for (const workspace of after)
      if (previous.get(workspace.workspaceId) !== JSON.stringify(workspace))
        this.broadcast({ type: "upsert", workspace });
    const workspaceIds = [...ids];
    if (JSON.stringify([...previous.keys()]) !== JSON.stringify(workspaceIds))
      this.broadcast({ type: "order", workspaceIds });
  }

  /** Replace only the shared navigation view; never delete user records or any directories. */
  addDraftReference(sessionId: string, cwd: string | undefined): void {
    const projectless = new Set(this.referenceProjectless);
    if (cwd) projectless.delete(sessionId);
    else projectless.add(sessionId);
    this.setReferenceGroups(
      new Map([...(this.referenceGroups ?? []), [sessionId, cwd ? resolve(cwd) : undefined]]),
      projectless,
    );
  }

  setReferenceGroups(
    groups: Map<string, string | undefined>,
    projectless: ReadonlySet<string> = new Set(),
  ): void {
    const before = this.list();
    this.referenceGroups = groups;
    this.referenceProjectless = projectless;
    const after = this.list();
    const ids = new Set(after.map((workspace) => workspace.workspaceId));
    for (const workspace of before)
      if (!ids.has(workspace.workspaceId))
        this.broadcast({ type: "remove", workspaceId: workspace.workspaceId });
    for (const workspace of after) {
      const old = before.find((item) => item.workspaceId === workspace.workspaceId);
      if (JSON.stringify(old) !== JSON.stringify(workspace))
        this.broadcast({ type: "upsert", workspace });
    }
    const beforeIds = before.map((workspace) => workspace.workspaceId);
    const afterIds = after.map((workspace) => workspace.workspaceId);
    if (JSON.stringify(beforeIds) !== JSON.stringify(afterIds))
      this.broadcast({ type: "order", workspaceIds: afterIds });
  }

  /** Ephemeral view of the native owner's pins. Never overwrite legacy local pin records. */
  setReferencePins(ids: readonly string[]): void {
    const next = [...new Set(ids)];
    if (JSON.stringify(next) === JSON.stringify(this.referencePins)) return;
    this.referencePins = next;
    this.broadcast({ type: "pinned", pinnedSessionIds: this.pinnedSessionIds() });
  }

  /** Read-only native Thread sections; only the app-server and Desktop persist them. */
  private referenceThreadSections: ThreadSectionView[] = [];

  hasThreadSection(id: string): boolean {
    return this.referenceThreadSections.some((section) => section.id === id);
  }

  /**
   * Publish native sections. Desktop's project members become the Workspaces of their root
   * folders, so call this after the project roots are synced into Workspaces.
   */
  setReferenceThreadSections(
    sections: ReadonlyArray<{ id: string; name: string; threadIds: string[] }>,
    projects: readonly { id: string; rootPaths: readonly string[] }[] = [],
    sectionProjects: Readonly<Record<string, readonly string[]>> = {},
  ): void {
    const paths = sectionRootPaths(
      projects,
      sectionProjects,
      sections.map((section) => section.id),
    );
    const next = sections.map((section): ThreadSectionView => {
      if (this.nativeWorkspaces) {
        const workspaceIds = (sectionProjects[section.id] ?? []).flatMap((id) => {
          const workspace = this.nativeWorkspaces?.find((item) => item.projectId === id);
          return workspace ? [workspace.workspaceId] : [];
        });
        return workspaceIds.length > 0 ? { ...section, workspaceIds } : { ...section };
      }
      const workspaceIds = (paths.get(section.id) ?? []).flatMap((path) => {
        const workspace = this.byPath(path);
        return workspace ? [workspace.workspaceId] : [];
      });
      return workspaceIds.length > 0 ? { ...section, workspaceIds } : { ...section };
    });
    if (JSON.stringify(next) === JSON.stringify(this.referenceThreadSections)) return;
    this.referenceThreadSections = next;
    this.broadcast({ type: "threadSections", threadSections: next });
  }

  /** Ephemeral Host archive projection; shared Threads never use legacy Web archive flags. */
  setReferenceArchives(ids: readonly string[]): void {
    const next = [...new Set(ids)];
    if (JSON.stringify(next) === JSON.stringify(this.referenceArchives)) return;
    this.referenceArchives = next;
    this.broadcast({ type: "archived", archivedSessionIds: this.archivedSessionIds() });
  }

  /** Confirmed remote archives augment, never replace, the local owner's projection. */
  setRemoteArchives(ids: readonly string[]): void {
    const next = [...new Set(ids)];
    if (JSON.stringify(next) === JSON.stringify(this.remoteArchives)) return;
    this.remoteArchives = next;
    this.broadcast({ type: "archived", archivedSessionIds: this.archivedSessionIds() });
  }

  /** Authoritative visible pin list used by both the stream and RPC replies. */
  pinnedSessionIds(): string[] {
    return this.referencePins === undefined
      ? this.state.pinnedSessionIds
      : [...new Set(this.referencePins)];
  }

  get(workspaceId: string): WorkspaceView | undefined {
    if (this.remoteGroups.some((group) => group.workspaceId === workspaceId))
      throw new RpcError(
        "workspace/remote-read-only",
        "This operation requires a local workspace; remote project paths belong to their Host.",
      );
    return (this.nativeWorkspaces ?? this.state.items).find(
      (item) => item.workspaceId === workspaceId,
    );
  }

  byPath(path: string): WorkspaceView | undefined {
    if (this.nativeWorkspaces)
      return this.nativeWorkspaces.find(
        (item) => item.projectId && this.nativeRoots.get(item.projectId)?.includes(path),
      );
    return this.state.items.find((item) => item.path === path);
  }

  /**
   * The folder whose Threads a local Workspace lists, without the folders of nested local
   * Workspaces, which list their own Threads. Remote or unknown Workspaces have none.
   */
  catalogScope(workspaceId: string): ThreadCatalogReadParams["scope"] {
    const local = this.list().filter((item) => !item.remote);
    const workspace = local.find((item) => item.workspaceId === workspaceId);
    if (!workspace) return undefined;
    if (workspace.projectId)
      return {
        projectId: workspace.projectId,
        legacyThreadIds: Object.keys(this.legacyAssignments)
          .filter((id) => this.legacyAssignments[id] === workspace.projectId)
          .slice(0, 1024),
        rootPaths: (this.nativeRoots.get(workspace.projectId) ?? []).slice(0, 1024),
      };
    const excludeCwds = local.flatMap((item) => {
      const nested = relative(workspace.path, item.path);
      return nested !== "" &&
        !isAbsolute(nested) &&
        nested !== ".." &&
        !nested.startsWith(`..${sep}`)
        ? [item.path]
        : [];
    });
    return { cwd: workspace.path, excludeCwds: excludeCwds.slice(0, 1_024) };
  }

  ownerOf(sessionId: string): WorkspaceView | undefined {
    return this.list().find((item) => item.sessionIds.includes(sessionId));
  }

  isArchived(sessionId: string): boolean {
    return this.archivedSessionIds().includes(sessionId);
  }
  /** Local owner facts used for local catalog reconciliation and archive notifications. */
  localArchivedSessionIds(): string[] {
    return [...(this.referenceArchives ?? this.state.archivedSessionIds)];
  }
  /** Combined navigation projection; never an input to either owner's reconciliation. */
  archivedSessionIds(): string[] {
    return [...new Set([...this.localArchivedSessionIds(), ...this.remoteArchives])];
  }

  create(path: string, referenceOnly = false): { workspace: WorkspaceView; created: boolean } {
    const absolute = workspacePath(path);
    if (!referenceOnly && (!existsSync(absolute) || !statSync(absolute).isDirectory())) {
      throw new RpcError("workspace/invalid-path", `Not a directory: ${absolute}`, { path });
    }
    const existing = this.byPath(absolute);
    if (existing !== undefined) {
      if (!referenceOnly && existing.origin !== "web") {
        existing.origin = "web";
        this.touch(existing);
      }
      return { workspace: existing, created: false };
    }
    const now = new Date().toISOString();
    const workspace: WorkspaceView = {
      workspaceId: randomUUID(),
      path: absolute,
      title: basename(absolute) || absolute,
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
      origin: referenceOnly ? "codexhost" : "web",
    };
    const displayOrder =
      this.state.displayOrder && this.state.displayOrder.length > 0
        ? [
            ...this.state.displayOrder.filter((id) => id !== workspace.workspaceId),
            workspace.workspaceId,
          ]
        : this.state.displayOrder;
    const state: WorkspaceState = {
      ...this.state,
      items: [...this.state.items, workspace],
      deletedPaths: (this.state.deletedPaths ?? []).filter(
        (deletedPath) => deletedPath !== absolute,
      ),
      ...(displayOrder !== undefined ? { displayOrder } : {}),
    };
    this.data.writeJson(FILE, state);
    this.state = state;
    this.broadcast({ type: "upsert", workspace });
    this.broadcast({
      type: "order",
      workspaceIds: this.list().map((item) => item.workspaceId),
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

  /** Mirror an authoritative CH cwd as a Web navigation entry, never mkdir or change the Thread. */
  attachReferencedSession(
    sessionId: string,
    cwd: string,
    title?: string,
  ): WorkspaceView | undefined {
    const workspace = this.referenceWorkspace(cwd);
    if (!workspace) return undefined;
    if (title && workspace.origin !== "web" && workspace.title !== title) {
      workspace.title = title;
      this.touch(workspace);
    }
    if (!workspace.sessionIds.includes(sessionId)) {
      workspace.sessionIds.push(sessionId);
      this.touch(workspace);
    }
    return workspace;
  }

  /** Mirror one complete CH workspace snapshot, saving and publishing only final changes. */
  syncReferencedSessions(
    sessions: readonly { sessionId: string; cwd: string; title?: string }[],
    groups: Map<string, string | undefined>,
    projectless: ReadonlySet<string> = new Set(),
    projects: readonly NativeProject[] = [],
  ): void {
    const before = new Map(
      this.list().map((workspace) => [workspace.workspaceId, JSON.stringify(workspace)]),
    );
    const items = this.state.items.map((workspace) => ({
      ...workspace,
      sessionIds: [...workspace.sessionIds],
    }));
    const byPath = new Map(items.map((workspace) => [workspace.path, workspace]));
    const members = new Map<string, Set<string>>();
    const now = new Date().toISOString();
    const deletedPaths = new Set(this.state.deletedPaths);
    const roots = projectRoots(projects);
    const rootPaths = new Set(roots.map((root) => root.path));
    for (const { path, title, listings } of roots) {
      if (deletedPaths.has(path)) continue;
      let workspace = byPath.get(path);
      if (!workspace) {
        workspace = {
          workspaceId: randomUUID(),
          path,
          title,
          sessionIds: [],
          createdAt: now,
          updatedAt: now,
          origin: "codexhost",
        };
        items.push(workspace);
        byPath.set(path, workspace);
      } else if (workspace.origin !== "web") workspace.title = title;
      else if (isLegacyDefaultTitle(workspace.title, path, listings)) workspace.title = title;
    }
    for (const { sessionId, cwd, title } of sessions) {
      let workspace = byPath.get(resolve(cwd));
      if (!workspace) {
        const path = workspacePath(cwd);
        if (deletedPaths.has(path)) continue;
        workspace = byPath.get(path);
        if (!workspace) {
          workspace = {
            workspaceId: randomUUID(),
            path,
            title: basename(path) || path,
            sessionIds: [],
            createdAt: now,
            updatedAt: now,
            origin: "codexhost",
          };
          items.push(workspace);
          byPath.set(path, workspace);
        }
      }
      if (title && workspace.origin !== "web") workspace.title = title;
      let ids = members.get(workspace.workspaceId);
      if (!ids) {
        ids = new Set(workspace.sessionIds);
        members.set(workspace.workspaceId, ids);
      }
      if (!ids.has(sessionId)) {
        ids.add(sessionId);
        workspace.sessionIds.push(sessionId);
      }
    }
    // Native project roots follow the GUI project order until workspaces are reordered in Web;
    // every other workspace keeps its place after them.
    const ordered = this.state.manualOrder
      ? items
      : [
          ...roots.flatMap((root) => byPath.get(root.path) ?? []),
          ...items.filter((workspace) => !rootPaths.has(workspace.path)),
        ];
    let changed =
      ordered.length !== this.state.items.length ||
      ordered.some(
        (workspace, index) => workspace.workspaceId !== this.state.items[index]?.workspaceId,
      );
    const originals = new Map(
      this.state.items.map((workspace) => [workspace.workspaceId, workspace]),
    );
    for (const workspace of ordered) {
      const original = originals.get(workspace.workspaceId);
      if (
        !original ||
        original.title !== workspace.title ||
        original.sessionIds.length !== workspace.sessionIds.length ||
        original.sessionIds.some((id, index) => id !== workspace.sessionIds[index])
      ) {
        workspace.updatedAt = now;
        changed = true;
      }
    }
    if (changed) {
      const currentOrder = this.state.displayOrder;
      const appendedIds =
        currentOrder && currentOrder.length > 0
          ? ordered
              .filter(
                (workspace) =>
                  !originals.has(workspace.workspaceId) &&
                  !currentOrder.includes(workspace.workspaceId),
              )
              .map((workspace) => workspace.workspaceId)
          : [];
      const state: WorkspaceState = {
        ...this.state,
        items: ordered,
        ...(appendedIds.length > 0
          ? { displayOrder: [...(currentOrder ?? []), ...appendedIds] }
          : {}),
      };
      this.data.writeJson(FILE, state);
      this.state = state;
    }
    this.referenceProjectRoots = rootPaths;
    this.referenceGroups = groups;
    this.referenceProjectless = projectless;
    const after = this.list();
    const ids = new Set(after.map((workspace) => workspace.workspaceId));
    for (const workspaceId of before.keys())
      if (!ids.has(workspaceId)) this.broadcast({ type: "remove", workspaceId });
    for (const workspace of after)
      if (before.get(workspace.workspaceId) !== JSON.stringify(workspace))
        this.broadcast({ type: "upsert", workspace });
    const workspaceIds = [...ids];
    if (JSON.stringify([...before.keys()]) !== JSON.stringify(workspaceIds))
      this.broadcast({ type: "order", workspaceIds });
  }

  /** An actual Web submission makes its selected folder an explicit Web workspace. */
  selectReferenceWorkspace(cwd: string): void {
    const workspace = this.referenceWorkspace(cwd);
    if (workspace && workspace.origin !== "web") {
      workspace.origin = "web";
      this.touch(workspace);
    }
  }

  private referenceWorkspace(cwd: string): WorkspaceView | undefined {
    const path = workspacePath(cwd);
    if (this.state.deletedPaths?.includes(path)) return undefined;
    return this.byPath(path) ?? this.create(path, true).workspace;
  }

  detachSession(sessionId: string): void {
    if (this.nativeWorkspaces) {
      for (const workspace of this.nativeWorkspaces) {
        if (!workspace.sessionIds.includes(sessionId)) continue;
        workspace.sessionIds = workspace.sessionIds.filter((id) => id !== sessionId);
        this.broadcast({ type: "upsert", workspace });
      }
      return;
    }
    for (const workspace of this.state.items) {
      const index = workspace.sessionIds.indexOf(sessionId);
      if (index >= 0) {
        workspace.sessionIds.splice(index, 1);
        this.touch(workspace);
      }
    }
  }

  register(rpc: RpcRegistry, streams: StreamRegistry, commands?: ProjectCommands): void {
    rpc.register("workspace/create", async (args) => {
      const { path } = requestOf<{ path: string }>(args);
      return (await commands?.create(path)) ?? this.create(path);
    });
    rpc.register("workspace/initializeDefault", async () => {
      if (this.usesNativeProjects) return undefined;
      if (this.state.items.length > 0 || this.state.deletedPaths?.includes(this.defaultDirectory))
        return undefined;
      if (!this.referenceOnlyDefault) mkdirSync(this.defaultDirectory, { recursive: true });
      return {
        workspace:
          (this.referenceOnlyDefault ? this.list()[0] : undefined) ??
          this.create(this.defaultDirectory, this.referenceOnlyDefault).workspace,
      };
    });
    rpc.register("workspace/rename", async (args) => {
      const request = requestOf<{ workspaceId: string; title: string }>(args);
      const native = await commands?.rename(request.workspaceId, request.title);
      if (native) return native;
      const workspace = this.require(request.workspaceId);
      workspace.title = request.title;
      this.touch(workspace);
      return { workspace };
    });
    rpc.register("workspace/delete", async (args) => {
      const request = requestOf<{ workspaceId: string }>(args);
      const native = await commands?.delete(request.workspaceId);
      if (native) return native;
      const workspace = this.require(request.workspaceId);
      const { displayOrder: currentDisplayOrder, ...stateWithoutDisplayOrder } = this.state;
      const nextDisplayOrder = currentDisplayOrder?.filter((id) => id !== request.workspaceId);
      const state: WorkspaceState = {
        ...stateWithoutDisplayOrder,
        items: this.state.items.filter((item) => item.workspaceId !== request.workspaceId),
        deletedPaths: [...(this.state.deletedPaths ?? []), workspace.path],
        ...(nextDisplayOrder && nextDisplayOrder.length > 0
          ? { displayOrder: nextDisplayOrder }
          : {}),
      };
      this.data.writeJson(FILE, state);
      this.state = state;
      this.broadcast({ type: "remove", workspaceId: request.workspaceId });
      return { deleted: true };
    });
    rpc.register("workspace/insertBefore", async (args) => {
      const request = requestOf<{ workspaceId: string; beforeWorkspaceId?: string }>(args);
      const native = await commands?.insertBefore(request.workspaceId, request.beforeWorkspaceId);
      if (native) return native;
      return this.reorderDisplayOrder(request.workspaceId, request.beforeWorkspaceId);
    });
    rpc.register("workspace/insertSessionBefore", async (args) => {
      const request = requestOf<{
        workspaceId: string;
        sessionId: string;
        beforeSessionId?: string;
      }>(args);
      const native = await commands?.insertSessionBefore(
        request.workspaceId,
        request.sessionId,
        request.beforeSessionId,
      );
      if (native) return native;
      const workspace = this.require(request.workspaceId);
      for (const other of this.state.items) {
        if (other !== workspace && other.sessionIds.includes(request.sessionId)) {
          other.sessionIds = other.sessionIds.filter((id) => id !== request.sessionId);
          this.touch(other);
        }
      }
      workspace.sessionIds = insertSessionId(
        workspace.sessionIds,
        request.sessionId,
        request.beforeSessionId,
      );
      this.touch(workspace);
      return { workspace };
    });
    const setMembership =
      (
        key: "archivedSessionIds" | "pinnedSessionIds",
        frame: "archived" | "pinned",
        add: boolean,
      ) =>
      async (args: Record<string, unknown>) => {
        const { sessionId } = requestOf<{ sessionId: string }>(args);
        const current = this.state[key].filter((id) => id !== sessionId);
        if (add) current.push(sessionId);
        this.state[key] = current;
        this.save();
        const visible =
          key === "pinnedSessionIds" ? this.pinnedSessionIds() : this.archivedSessionIds();
        this.broadcast({ type: frame, [key]: visible });
        return { [key]: visible };
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
      sink.push({
        type: "baseline",
        value: {
          items: this.list(),
          pinnedSessionIds: this.pinnedSessionIds(),
          threadSections: this.referenceThreadSections,
          archivedSessionIds: this.archivedSessionIds(),
          ...(this.referenceOnlyDefault ? { canStartProjectless: true } : {}),
        },
      });
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
