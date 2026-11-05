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

/** What this computer's connection page shows; available only on this computer. */
export const webAccessStateSchema = z
  .object({
    /** The access token other devices sign in with. */
    secret: z.string().min(1),
    lastUsedAt: z.number().nullable(),
    /** Addresses for other devices; empty when Web listens only on this computer. */
    networkUrls: z.array(webNetworkAccessUrlSchema),
    tailscale: webTailscaleStateSchema,
  })
  .strict();

/** Details of `auth/local-access-required`: where the user can find the token instead. */
export const webLocalAccessRequiredDetailsSchema = z.object({ url: z.string() }).strict();

export type WebNetworkAccessUrl = z.infer<typeof webNetworkAccessUrlSchema>;
export type WebAccessState = z.infer<typeof webAccessStateSchema>;
