import { hostExtensionResourcePathSchema } from "@codexhost/shared-contracts";

export const DESKTOP_EXTENSION_PAGE_PREFIX = "app://-/.codexhost/extension-pages/";

type ModuleIdentity = { id: string; activationId: string; digest: string };

/** Same-origin ESM URL handled by the Desktop Controller; not a path on disk. */
export function desktopExtensionModuleUrl({
  id,
  activationId,
  digest,
  path,
}: ModuleIdentity & { path: string }): string {
  const resource = hostExtensionResourcePathSchema.parse(path);
  if (!resource.endsWith(".mjs")) throw new Error("Expected an extension .mjs module");
  return (
    DESKTOP_EXTENSION_PAGE_PREFIX +
    [id, activationId, digest, ...resource.split("/")].map(encodeURIComponent).join("/")
  );
}

export function desktopExtensionPageModuleUrl({
  path = "page.mjs",
  ...identity
}: ModuleIdentity & { path?: string }): string {
  return desktopExtensionModuleUrl({ ...identity, path });
}

export function desktopExtensionWidgetModuleUrl({
  path = "widget.mjs",
  ...identity
}: ModuleIdentity & { path?: string }): string {
  return desktopExtensionModuleUrl({ ...identity, path });
}
