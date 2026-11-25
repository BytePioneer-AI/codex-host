/** Access token RPCs, available when authentication is enabled. */
import type { WebAccessState } from "@codexhost/shared-contracts";
import { z } from "zod";
import { setTailscaleServe } from "./tailscale-serve.ts";

import type { AccessTokenStore } from "./access-tokens.ts";
import { RpcError, type RpcRegistry } from "./transport.ts";

export function managedAccessTokens(tokens: AccessTokenStore | undefined): AccessTokenStore {
  if (tokens === undefined)
    throw new RpcError("auth/disabled", "Authentication is not enabled", {});
  return tokens;
}

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
    access(): Promise<
      Pick<
        WebAccessState,
        "networkUrls" | "directCandidates" | "tailscale" | "background" | "relay"
      >
    >;
  },
): void {
  rpc.register("codexhost/tailscaleServeSet", async (args) => {
    managedAccessTokens(tokens);
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(args);
    return setTailscaleServe(listener.port(), enabled);
  });
  rpc.register("codexhost/accessTokenGet", async (): Promise<WebAccessState> => {
    const store = managedAccessTokens(tokens);
    return { ...store.current(), ...(await listener.access()) };
  });
  rpc.register(
    "codexhost/accessTokenRegenerate",
    async (_args, context): Promise<WebAccessState> => {
      const store = managedAccessTokens(tokens);
      // A browser may be signed in with the token it replaces; keep its response open and rotate
      // its cookie so the caller stays signed in while every other session is revoked.
      context.auth?.release();
      const next = store.regenerate();
      context.auth?.renewCookie?.(next.secret);
      return { ...next, ...(await listener.access()) };
    },
  );
}
