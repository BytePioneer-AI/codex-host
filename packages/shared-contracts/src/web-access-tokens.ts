import { z } from "zod";

export const WEB_ACCESS_TOKEN_NAME_MAX = 64;

export const webAccessTokenSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    /** Plaintext for local management; null for older tokens stored only as hashes. */
    secret: z.string().min(1).nullable(),
    createdAt: z.number(),
    lastUsedAt: z.number().nullable(),
  })
  .strict();

export const webNetworkAccessUrlSchema = z
  .object({ kind: z.enum(["tailscale", "lan"]), url: z.string().min(1) })
  .strict();

export const webAccessTokenListResultSchema = z
  .object({
    tokens: z.array(webAccessTokenSchema),
    /** Addresses for other devices; empty when Web listens only on this computer. */
    networkUrls: z.array(webNetworkAccessUrlSchema),
  })
  .strict();

export const webAccessTokenCreateParamsSchema = z.object({ name: z.string() }).strict();

export const webAccessTokenCreateResultSchema = z
  .object({
    token: webAccessTokenSchema,
    /** The plaintext token, also available from the local token list. */
    secret: z.string().min(1),
    /** Sign-in links for other devices, carrying the token in the URL fragment. */
    links: z.array(webNetworkAccessUrlSchema),
  })
  .strict();

export const webAccessTokenDeleteParamsSchema = z.object({ id: z.string().min(1) }).strict();
export const webAccessTokenDeleteResultSchema = z.object({ deleted: z.boolean() }).strict();

/** Details of `auth/local-access-required`: where the user can manage tokens instead. */
export const webLocalAccessRequiredDetailsSchema = z.object({ url: z.string() }).strict();

export type WebAccessToken = z.infer<typeof webAccessTokenSchema>;
export type WebNetworkAccessUrl = z.infer<typeof webNetworkAccessUrlSchema>;
export type WebAccessTokenListResult = z.infer<typeof webAccessTokenListResultSchema>;
export type WebAccessTokenCreateResult = z.infer<typeof webAccessTokenCreateResultSchema>;
export type WebAccessTokenDeleteResult = z.infer<typeof webAccessTokenDeleteResultSchema>;
