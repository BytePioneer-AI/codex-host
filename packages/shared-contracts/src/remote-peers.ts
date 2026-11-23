import { z } from "zod";

export const REMOTE_PEER_HOST_ID_PREFIX = "remote-peer:";
export const REMOTE_PEER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/u;

export const REMOTE_PEERS_METHODS = {
  list: "codexhost/remote-peers/list",
  add: "codexhost/remote-peers/add",
  update: "codexhost/remote-peers/update",
  remove: "codexhost/remote-peers/remove",
  reconnect: "codexhost/remote-peers/reconnect",
  test: "codexhost/remote-peers/test",
  listDirs: "codexhost/remote-peers/listDirs",
  createDir: "codexhost/remote-peers/createDir",
  createWorkspace: "codexhost/remote-peers/createWorkspace",
  renameWorkspace: "codexhost/remote-peers/renameWorkspace",
  deleteWorkspace: "codexhost/remote-peers/deleteWorkspace",
} as const;

export const REMOTE_PEERS_CHANGED_EVENT = "codexhost/remote-peers/changed";

export function remotePeerHostId(peerId: string): string {
  return `${REMOTE_PEER_HOST_ID_PREFIX}${peerId}`;
}

export function peerIdFromRemoteHostId(hostId: string): string | undefined {
  if (!hostId.startsWith(REMOTE_PEER_HOST_ID_PREFIX)) return undefined;
  const peerId = hostId.slice(REMOTE_PEER_HOST_ID_PREFIX.length);
  return REMOTE_PEER_ID_PATTERN.test(peerId) ? peerId : undefined;
}

export const remotePeerIdSchema = z.string().regex(REMOTE_PEER_ID_PATTERN);
export const remotePeerHostIdSchema = z.string().regex(/^remote-peer:[a-zA-Z0-9_-]{1,64}$/u);

export const remotePeerTransportKindSchema = z.enum(["relay", "tailscale", "lan", "custom"]);
export type RemotePeerTransportKind = z.infer<typeof remotePeerTransportKindSchema>;

export const remotePeerStateSchema = z.enum([
  "connected",
  "connecting",
  "auth-error",
  "offline",
  "disabled",
]);
export type RemotePeerState = z.infer<typeof remotePeerStateSchema>;

/** Browser-safe view of a configured remote peer; access tokens are never exposed. */
export const remotePeerSummarySchema = z.object({
  peerId: remotePeerIdSchema,
  hostId: remotePeerHostIdSchema,
  name: z.string().min(1).max(120),
  origin: z.string().min(1).max(2048),
  transportKind: remotePeerTransportKindSchema,
  encrypted: z.boolean(),
  enabled: z.boolean(),
  state: remotePeerStateSchema,
  latencyMs: z.number().int().nonnegative().optional(),
  version: z.string().max(128).optional(),
  platform: z.string().max(64).optional(),
  hostname: z.string().max(255).optional(),
  homeDir: z.string().max(4096).optional(),
  lastError: z.string().max(1000).optional(),
  projectCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RemotePeerSummary = z.infer<typeof remotePeerSummarySchema>;

export const remotePeerListResultSchema = z.object({
  peers: z.array(remotePeerSummarySchema),
});
export type RemotePeerListResult = z.infer<typeof remotePeerListResultSchema>;

export const remotePeerAddParamsSchema = z
  .object({
    connectionUrl: z.string().min(1).max(4096).optional(),
    origin: z.string().min(1).max(2048).optional(),
    token: z.string().min(1).max(2048).optional(),
    name: z.string().trim().min(1).max(120).optional(),
  })
  .refine(
    (input) => Boolean(input.connectionUrl) || (Boolean(input.origin) && Boolean(input.token)),
    "Provide either connectionUrl or both origin and token",
  );
export type RemotePeerAddParams = z.infer<typeof remotePeerAddParamsSchema>;

export const remotePeerUpdateParamsSchema = z.object({
  peerId: remotePeerIdSchema,
  name: z.string().trim().min(1).max(120).optional(),
  connectionUrl: z.string().min(1).max(4096).optional(),
  origin: z.string().min(1).max(2048).optional(),
  token: z.string().min(1).max(2048).optional(),
  enabled: z.boolean().optional(),
});
export type RemotePeerUpdateParams = z.infer<typeof remotePeerUpdateParamsSchema>;

export const remotePeerIdParamsSchema = z.object({
  peerId: remotePeerIdSchema,
});
export type RemotePeerIdParams = z.infer<typeof remotePeerIdParamsSchema>;

export const remotePeerRemoveResultSchema = z.object({
  removed: z.boolean(),
});
export type RemotePeerRemoveResult = z.infer<typeof remotePeerRemoveResultSchema>;

export const remotePeerTestParamsSchema = z
  .object({
    peerId: remotePeerIdSchema.optional(),
    connectionUrl: z.string().min(1).max(4096).optional(),
    origin: z.string().min(1).max(2048).optional(),
    token: z.string().min(1).max(2048).optional(),
  })
  .refine(
    (input) =>
      Boolean(input.peerId) ||
      Boolean(input.connectionUrl) ||
      (Boolean(input.origin) && Boolean(input.token)),
    "Provide peerId, connectionUrl, or both origin and token",
  );
export type RemotePeerTestParams = z.infer<typeof remotePeerTestParamsSchema>;

export const remotePeerTestResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative().optional(),
  origin: z.string().max(2048).optional(),
  transportKind: remotePeerTransportKindSchema.optional(),
  encrypted: z.boolean().optional(),
  version: z.string().max(128).optional(),
  platform: z.string().max(64).optional(),
  hostname: z.string().max(255).optional(),
  homeDir: z.string().max(4096).optional(),
  projectCount: z.number().int().nonnegative().optional(),
  error: z.string().max(1000).optional(),
});
export type RemotePeerTestResult = z.infer<typeof remotePeerTestResultSchema>;

