/** Access token RPCs, available only when the request is local access. */
import type { WebAccessState } from "@codexhost/shared-contracts";

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
  listener: {
    port(): number;
    access(): Promise<Pick<WebAccessState, "networkUrls" | "tailscale">>;
  },
): void {
  const managed = (context: RpcContext): AccessTokenStore => {
    if (tokens === undefined)
      throw new RpcError("auth/disabled", "Authentication is not enabled", {});
    if (context.auth?.local !== true) {
      throw new RpcError(
        "auth/local-access-required",
        "The access token is only available on this computer",
        { url: `http://127.0.0.1:${String(listener.port())}` },
      );
    }
    return tokens;
  };
  rpc.register("codexhost/accessTokenGet", async (_args, context): Promise<WebAccessState> => {
    const store = managed(context);
    return { ...store.current(), ...(await listener.access()) };
  });
  rpc.register(
    "codexhost/accessTokenRegenerate",
    async (_args, context): Promise<WebAccessState> => {
      const store = managed(context);
      // A browser may be signed in with the token it replaces; this response still reports it.
      context.auth?.release();
      return { ...store.regenerate(), ...(await listener.access()) };
    },
  );
}
