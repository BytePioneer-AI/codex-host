import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { JsonValue } from "@codexhost/protocol-core";
import {
  SETTINGS_PLUGIN_LIST_METHOD,
  SETTINGS_PLUGIN_READ_METHOD,
} from "@codexhost/shared-contracts";
import { createFixture, stopFixture, writeRequest, requestId } from "./app-server-host-fixture.js";

it("routes settings page registration and lazy reads only to the local plugin files", async () => {
  const data = await mkdtemp(path.join(os.tmpdir(), "settings-page-rpc-"));
  await cp(
    path.resolve(import.meta.dirname, "../../../examples/settings-plugins"),
    path.join(data, "settings-plugins"),
    { recursive: true },
  );
  const fixture = createFixture({ environment: { CODEXHOST_DATA_DIR: data } });
  try {
    const request = async (id: number, method: string, params: JsonValue) => {
      writeRequest(fixture.desktopInput, { id, method, params });
      return fixture.collector.waitFor((message) => requestId(message, id));
    };
    expect(await request(910, SETTINGS_PLUGIN_LIST_METHOD, {})).toMatchObject({
      result: { pages: [{ pluginId: "example-page", id: "overview" }], unavailable: [] },
    });
    expect(
      await request(911, SETTINGS_PLUGIN_READ_METHOD, {
        pluginId: "example-page",
        pageId: "overview",
      }),
    ).toMatchObject({ result: { html: expect.stringContaining("Increase count") } });
    expect(
      await request(912, SETTINGS_PLUGIN_READ_METHOD, {
        pluginId: "../outside",
        pageId: "overview",
      }),
    ).toMatchObject({ error: { code: -32602 } });
    expect(
      await request(913, SETTINGS_PLUGIN_READ_METHOD, { pluginId: "disabled", pageId: "overview" }),
    ).toMatchObject({ error: { code: -32081 } });
    expect(await request(914, SETTINGS_PLUGIN_LIST_METHOD, { extra: true })).toMatchObject({
      error: { code: -32602 },
    });
    expect(fixture.official.stdin.readableLength).toBe(0);
  } finally {
    await stopFixture(fixture);
    await rm(data, { recursive: true, force: true });
  }
});
