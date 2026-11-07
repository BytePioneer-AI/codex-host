import { z } from "zod";
import { localAccessTokens } from "../access-token-rpc.ts";
import type { AccessTokenStore } from "../access-tokens.ts";
import type { RpcRegistry } from "../transport.ts";
import {
  webRelayHostSchema,
  webRelayKindSchema,
  webRelayNameSchema,
} from "@codexhost/shared-contracts";
import type { RemoteRelay } from "./state.ts";

export function registerRelayRpc(
  rpc: RpcRegistry,
  tokens: AccessTokenStore | undefined,
  port: () => number,
  relay: RemoteRelay,
): void {
  rpc.register("codexhost/relaySet", (args, context) => {
    localAccessTokens(tokens, context.auth, port());
    const { enabled, name, invite, kind, host } = z
      .object({
        enabled: z.boolean(),
        kind: webRelayKindSchema.optional(),
        host: webRelayHostSchema.optional(),
        name: webRelayNameSchema.optional(),
        invite: z.string().optional(),
      })
      .strict()
      .refine((value) => value.host === undefined || value.kind === "self-hosted", {
        message: "A control hostname can only be set for the self-hosted relay",
      })
      .refine(
        (value) =>
          (value.kind ?? relay.access.kind) === "self-hosted" ||
          value.name === undefined ||
          /^(?:[a-z0-9]{4,20})?$/.test(value.name),
        {
          path: ["name"],
          message: "Official address names must be 4–20 lowercase letters or digits",
        },
      )
      .parse(args);
    relay.setEnabled(
      enabled,
      name === undefined && invite === undefined
        ? undefined
        : { name: name ?? "", invite: invite ?? "" },
      { kind, host },
    );
    return relay.state;
  });
}
