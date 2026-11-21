export const DESKTOP_EXTENSION_PAGE_PREFIX = "app://-/.codexhost/extension-pages/";

/** Same-origin ESM URL handled by the Desktop Controller; not a path on disk. */
export function desktopExtensionPageModuleUrl({
  id,
  activationId,
  digest,
}: {
  id: string;
  activationId: string;
  digest: string;
}): string {
  return `${DESKTOP_EXTENSION_PAGE_PREFIX}${encodeURIComponent(id)}/${encodeURIComponent(activationId)}/${encodeURIComponent(digest)}/page.mjs`;
}
