import {
  discoverHostExtensions,
  readHostExtensionAsset,
  readHostExtensionConfiguration,
} from "@codexhost/harness-plugin-files";
import { hostExtensionsAssetParamsSchema } from "@codexhost/shared-contracts";
import type { RendererModuleCdpClient } from "./renderer-loaded-modules.js";
import {
  DESKTOP_EXTENSION_PAGE_PREFIX as PREFIX,
  desktopExtensionPageModuleUrl,
} from "./renderer-extension-page-url.js";

const DOCUMENT = "app://-/index.html";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Serve only current page.entry bytes on the app's existing script-src 'self'.
 * No CSP changes, arbitrary evaluation, or caller-supplied filesystem paths. */
export async function installRendererExtensionPages(
  renderer: RendererModuleCdpClient,
  dataDir: string,
): Promise<() => Promise<void>> {
  let closed = false;
  const unsubscribe = renderer.on("Fetch.requestPaused", (raw) => {
    const event = record(raw);
    if (!event || typeof event.requestId !== "string") return;
    const { requestId } = event;
    const request = record(event.request);
    const url = request?.url;
    const fulfill = (responseCode: number, base64 = "") =>
      renderer.command("Fetch.fulfillRequest", {
        requestId,
        responseCode,
        responseHeaders: [
          { name: "Content-Type", value: "text/javascript; charset=utf-8" },
          { name: "Cache-Control", value: "no-store" },
          { name: "X-Content-Type-Options", value: "nosniff" },
        ],
        body: base64,
      });
    void (async () => {
      if (typeof url !== "string" || !url.startsWith(PREFIX)) {
        await renderer.command("Fetch.continueRequest", { requestId });
        return;
      }
      let base64: string | undefined;
      try {
        const [id, activationId, digest] = url.slice(PREFIX.length).split("/");
        const match = hostExtensionsAssetParamsSchema.safeParse({
          id,
          activationId,
          digest,
          path: "page.mjs",
        });
        if (
          closed ||
          request?.method !== "GET" ||
          event.resourceType !== "Script" ||
          !match.success ||
          !id ||
          !activationId ||
          !digest ||
          url !== desktopExtensionPageModuleUrl({ id, activationId, digest })
        ) {
          await fulfill(404);
          return;
        }
        const frameTree = record(await renderer.command("Page.getFrameTree"));
        const frame = record(record(frameTree?.frameTree)?.frame);
        if (frame?.url === DOCUMENT && frame.id === event.frameId) {
          const { extensions } = await discoverHostExtensions(dataDir);
          const entry = extensions.find((entry) => entry.id === id);
          if (
            entry?.state === "valid" &&
            entry.enabled &&
            entry.activationId === activationId &&
            entry.digest === digest &&
            entry.manifest.page
          ) {
            base64 = (
              await readHostExtensionAsset({
                dataDir,
                id,
                activationId,
                digest,
                path: entry.manifest.page.entry,
              })
            ).base64;
            if (!(await readHostExtensionConfiguration(dataDir)).enabled.includes(id))
              base64 = undefined;
          }
        }
      } catch {
        // Fail closed even if the disk generation changed while reading it.
      }
      await fulfill(!closed && base64 !== undefined ? 200 : 404, closed ? "" : base64);
    })().catch(() => undefined);
  });
  try {
    await renderer.command("Fetch.enable", { patterns: [{ urlPattern: `${PREFIX}*` }] });
  } catch (error) {
    unsubscribe();
    throw error;
  }
  return async () => {
    closed = true;
    unsubscribe();
    await renderer.command("Fetch.disable").catch(() => undefined);
  };
}
