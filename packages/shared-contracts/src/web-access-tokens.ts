import { z } from "zod";

export const webNetworkAccessUrlSchema = z
  .object({
    /**
     * `tailscale-https` is a Tailscale Serve address already forwarding to this server. `virtual` marks a
     * VM or container bridge, which other devices usually cannot reach.
     */
    kind: z.enum(["public", "tailscale-funnel", "tailscale-https", "tailscale", "lan", "virtual"]),
    url: z.string().min(1),
  })
  .strict();

export const webTailscaleStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not-installed") }),
  z.object({ status: z.literal("not-running") }),
  z.object({ status: z.literal("not-logged-in") }),
  z.object({ status: z.literal("https-disabled") }),
  z.object({ status: z.literal("not-serving"), command: z.string() }),
  z.object({ status: z.literal("occupied"), target: z.string() }),
  z.object({ status: z.literal("serving"), url: z.string(), funnel: z.boolean() }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);

export type WebTailscaleState = z.infer<typeof webTailscaleStateSchema>;

export const webServeResultSchema = z
  .object({
    state: webTailscaleStateSchema,
    error: z.string().optional(),
  })
  .strict();

export const webAutostartStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("on") }),
  z.object({ status: z.literal("off") }),
  z.object({ status: z.literal("invalid"), reason: z.string() }),
]);

export const webBackgroundStateSchema = z
  .object({
    lan: z.boolean(),
    autostart: webAutostartStateSchema,
  })
  .strict();

export type WebBackgroundState = z.infer<typeof webBackgroundStateSchema>;

/** What this computer's connection page shows; available only on this computer. */
export const webAccessStateSchema = z
  .object({
    /** The access token other devices sign in with. */
    secret: z.string().min(1),
    lastUsedAt: z.number().nullable(),
    /** Addresses for other devices; empty when Web listens only on this computer. */
    networkUrls: z.array(webNetworkAccessUrlSchema),
    /** Preview addresses for managed direct access; not usable until present in networkUrls. */
    directCandidates: z.array(webNetworkAccessUrlSchema).optional(),
    tailscale: webTailscaleStateSchema,
    background: webBackgroundStateSchema.optional(),
  })
  .strict();

/** Details of `auth/local-access-required`: where the user can find the token instead. */
export const webLocalAccessRequiredDetailsSchema = z.object({ url: z.string() }).strict();

export type WebNetworkAccessUrl = z.infer<typeof webNetworkAccessUrlSchema>;
export type WebAccessState = z.infer<typeof webAccessStateSchema>;
