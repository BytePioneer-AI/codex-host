import { z } from "zod";
import { harnessIdSchema } from "./ids.js";

export const HARNESS_CONNECTION_GET_METHOD = "codexhost/harness/connection/get";
export const HARNESS_CONNECTION_SET_METHOD = "codexhost/harness/connection/set";
export const harnessConnectionGetSchema = z.object({ harnessId: harnessIdSchema }).strict();
/** Write-only user supplied pairing material. Never return or persist it in Renderer state. */
export const harnessConnectionSetSchema = harnessConnectionGetSchema.extend({
  secret: z.string().trim().min(1).max(8192).nullable(),
  cwd: z.string().trim().min(1).max(16_384).optional(),
});
export const harnessConnectionStateSchema = z.discriminatedUnion("supported", [
  z.object({ supported: z.literal(false) }).strict(),
  z
    .object({
      supported: z.literal(true),
      configured: z.boolean(),
      restartRequired: z.boolean(),
      description: z.string().min(1).max(2048),
      /** Presence declares that this connection requires an explicitly selected workspace. */
      cwd: z.string().trim().min(1).max(16_384).nullable().optional(),
    })
    .strict(),
]);
export type HarnessConnectionState = z.infer<typeof harnessConnectionStateSchema>;
export type HarnessConnectionGet = z.infer<typeof harnessConnectionGetSchema>;
export type HarnessConnectionSet = z.infer<typeof harnessConnectionSetSchema>;
