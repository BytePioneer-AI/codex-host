import type { HostExtensionRuntimeEntry } from "@codexhost/shared-contracts";
import type { DesktopExtensionModuleEntry } from "../../src/desktop-extension-modules.js";

export function moduleEntry(
  kind: "page" | "widget",
  {
    id,
    activationId,
    digest,
    manifest,
  }: Pick<HostExtensionRuntimeEntry, "id" | "activationId" | "digest" | "manifest">,
  create: NonNullable<DesktopExtensionModuleEntry["create"]> | string,
): DesktopExtensionModuleEntry {
  const path = manifest[kind]?.entry;
  if (!path) throw new Error(`Missing ${kind} entry`);
  return {
    id,
    kind,
    activationId,
    digest,
    path,
    hash: digest,
    ...(typeof create === "string" ? { error: create } : { create }),
  };
}
