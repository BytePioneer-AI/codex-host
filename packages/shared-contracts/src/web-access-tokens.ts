import { z } from "zod";

export const webNetworkAccessUrlSchema = z
  .object({
    /**
     * `tailscale-https` is a Tailscale Serve address already forwarding to this server. `virtual` marks a
     * VM or container bridge, which other devices usually cannot reach.
     */
    kind: z.enum(["tailscale-https", "tailscale", "lan", "virtual"]),
    url: z.string().min(1),
  })
  .strict();

/** What this computer's connection page shows; available only on this computer. */
export const webAccessStateSchema = z
  .object({
    /** The access token other devices sign in with. */
    secret: z.string().min(1),
    lastUsedAt: z.number().nullable(),
    /** Addresses for other devices; empty when Web listens only on this computer. */
    networkUrls: z.array(webNetworkAccessUrlSchema),
  })
  .strict();

/** Details of `auth/local-access-required`: where the user can find the token instead. */
export const webLocalAccessRequiredDetailsSchema = z.object({ url: z.string() }).strict();

export type WebNetworkAccessUrl = z.infer<typeof webNetworkAccessUrlSchema>;
export type WebAccessState = z.infer<typeof webAccessStateSchema>;
