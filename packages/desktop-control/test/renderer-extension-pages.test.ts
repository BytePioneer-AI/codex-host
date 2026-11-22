import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  installHostExtension,
  updateHostExtensionConfiguration,
} from "@codexhost/harness-plugin-files";
import { expect, it, vi } from "vitest";
import { makeZip } from "../../../tests/fixtures/desktop-extension-zip.js";
import {
  desktopExtensionModuleUrl,
  desktopExtensionPageModuleUrl,
  desktopExtensionWidgetModuleUrl,
} from "../src/renderer-bindings.js";
import { installRendererExtensionPages } from "../src/renderer-extension-pages.js";

it("serves modules only for the enabled generation in the Desktop main frame", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "codexhost-pages-"));
  const id = "sample";
  const source = 'export { mount } from "../shared/timer module.mjs";';
  const widget = "// Widget\n" + source;
  const shared = "export function mount() {}";
  const zipBuffer = makeZip([
    {
      name: "manifest.json",
      data: JSON.stringify({
        manifestVersion: 2,
        id,
        version: "1",
        name: { en: id, "zh-CN": id },
        description: { en: id, "zh-CN": id },
        page: { apiVersion: 1, entry: "page/index.mjs" },
        widget: { apiVersion: 1, entry: "widget/index.mjs" },
        backend: { apiVersion: 1, entry: "backend/worker.mjs" },
      }),
    },
    { name: "page/index.mjs", data: source },
    { name: "widget/index.mjs", data: widget },
    { name: "shared/timer module.mjs", data: shared },
    { name: "backend/worker.mjs", data: "export function activate() {}" },
  ]);
  let paused: ((event: unknown) => void) | undefined;
  let frameUrl = "app://-/index.html";
  const replies = new Map<string, Record<string, unknown>>();
  const command = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "Page.getFrameTree")
      return { frameTree: { frame: { id: "main", url: frameUrl } } };
    if (method === "Fetch.fulfillRequest" && typeof params?.requestId === "string")
      replies.set(params.requestId, params);
  });
  try {
    const installed = await installHostExtension({ dataDir, source: { type: "zip", zipBuffer } });
    const url = desktopExtensionPageModuleUrl(installed);
    const dispose = await installRendererExtensionPages(
      {
        command,
        on: (_event, listener) => {
          paused = listener;
          return () => {
            paused = undefined;
          };
        },
      },
      dataDir,
    );
    try {
      const request = async (
        requestId: string,
        targetUrl = url,
        frameId = "main",
        method = "GET",
        resourceType = "Script",
      ) => {
        paused?.({
          requestId,
          request: { url: targetUrl, method },
          frameId,
          resourceType,
        });
        await expect.poll(() => replies.has(requestId)).toBe(true);
        return replies.get(requestId);
      };
      expect(await request("disabled")).toMatchObject({ responseCode: 404, body: "" });
      await updateHostExtensionConfiguration(dataDir, { id, action: "enable" });
      const pageUrl = desktopExtensionPageModuleUrl({ ...installed, path: "page/index.mjs" });
      const widgetUrl = desktopExtensionWidgetModuleUrl({ ...installed, path: "widget/index.mjs" });
      const sharedUrl = desktopExtensionModuleUrl({
        ...installed,
        path: "shared/timer module.mjs",
      });
      expect(new URL("../shared/timer module.mjs", pageUrl).href).toBe(sharedUrl);
      expect(new URL("../shared/timer module.mjs", widgetUrl).href).toBe(sharedUrl);
      for (const [name, target, body] of [
        ["page-alias", url, source],
        ["page-entry", pageUrl, source],
        ["widget-alias", desktopExtensionWidgetModuleUrl(installed), widget],
        ["widget-entry", widgetUrl, widget],
        ["shared", sharedUrl, shared],
      ] as const) {
        expect(await request(name, target)).toMatchObject({
          responseCode: 200,
          body: Buffer.from(body).toString("base64"),
        });
      }
      expect(await request("child-frame", url, "child")).toMatchObject({ responseCode: 404 });
      expect(await request("wrong-method", url, "main", "POST")).toMatchObject({
        responseCode: 404,
      });
      expect(await request("wrong-type", url, "main", "GET", "Fetch")).toMatchObject({
        responseCode: 404,
      });
      for (const resource of [
        "backend/worker.mjs",
        "backend/WORKER.mjs",
        "page/%2e%2e/page.mjs",
        "page%2findex.mjs",
        "page/index.mjs?x",
        "manifest.json",
      ]) {
        expect(await request(resource, url.replace("page.mjs", resource))).toMatchObject({
          responseCode: 404,
          body: "",
        });
      }
      expect(
        await request(
          "wrong-digest",
          desktopExtensionModuleUrl({
            ...installed,
            digest: "0".repeat(64),
            path: "page/index.mjs",
          }),
        ),
      ).toMatchObject({ responseCode: 404 });
      const replacement = await installHostExtension({
        dataDir,
        source: { type: "zip", zipBuffer },
        expectedDigest: installed.digest,
      });
      expect(await request("stale")).toMatchObject({ responseCode: 404 });
      frameUrl = "https://example.com";
      expect(
        await request("other-document", desktopExtensionPageModuleUrl(replacement)),
      ).toMatchObject({ responseCode: 404 });
    } finally {
      await dispose();
    }
    expect(paused).toBeUndefined();
    expect(command).toHaveBeenCalledWith("Fetch.disable");
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});
