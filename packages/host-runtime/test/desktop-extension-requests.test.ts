import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extensionZip } from "../../../tests/fixtures/desktop-extension-zip.js";
import type { JsonObject } from "@codexhost/protocol-core";
import {
  discoverDesktopExtensions,
  readDesktopExtensionConfiguration,
} from "@codexhost/harness-plugin-files";
import {
  DESKTOP_EXTENSIONS_CATALOG_METHOD,
  DESKTOP_EXTENSIONS_DISABLE_METHOD,
  DESKTOP_EXTENSIONS_INSTALL_METHOD,
  DESKTOP_EXTENSIONS_UNINSTALL_METHOD,
  desktopExtensionsInstallResultSchema,
  desktopExtensionsUninstallResultSchema,
  DESKTOP_EXTENSIONS_ENABLE_METHOD,
  DESKTOP_EXTENSIONS_LIST_METHOD,
  DESKTOP_EXTENSIONS_RECOVER_METHOD,
  desktopExtensionsListResultSchema,
} from "@codexhost/shared-contracts";
import { expect, it } from "vitest";
import { createFixture, stopFixture, writeRequest } from "./app-server-host-fixture.js";

it("shares Desktop and client-channel selection, status and recovery without executing packages", async () => {
  const fixture = createFixture();
  try {
    await fixture.ready;
    const data = fixture.mappingStoreDirectory;
    const root = path.join(data, "desktop-extensions");
    const badgeName = { en: "Delegation badges", "zh-CN": "委派角标" };
    const badgeCategories = ["sidebar", "workflow"];
    for (const [id, desktopApi] of [
      ["badge", 1],
      ["tree", 1],
      ["future", 2],
    ] as const) {
      const directory = path.join(root, id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(directory, "manifest.json"),
        JSON.stringify({
          id,
          desktopApi,
          manifestVersion: 1,
          name: id === "badge" ? badgeName : id,
          ...(id === "badge" ? { categories: badgeCategories } : {}),
          version: "1",
          slots: ["sidebar.thread-badge"],
          desktop: { script: "desktop.js" },
        }),
      );
      await writeFile(
        path.join(directory, "desktop.js"),
        'throw new Error("Not executed by the Host")',
      );
    }
    await mkdir(path.join(root, "Invalid"));
    let requestId = 0;
    const desktop = (method: string, params: JsonObject) => {
      const id = ++requestId;
      writeRequest(fixture.desktopInput, { id, method, params });
      return fixture.collector.waitFor((message) => message.id === id);
    };
    const web = (method: string, params: JsonObject = {}) =>
      fixture.host.handleClientRequest(method, params);
    const list = async () => {
      const response = await web(DESKTOP_EXTENSIONS_LIST_METHOD);
      expect(response).not.toHaveProperty("error");
      return desktopExtensionsListResultSchema.parse("result" in response ? response.result : null);
    };
    expect(
      await desktop(DESKTOP_EXTENSIONS_ENABLE_METHOD, { id: "future", expectedRevision: 0 }),
    ).toMatchObject({
      error: { code: -32602, message: expect.stringContaining("newer codexhost") },
    });
    expect(await web(DESKTOP_EXTENSIONS_RECOVER_METHOD, { dataDirectory: "/other" })).toMatchObject(
      {
        error: { code: -32602 },
      },
    );
    expect(
      await desktop(DESKTOP_EXTENSIONS_ENABLE_METHOD, { id: "badge", expectedRevision: 0 }),
    ).toMatchObject({
      result: { state: "saved", configuration: { enabled: ["badge"], revision: 1 } },
    });
    expect(
      await web(DESKTOP_EXTENSIONS_ENABLE_METHOD, { id: "tree", expectedRevision: 1 }),
    ).toEqual({
      result: { state: "slot-conflict", conflictWith: "badge" },
    });
    expect(
      await web(DESKTOP_EXTENSIONS_DISABLE_METHOD, { id: "badge", expectedRevision: 0 }),
    ).toEqual({
      result: { state: "revision-conflict", revision: 1 },
    });
    expect(await list()).toMatchObject({
      desktopConnected: false,
      extensions: expect.arrayContaining([
        expect.objectContaining({
          id: "badge",
          enabled: true,
          manifest: expect.objectContaining({
            name: badgeName,
            categories: badgeCategories,
            version: "1",
            slots: ["sidebar.thread-badge"],
          }),
          status: { state: "waiting" },
        }),
        expect.objectContaining({ id: "tree", enabled: false, status: { state: "disabled" } }),
        expect.objectContaining({
          id: "future",
          status: { state: "incompatible", error: expect.any(String) },
        }),
        expect.objectContaining({
          id: "Invalid",
          status: { state: "invalid", error: expect.any(String) },
        }),
      ]),
    });
    const badge = (await discoverDesktopExtensions(root)).extensions.find(
      (item) => item.id === "badge",
    );
    if (badge?.state !== "valid") throw new Error("Missing badge fixture");
    await mkdir(path.join(data, "diagnostics"), { recursive: true });
    for (const state of ["running", "failed"] as const) {
      const status =
        state === "failed"
          ? { state, hash: badge.hash, error: "Gallery failure" }
          : { state, hash: badge.hash };
      await writeFile(
        path.join(data, "diagnostics", "desktop-extensions-v1.json"),
        JSON.stringify({
          controllerPid: process.pid,
          updatedAt: new Date().toISOString(),
          targetId: "fixture",
          extensions: { badge: status },
        }),
      );
      const snapshot = await list();
      expect(snapshot.desktopConnected).toBe(true);
      expect(snapshot.extensions.find((item) => item.id === "badge")?.status).toEqual(status);
    }
    expect(
      await web(DESKTOP_EXTENSIONS_DISABLE_METHOD, { id: "badge", expectedRevision: 1 }),
    ).toMatchObject({
      result: { state: "saved", configuration: { enabled: [], revision: 2 } },
    });
    expect(
      await desktop(DESKTOP_EXTENSIONS_ENABLE_METHOD, { id: "tree", expectedRevision: 2 }),
    ).toMatchObject({
      result: { state: "saved", configuration: { enabled: ["tree"], revision: 3 } },
    });
    const recovered = await web(DESKTOP_EXTENSIONS_RECOVER_METHOD, { expectedRevision: 3 });
    const { configuration } = await readDesktopExtensionConfiguration(root);
    expect(configuration).toMatchObject({
      enabled: [],
      revision: 4,
      reloadToken: expect.any(String),
    });
    expect(recovered).toEqual({ result: { state: "saved", configuration } });
  } finally {
    await stopFixture(fixture);
  }
});

