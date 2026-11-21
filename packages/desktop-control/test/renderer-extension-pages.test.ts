import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  installHostExtension,
  updateHostExtensionConfiguration,
} from "@codexhost/harness-plugin-files";
import { expect, it, vi } from "vitest";
import { makeZip } from "../../../tests/fixtures/desktop-extension-zip.js";
import { desktopExtensionPageModuleUrl } from "../src/renderer-bindings.js";
import { installRendererExtensionPages } from "../src/renderer-extension-pages.js";

it("serves only the enabled page module for the current generation in the Desktop main frame", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "codexhost-pages-"));
  const id = "sample";
  const source = "export function mount() {}";
  const zipBuffer = makeZip([
    {
      name: "manifest.json",
      data: JSON.stringify({
        manifestVersion: 2,
        id,
        version: "1",
        name: { en: id, "zh-CN": id },
        description: { en: id, "zh-CN": id },
        page: { apiVersion: 1, entry: "ui/main.mjs" },
        backend: { apiVersion: 1, entry: "worker.mjs" },
      }),
    },
    { name: "ui/main.mjs", data: source },
    { name: "worker.mjs", data: "export function activate() {}" },
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
      ) => {
        paused?.({
          requestId,
          request: { url: targetUrl, method },
          frameId,
          resourceType: "Script",
        });
        await expect.poll(() => replies.has(requestId)).toBe(true);
        return replies.get(requestId);
      };
      expect(await request("disabled")).toMatchObject({ responseCode: 404, body: "" });
      await updateHostExtensionConfiguration(dataDir, { id, action: "enable" });
      expect(await request("valid")).toMatchObject({
        responseCode: 200,
        body: Buffer.from(source).toString("base64"),
      });
      expect(await request("child-frame", url, "child")).toMatchObject({ responseCode: 404 });
      expect(await request("wrong-method", url, "main", "POST")).toMatchObject({
        responseCode: 404,
      });
      expect(await request("worker", url.replace("/page.mjs", "/worker.mjs"))).toMatchObject({
        responseCode: 404,
      });
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
