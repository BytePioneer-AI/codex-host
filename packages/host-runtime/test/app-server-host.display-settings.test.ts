import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  HARNESS_DISPLAY_GET_METHOD,
  HARNESS_DISPLAY_SET_METHOD,
} from "@codexhost/shared-contracts";
import { createFixture, stopFixture, writeRequest, requestId } from "./app-server-host-fixture.js";

it("routes Web and Desktop display settings through the shared local file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "display-rpc-"));
  const desktop = createFixture({ environment: { CODEXHOST_DATA_DIR: directory } });
  const consoleHost = createFixture({ environment: { CODEXHOST_DATA_DIR: directory } });
  try {
    const entries = [{ agent: "grok", section: "more" }];
    expect(
      await consoleHost.host.handleConsoleRequest(HARNESS_DISPLAY_SET_METHOD, { entries }),
    ).toEqual({ result: { entries } });
    writeRequest(desktop.desktopInput, { id: 701, method: HARNESS_DISPLAY_GET_METHOD, params: {} });
    expect(await desktop.collector.waitFor((message) => requestId(message, 701))).toMatchObject({
      result: { entries },
    });
    writeRequest(desktop.desktopInput, {
      id: 702,
      method: HARNESS_DISPLAY_SET_METHOD,
      params: { entries: [] },
    });
    expect(await desktop.collector.waitFor((message) => requestId(message, 702))).toMatchObject({
      result: { entries: [] },
    });
    expect(await consoleHost.host.handleConsoleRequest(HARNESS_DISPLAY_GET_METHOD, {})).toEqual({
      result: { entries: [] },
    });
    expect(
      await consoleHost.host.handleConsoleRequest(HARNESS_DISPLAY_SET_METHOD, {
        entries: [{ agent: "pi", section: "invalid" }],
      }),
    ).toMatchObject({ error: { code: -32602 } });
    expect(
      await consoleHost.host.handleConsoleRequest(HARNESS_DISPLAY_SET_METHOD, {
        entries: [entries[0], entries[0]],
      }),
    ).toMatchObject({ error: { code: -32602 } });
    expect(
      await consoleHost.host.handleConsoleRequest(HARNESS_DISPLAY_GET_METHOD, { extra: true }),
    ).toMatchObject({ error: { code: -32602 } });
    expect(desktop.official.stdin.readableLength).toBe(0);
  } finally {
    await stopFixture(desktop);
    await stopFixture(consoleHost);
    await rm(directory, { recursive: true, force: true });
  }
});
