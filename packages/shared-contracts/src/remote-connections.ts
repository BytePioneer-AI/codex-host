import { z } from "zod";
import { delegationReadParamsSchema } from "./delegation-read.js";
import { jsonValueSchema } from "./json-value.js";
import { remoteUpdateParamsSchema } from "./remote-runtime.js";

export const CONSOLE_REMOTE_CONNECTIONS_METHOD = "codexhost/console/remote-connections";
const hostId = z.string().min(1).max(1024);
export const codexSshConnectionSchema = z.object({
  hostId,
  displayName: z.string().min(1).max(1024),
  source: z.enum(["codex-managed", "discovered"]),
  sshAlias: z.string().max(1024).nullable(),
  sshHost: z.string().min(1).max(1024),
  sshPort: z.number().int().min(1).max(65535).nullable(),
  identity: z.string().max(4096).nullable(),
  autoConnect: z.boolean(),
  connectionAnalyticsId: z.string().max(1024).optional(),
});
export const codexSshDraftSchema = z.strictObject({
  displayName: z.string().min(1).max(1024),
  hostname: z.string().min(1).max(1024),
  sshPort: z.number().int().min(1).max(65535).nullable(),
  identity: z.string().max(4096).nullable(),
});

/** Fixed settings operations and explicit read-only Thread access; no arbitrary requests. */
export const remoteConnectionsRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({
    action: z.literal("read-thread"),
    hostId: hostId.refine((id) => id !== "local"),
    input: delegationReadParamsSchema,
  }),
  z.strictObject({
    action: z.literal("save"),
    draft: codexSshDraftSchema,
    previous: codexSshConnectionSchema.nullable(),
  }),
  z.strictObject({ action: z.literal("remove"), previous: codexSshConnectionSchema }),
  z.strictObject({ action: z.literal("connect"), hostId, enabled: z.boolean() }),
  z.strictObject({ action: z.literal("state"), hostId }),
  z.strictObject({ action: z.literal("runtime"), hostId }),
  z.strictObject({
    action: z.literal("update"),
    hostId: hostId.refine((id) => id !== "local"),
    version: remoteUpdateParamsSchema.shape.version,
  }),
]);
export const remoteConnectionsReplySchema = z.union([
  z.strictObject({ result: jsonValueSchema }),
  z.strictObject({ error: z.strictObject({ code: z.number().int(), message: z.string() }) }),
]);
export type RemoteConnectionsRequest = z.infer<typeof remoteConnectionsRequestSchema>;
export type RemoteConnectionsReply = z.infer<typeof remoteConnectionsReplySchema>;
export type CodexSshConnection = z.infer<typeof codexSshConnectionSchema>;
export type CodexSshDraft = z.infer<typeof codexSshDraftSchema>;