export const remotePeerManifestProjectSchema = z.object({
  id: z.string().min(1).max(1024),
  name: z.string().min(1).max(512),
  path: z.string().min(1).max(8192),
  threadIds: z.array(z.string().min(1).max(1024)),
});
export type RemotePeerManifestProject = z.infer<typeof remotePeerManifestProjectSchema>;

export const remotePeerManifestSchema = z.object({
  version: z.string().max(128),
  platform: z.string().max(64),
  hostname: z.string().max(255),
  homeDir: z.string().max(4096).optional(),
  epoch: z.string().min(1).max(256),
  projects: z.array(remotePeerManifestProjectSchema),
});
export type RemotePeerManifest = z.infer<typeof remotePeerManifestSchema>;

export const remotePeerDirectoryEntrySchema = z.object({
  name: z.string().min(1).max(512),
  path: z.string().min(1).max(8192),
  kind: z.literal("directory"),
});
export type RemotePeerDirectoryEntry = z.infer<typeof remotePeerDirectoryEntrySchema>;

export const remotePeerListDirsParamsSchema = z.object({
  peerId: remotePeerIdSchema,
  path: z.string().min(1).max(8192).optional(),
});
export type RemotePeerListDirsParams = z.infer<typeof remotePeerListDirsParamsSchema>;

export const remotePeerListDirsResultSchema = z.object({
  path: z.string().min(1).max(8192),
  parentPath: z.string().min(1).max(8192).nullable(),
  homeDir: z.string().min(1).max(8192).optional(),
  entries: z.array(remotePeerDirectoryEntrySchema),
});
export type RemotePeerListDirsResult = z.infer<typeof remotePeerListDirsResultSchema>;

export const remotePeerCreateDirParamsSchema = z.object({
  peerId: remotePeerIdSchema,
  parentPath: z.string().min(1).max(8192),
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => value.trim().length > 0, "Directory name cannot be blank"),
});
export type RemotePeerCreateDirParams = z.infer<typeof remotePeerCreateDirParamsSchema>;

export const remotePeerCreateDirResultSchema = z.object({
  path: z.string().min(1).max(8192),
  name: z.string().min(1).max(255),
});
export type RemotePeerCreateDirResult = z.infer<typeof remotePeerCreateDirResultSchema>;

export const remotePeerCreateWorkspaceParamsSchema = z.object({
  peerId: remotePeerIdSchema,
  path: z.string().min(1).max(8192),
  title: z.string().trim().min(1).max(255).optional(),
});
export type RemotePeerCreateWorkspaceParams = z.infer<typeof remotePeerCreateWorkspaceParamsSchema>;

export const remotePeerRenameWorkspaceParamsSchema = z.object({
  peerId: remotePeerIdSchema,
  workspaceId: z.string().min(1).max(1024),
  title: z.string().trim().min(1).max(255),
});
export type RemotePeerRenameWorkspaceParams = z.infer<typeof remotePeerRenameWorkspaceParamsSchema>;

export const remotePeerDeleteWorkspaceParamsSchema = z.object({
  peerId: remotePeerIdSchema,
  workspaceId: z.string().min(1).max(1024),
});
export type RemotePeerDeleteWorkspaceParams = z.infer<typeof remotePeerDeleteWorkspaceParamsSchema>;

export const remotePeerWorkspaceMutationResultSchema = z.object({
  workspaceId: z.string().min(1).max(1024).optional(),
  manifest: remotePeerManifestSchema,
});
export type RemotePeerWorkspaceMutationResult = z.infer<
  typeof remotePeerWorkspaceMutationResultSchema
>;
