/**
 * Pure data helpers for the Hero location + project two-step picker:
 * merges workspace-derived hosts with configured remote peers (including peers
 * with zero workspaces), filters locations/projects by search text, and derives
 * compact parent-folder hints.
 */
import type { WorkspaceView } from "@deepseek-ai/dsh-api-workspace-controller/client";
import { deriveAvailableHosts, type HostSummary } from "./rows/host-scope-filter.ts";

export interface ConfiguredRemotePeer {
  readonly hostId: string;
  readonly name: string;
  readonly state: string;
  readonly enabled: boolean;
}

export interface HeroLocationOption {
  readonly key: string;
  readonly hostId?: string;
  readonly displayName?: string;
  readonly state?: string;
  readonly workspaces: readonly WorkspaceView[];
}

/**
 * Merge hosts discovered from `workspaces` with configured remote peers so
 * connected (or offline) peers with zero workspaces still appear as selectable
 * work locations. Always starts with `"local"`.
 */
export function buildHeroLocationOptions(
  workspaces: readonly WorkspaceView[],
  configuredPeers: readonly ConfiguredRemotePeer[],
): HeroLocationOption[] {
  const derived = deriveAvailableHosts(workspaces);
  const localFromDerived = derived.find((host) => host.key === "local");
  const localOption: HeroLocationOption = localFromDerived ?? {
    key: "local",
    workspaces: [],
  };

  const remoteByHostId = new Map<string, HeroLocationOption>();
  for (const host of derived) {
    if (host.key === "local" || host.hostId === undefined) continue;
    remoteByHostId.set(host.hostId, host);
  }

  for (const peer of configuredPeers) {
    if (!peer.enabled) continue;
    const existing = remoteByHostId.get(peer.hostId);
    if (existing !== undefined) {
      remoteByHostId.set(peer.hostId, {
        ...existing,
        displayName: peer.name || existing.displayName,
        state: peer.state || existing.state,
      });
    } else {
      remoteByHostId.set(peer.hostId, {
        key: peer.hostId,
        hostId: peer.hostId,
        displayName: peer.name,
        state: peer.state,
        workspaces: [],
      });
    }
  }

  return [localOption, ...remoteByHostId.values()];
}

/** Resolve the host key owning `workspaceId`, defaulting to `"local"`. */
export function hostKeyOfWorkspace(
  workspaces: readonly WorkspaceView[],
  workspaceId: string | undefined,
): string {
  if (workspaceId === undefined) return "local";
  const found = workspaces.find((item) => item.workspaceId === workspaceId);
  return found?.remote?.hostId ?? "local";
}

/** Case-insensitive substring filter for work locations. */
export function filterHeroLocations(
  locations: readonly HeroLocationOption[],
  query: string,
  localLabel: string,
): HeroLocationOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...locations];
  return locations.filter((loc) => {
    const label = loc.key === "local" ? localLabel : (loc.displayName ?? loc.hostId ?? loc.key);
    return (
      label.toLowerCase().includes(needle) ||
      (loc.hostId !== undefined && loc.hostId.toLowerCase().includes(needle))
    );
  });
}

/** Case-insensitive substring filter for projects on a single host. */
export function filterHeroProjects(
  projects: readonly WorkspaceView[],
  query: string,
  titleOf: (workspace: WorkspaceView) => string,
): WorkspaceView[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...projects];
  return projects.filter((workspace) => {
    const title = titleOf(workspace).toLowerCase();
    const path = (workspace.path ?? "").toLowerCase();
    return title.includes(needle) || path.includes(needle);
  });
}

/**
 * Derive a subtle secondary hint (immediate parent folder name) for a project
 * path when it adds disambiguation context beyond the project title itself.
 */
export function workspaceParentHint(path: string | undefined, title: string): string | undefined {
  if (!path) return undefined;
  const normalized = path.replace(/[\\/]+$/u, "");
  if (!normalized) return undefined;
  const parts = normalized.split(/[\\/]+/u).filter(Boolean);
  if (parts.length < 2) return undefined;
  const parent = parts[parts.length - 2];
  if (!parent || parent === title || parent === "~" || parent === "Users" || parent === "home") {
    return undefined;
  }
  return parent;
}

/** Parse a `codexhost/remote-peers/list` RPC envelope defensively. */
export function parseConfiguredRemotePeers(payload: unknown): ConfiguredRemotePeer[] {
  if (typeof payload !== "object" || payload === null) return [];
  const result = (payload as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) return [];
  const envelope = result as { ok?: unknown; value?: unknown; peers?: unknown };
  const container =
    envelope.ok === true && typeof envelope.value === "object" && envelope.value !== null
      ? (envelope.value as { peers?: unknown })
      : envelope;
  const peers = container.peers;
  if (!Array.isArray(peers)) return [];
  const out: ConfiguredRemotePeer[] = [];
  for (const item of peers) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (
      typeof record.hostId === "string" &&
      record.hostId !== "" &&
      typeof record.name === "string" &&
      typeof record.state === "string"
    ) {
      out.push({
        hostId: record.hostId,
        name: record.name,
        state: record.state,
        enabled: record.enabled !== false,
      });
    }
  }
  return out;
}

/** Match a newly created remote workspace after the Finder dialog finishes. */
export function findCreatedRemoteWorkspace(
  workspaces: readonly WorkspaceView[],
  target: { readonly hostId: string; readonly path: string; readonly workspaceId?: string },
): WorkspaceView | undefined {
  if (target.workspaceId !== undefined) {
    const byId = workspaces.find((w) => w.workspaceId === target.workspaceId);
    if (byId !== undefined) return byId;
  }
  const normalizedTarget = target.path.replace(/[\\/]+$/u, "");
  return workspaces.find(
    (w) =>
      w.remote?.hostId === target.hostId && w.path.replace(/[\\/]+$/u, "") === normalizedTarget,
  );
}

export type { HostSummary };
