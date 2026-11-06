import { z } from "zod";
import { localAccessTokens } from "../access-token-rpc.ts";
import type { AccessTokenStore } from "../access-tokens.ts";
import { RpcError, type RpcRegistry } from "../transport.ts";
import type { RemoteRelay } from "./state.ts";

export function registerRelayRpc(
  rpc: RpcRegistry,
  tokens: AccessTokenStore | undefined,
  port: () => number,
  relay: RemoteRelay,
): void {
  rpc.register("codexhost/relaySet", (args, context) => {
    localAccessTokens(tokens, context.auth, port());
    if (!relay.configured)
      throw new RpcError(
        "relay/not-configured",
        "Configure --relay before enabling relay access",
        {},
      );
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(args);
    relay.setEnabled(enabled);
    return relay.state;
  });
}
