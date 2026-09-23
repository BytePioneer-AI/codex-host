import type { OpencodeClient, PermissionRuleset } from "@mimo-ai/sdk/v2/client";
import {
  harnessPermissionModeIdSchema,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
} from "@codexhost/shared-contracts";
import { checked, MimoError } from "./protocol.js";

const native = harnessPermissionModeIdSchema.parse("native-default");
const ask = harnessPermissionModeIdSchema.parse("ask");
const allow = harnessPermissionModeIdSchema.parse("allow");
export const fullAccess = harnessPermissionModeIdSchema.parse("full-access");
export const permissionModes: HarnessPermissionModeCatalog = {
  defaultModeId: native,
  modes: [
    { id: native, label: "Native configuration" },
    { id: ask, label: "Ask", description: "Ask for permissions through MiMo's native policy." },
    {
      id: fullAccess,
      label: "Full access",
      description: "Native unattended execution, including irreversible delete permissions.",
      dangerous: true,
    },
    {
      id: allow,
      label: "Allow tools",
      description: "Allow ordinary tools. Native mandatory confirmations still apply.",
      dangerous: true,
    },
  ],
};
export function permissionRules(id: HarnessPermissionModeId): PermissionRuleset {
  if (id === native) return [];
  if (id === fullAccess)
    return [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "bash_delete", pattern: "*", action: "allow" },
    ];
  if (id === ask || id === allow)
    return [{ permission: "*", pattern: "*", action: id === ask ? "ask" : "allow" }];
  throw new MimoError("invalidRequest", "Unknown MiMo Permission Mode");
}
export function observedPermission(
  rules: PermissionRuleset | undefined,
): HarnessPermissionModeId | undefined {
  if (!rules?.length) return native;
  if (
    rules.length === 2 &&
    rules[0]?.permission === "*" &&
    rules[1]?.permission === "bash_delete" &&
    rules.every((rule) => rule.pattern === "*" && rule.action === "allow")
  )
    return fullAccess;
  const last = rules.at(-1);
  if (last?.permission !== "*" || last.pattern !== "*") return undefined;
  return last.action === "ask" ? ask : last.action === "allow" ? allow : undefined;
}

/** These flags belong to this Adapter-owned native instance, never global user config. */
export async function enableFullAccess(client: OpencodeClient): Promise<void> {
  if (
    checked(await client.permission.setSkipAll({ enabled: true })) !== true ||
    checked(await client.permission.setAutoApproveDelete({ enabled: true })) !== true ||
    checked(await client.permission.skipAll()) !== true ||
    checked(await client.permission.autoApproveDelete()) !== true
  )
    throw new MimoError("nativeFailure", "MiMo did not confirm native unattended permissions");
}
