import { z } from "zod";
import { jsonObjectSchema, jsonValueSchema } from "./json-value.js";
import {
  remotePeerHostIdSchema,
  remotePeerIdSchema,
  remotePeerStateSchema,
} from "./remote-peers.js";

/** Internal loopback Client Channel method between B-side Web server and its local Host Runtime. */
export const PEER_DELEGATION_CHANNEL_METHOD = "codexhost/peer/delegation";

/** Subdirectory under the codexhost data directory holding per-instance bridge descriptors. */
export const PEER_DELEGATION_BRIDGE_DIR = "peer-delegation-bridges";
export const PEER_DELEGATION_BRIDGE_VERSION = 1;

/** Maximum hop count allowed for cross-host peer delegation in Phase 1. */
export const PEER_DELEGATION_MAX_HOPS = 1;

export const PEER_DELEGATION_OPERATIONS = [
  "listHarnesses",
  "inspect",
  "start",
  "send",
  "cancel",
  "read",
  "answer",
  "list",
] as const;

export const peerDelegationOperationSchema = z.enum(PEER_DELEGATION_OPERATIONS);
export type PeerDelegationOperation = z.infer<typeof peerDelegationOperationSchema>;

export const peerDelegationRequestSchema = z.strictObject({
  operation: peerDelegationOperationSchema,
  hopCount: z.number().int().min(0).max(16),
  /** Opaque A-side peer pairing identifier used by B to scope implicit deduplication per Peer. */
  sourceId: remotePeerIdSchema.optional(),
  input: jsonObjectSchema,
});
export type PeerDelegationRequest = z.infer<typeof peerDelegationRequestSchema>;

export const peerDelegationErrorSchema = z.strictObject({
  code: z.string().min(1).max(128),
  message: z.string().max(4096),
  details: jsonObjectSchema.optional(),
});
export type PeerDelegationError = z.infer<typeof peerDelegationErrorSchema>;

export const peerDelegationResponseSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    value: jsonValueSchema,
  }),
  z.strictObject({
    ok: z.literal(false),
    error: peerDelegationErrorSchema,
  }),
]);
export type PeerDelegationResponse = z.infer<typeof peerDelegationResponseSchema>;

export const peerDelegationHostProjectSchema = z.strictObject({
  id: z.string().min(1).max(1024),
  name: z.string().min(1).max(512),
  path: z.string().min(1).max(8192),
});
export type PeerDelegationHostProject = z.infer<typeof peerDelegationHostProjectSchema>;

/** Agent-safe summary of a paired remote peer; never exposes tokens or origin URLs. */
export const peerDelegationHostSummarySchema = z.strictObject({
  hostId: remotePeerHostIdSchema,
  displayName: z.string().min(1).max(120),
  online: z.boolean(),
  state: remotePeerStateSchema,
  delegation: z.boolean(),
  projects: z.array(peerDelegationHostProjectSchema),
  platform: z.string().max(64).optional(),
  hostname: z.string().max(255).optional(),
  homeDir: z.string().max(4096).optional(),
});
export type PeerDelegationHostSummary = z.infer<typeof peerDelegationHostSummarySchema>;

export const peerDelegationHostsResultSchema = z.strictObject({
  hosts: z.array(peerDelegationHostSummarySchema),
});
export type PeerDelegationHostsResult = z.infer<typeof peerDelegationHostsResultSchema>;

export const peerDelegationBridgeDescriptorSchema = z.strictObject({
  version: z.literal(PEER_DELEGATION_BRIDGE_VERSION),
  instanceId: z.string().min(1).max(128),
  pid: z.number().int().positive(),
  endpoint: z.string().min(1).max(256),
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  startedAt: z.number().int().nonnegative(),
});
export type PeerDelegationBridgeDescriptor = z.infer<typeof peerDelegationBridgeDescriptorSchema>;

export const peerDelegationBridgeRequestSchema = z.union([
  z.strictObject({
    operation: z.literal("hosts"),
  }),
  z.strictObject({
    operation: peerDelegationOperationSchema,
    hostId: remotePeerHostIdSchema,
    hopCount: z.number().int().min(0).max(16),
    timeoutMs: z.number().int().min(1).max(120_000).optional(),
    input: jsonObjectSchema,
  }),
]);
export type PeerDelegationBridgeRequest = z.infer<typeof peerDelegationBridgeRequestSchema>;
