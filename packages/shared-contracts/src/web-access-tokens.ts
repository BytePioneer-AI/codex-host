import { z } from "zod";

export const webNetworkAccessUrlSchema = z
  .object({
    /**
     * `tailscale-https` is a Tailscale Serve address already forwarding to this server. `virtual` marks a
     * VM or container bridge, which other devices usually cannot reach.
     */
    kind: z.enum([
      "public",
      "relay",
      "tailscale-funnel",
      "tailscale-https",
      "tailscale",
      "lan",
      "virtual",
    ]),
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

export const webRelayCertificateSchema = z.object({
  expiresAt: z.string().optional(),
  issuing: z.boolean(),
  failure: z
    .object({
      /** The certificate authority's explanation; absent when it could not be reached. */
      detail: z.string().optional(),
      retryAt: z.string(),
      paused: z.boolean(),
    })
    .optional(),
});
export type WebRelayCertificate = z.infer<typeof webRelayCertificateSchema>;

export const webRelayStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("off"),
    reason: z.enum(["invite", "name-taken", "banned"]).optional(),
  }),
  z.object({
    status: z.literal("connecting"),
    reason: z.enum(["full", "unreachable"]).optional(),
  }),
  z.object({
    status: z.literal("connected"),
    url: z.string(),
    certificate: webRelayCertificateSchema,
  }),
  z.object({
    status: z.literal("missing-certificate"),
    url: z.string(),
    certificate: webRelayCertificateSchema,
  }),
  z.object({
    status: z.literal("stopped"),
    reason: z.enum(["replaced", "rejected", "unsupported-version"]),
  }),
]);
export type WebRelayState = z.infer<typeof webRelayStateSchema>;

/** A DNS hostname only: no scheme, port, path, whitespace, or IP literal. */
export const webRelayHostSchema = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i)
  .transform((host) => host.toLowerCase());

/** Optional single-label address name; the empty value requests a derived address. */
export const webRelayNameSchema = z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)?$/);

export const webRelayKindSchema = z.enum(["official", "self-hosted"]);
export type WebRelayKind = z.infer<typeof webRelayKindSchema>;

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
    relay: z
      .object({
        state: webRelayStateSchema,
        enabled: z.boolean(),
        kind: webRelayKindSchema,
        officialHost: z.string(),
        customHost: z.string().optional(),
        officialHostname: z.string().optional(),
        customHostname: z.string().optional(),
        quotaUntil: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Details of `auth/local-access-required`: where the user can find the token instead. */
export const webLocalAccessRequiredDetailsSchema = z.object({ url: z.string() }).strict();

export type WebNetworkAccessUrl = z.infer<typeof webNetworkAccessUrlSchema>;
export type WebAccessState = z.infer<typeof webAccessStateSchema>;
