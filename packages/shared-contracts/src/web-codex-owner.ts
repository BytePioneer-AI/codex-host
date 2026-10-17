import { z } from "zod";
import { clientChannelCursorSchema } from "./client-channel.js";

/** Private Node-to-owner configuration. Never registered as a browser RPC. */
export const webCodexConfigurationSchema = z
  .object({
    home: z.string().min(1),
    command: z.string().min(1),
    pluginRoots: z.array(z.string().min(1)).min(1),
    migrateSource: z.string().min(1).optional(),
    legacySource: z.string().min(1).optional(),
    legacyWriterStopped: z.literal(true).optional(),
  })
  .strict();
export type WebCodexConfiguration = z.infer<typeof webCodexConfigurationSchema>;
export const webCodexAddressSchema = z
  .object({
    scope: z.string().regex(/^web-codex:[a-f0-9]{64}$/u),
    sessionId: z.string().min(1).optional(),
  })
  .strict();
export type WebCodexAddress = z.infer<typeof webCodexAddressSchema>;
/** Fixed operations of the existing isolated Session surface, not a plugin command bus. */
export const WEB_CODEX_OPERATIONS = [
  "list",
  "create",
  "prepareDraft",
  "modelCatalog",
  "inspect",
  "selectModel",
  "prompt",
  "cancel",
  "updateQueue",
  "rename",
  "fork",
  "search",
  "page",
  "projections",
  "importSources",
  "importCandidates",
  "import",
  "listCommands",
  "executeCommand",
  "permissionCatalog",
  "interactions",
  "respond",
  "organization",
  "notifications",
] as const;
export const webCodexRequestSchema = z
  .object({
    epoch: z.string().uuid(),
    address: webCodexAddressSchema,
    operation: z.enum(WEB_CODEX_OPERATIONS),
    input: z.record(z.string(), z.unknown()),
  })
  .strict();
export type WebCodexRequest = z.infer<typeof webCodexRequestSchema>;
export const webCodexStreamRequestSchema = z
  .object({
    epoch: z.string().uuid(),
    address: webCodexAddressSchema,
    stream: z.enum(["follow", "control"]),
    input: z.record(z.string(), z.unknown()),
  })
  .strict();
export type WebCodexStreamRequest = z.infer<typeof webCodexStreamRequestSchema>;
export const webCodexConfigurationReplySchema = z.object({
  version: z.literal(1),
  scope: webCodexAddressSchema.shape.scope,
  cursor: clientChannelCursorSchema,
  sessionIds: z.array(z.string().min(1)),
  notificationCursor: z.number().int().nonnegative(),
});
export type WebCodexConfigurationReply = z.infer<typeof webCodexConfigurationReplySchema>;