it("serves catalog and returns a fresh list after install, replacement and uninstall", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "desktop-market-rpc-"));
  const catalogUrl = path.join(scratch, "catalog.json");
  const fixture = createFixture({
    environment: { CODEXHOST_DESKTOP_EXTENSIONS_CATALOG_URL: catalogUrl },
  });
  try {
    await fixture.ready;
    await writeFile(
      catalogUrl,
      JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), extensions: [] }),
    );
    const web = (method: string, params: JsonObject) =>
      fixture.host.handleClientRequest(method, params);
    expect(await web(DESKTOP_EXTENSIONS_CATALOG_METHOD, {})).toMatchObject({
      result: { catalogUrl, source: "remote", cached: false, extensions: [] },
    });
    expect(await web(DESKTOP_EXTENSIONS_CATALOG_METHOD, { forceRefresh: "true" })).toMatchObject({
      error: { code: -32602 },
    });
    expect(await web(DESKTOP_EXTENSIONS_UNINSTALL_METHOD, { id: "../sample" })).toMatchObject({
      error: { code: -32602 },
    });
    const install = async (id: number, version: string) => {
      writeRequest(fixture.desktopInput, {
        id,
        method: DESKTOP_EXTENSIONS_INSTALL_METHOD,
        params: {
          source: {
            type: "zip-base64",
            fileName: "sample.zip",
            contentBase64: extensionZip({ version }).toString("base64"),
          },
        },
      });
      const response = await fixture.collector.waitFor((message) => message.id === id);
      return desktopExtensionsInstallResultSchema.parse(response.result);
    };
    const installed = await install(1, "1.0.0");
    expect(installed).toMatchObject({
      replaced: false,
      list: { extensions: [{ id: "sample", enabled: false }] },
    });
    expect(
      await web(DESKTOP_EXTENSIONS_ENABLE_METHOD, {
        id: "sample",
        expectedRevision: installed.list.configuration.revision,
      }),
    ).toMatchObject({ result: { state: "saved" } });
    expect(await install(2, "2.0.0")).toMatchObject({
      replaced: true,
      list: {
        configuration: { enabled: ["sample"], revision: 3 },
        extensions: [
          {
            id: "sample",
            enabled: true,
            manifest: { version: "2.0.0" },
            status: { state: "waiting" },
          },
        ],
      },
    });
    const removed = await web(DESKTOP_EXTENSIONS_UNINSTALL_METHOD, { id: "sample" });
    expect(
      desktopExtensionsUninstallResultSchema.parse("result" in removed ? removed.result : null),
    ).toMatchObject({
      removedId: "sample",
      list: { configuration: { enabled: [], revision: 4 }, extensions: [] },
    });
  } finally {
    await stopFixture(fixture);
    await rm(scratch, { recursive: true, force: true });
  }
});

it("does not expose Desktop extension management on an SSH-managed Host", async () => {
  const fixture = createFixture({ environment: { CODEXHOST_REMOTE_SSH_MANAGED: "1" } });
  try {
    await fixture.ready;
    expect(
      await fixture.host.handleClientRequest(DESKTOP_EXTENSIONS_RECOVER_METHOD, {}),
    ).toMatchObject({
      error: { code: -32601 },
    });
    const { configuration } = await readDesktopExtensionConfiguration(
      path.join(fixture.mappingStoreDirectory, "desktop-extensions"),
    );
    expect(configuration).toEqual({ version: 1, revision: 0, enabled: [] });
  } finally {
    await stopFixture(fixture);
  }
});
