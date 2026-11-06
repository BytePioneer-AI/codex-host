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
    const { enabled, name, invite } = z
      .object({
        enabled: z.boolean(),
        name: z
          .string()
          .regex(/^(?:[a-z0-9]{4,20})?$/)
          .optional(),
        invite: z.string().optional(),
      })
      .strict()
      .parse(args);
    relay.setEnabled(
      enabled,
      name === undefined && invite === undefined
        ? undefined
        : { name: name ?? "", invite: invite ?? "" },
    );
    return relay.state;
  });
}
