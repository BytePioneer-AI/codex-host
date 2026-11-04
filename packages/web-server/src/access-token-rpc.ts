/** Token management RPCs, available only when the request is local access. */
import {
  webAccessTokenCreateParamsSchema,
  webAccessTokenDeleteParamsSchema,
  type WebAccessTokenCreateResult,
  type WebAccessTokenDeleteResult,
  type WebAccessTokenListResult,
  type WebNetworkAccessUrl,
} from "@codexhost/shared-contracts";

import type { AccessTokenStore } from "./access-tokens.ts";
import { RpcError, type RpcContext, type RpcRegistry } from "./transport.ts";

/**
 * @param rpc - the registry to extend.
 * @param tokens - the token store; undefined when the server runs with `--no-auth`.
 * @param listener - the listening port and the addresses other devices can use.
 */
export function registerAccessTokenRpc(
  rpc: RpcRegistry,
  tokens: AccessTokenStore | undefined,
  listener: { port(): number; networkUrls(): WebNetworkAccessUrl[] },
): void {
  const managed = (context: RpcContext): AccessTokenStore => {
    if (tokens === undefined)
      throw new RpcError("auth/disabled", "Authentication is not enabled", {});
    if (context.auth?.local !== true) {
      throw new RpcError(
        "auth/local-access-required",
        "Access tokens can only be managed on this computer",
        { url: `http://127.0.0.1:${String(listener.port())}` },
      );
    }
    return tokens;
  };
  rpc.register("codexhost/accessTokenList", (_args, context): WebAccessTokenListResult => ({
    tokens: managed(context).list(),
    networkUrls: listener.networkUrls(),
  }));
  rpc.register("codexhost/accessTokenCreate", (args, context): WebAccessTokenCreateResult => {
    const store = managed(context);
    const parsed = webAccessTokenCreateParamsSchema.safeParse(args);
    if (!parsed.success)
      throw new RpcError("auth/invalid-token-name", "A token name is required", {});
    const created = store.create(parsed.data.name);
    return {
      ...created,
      links: listener.networkUrls().map((entry) => ({
        kind: entry.kind,
        url: `${entry.url}#token=${created.secret}`,
      })),
    };
  });
  rpc.register("codexhost/accessTokenDelete", (args, context): WebAccessTokenDeleteResult => {
    const store = managed(context);
    const { id } = webAccessTokenDeleteParamsSchema.parse(args);
    // A browser may be deleting the token it is signed in with; this response still reports it.
    context.auth?.release();
    return { deleted: store.delete(id) };
  });
}
