import { describe, expect, it, vi } from "vitest";
import { RuntimeMaintenance } from "../src/runtime-maintenance.js";
import { createFixture, requestId, stopFixture, writeRequest } from "./app-server-host-fixture.js";

describe("remote maintenance admission", () => {
  it("validates and routes SSH setup through the local maintenance owner", async () => {
    const runtimeMaintenance = new RuntimeMaintenance({
      runtimePath: "/missing/runtime.mjs",
      remote: false,
      environment: { HOME: "/missing" },
    });
    const setup = vi
      .spyOn(runtimeMaintenance, "setupSsh")
      .mockResolvedValue({ state: "not-installed" });
    const fixture = createFixture({ runtimeMaintenance });
    try {
      await fixture.ready;
      const params = {
        hostname: "user@host",
        port: 22,
        identity: null,
        action: "inspect",
        version: null,
      };
      writeRequest(fixture.desktopInput, { id: 1, method: "codexhost/remote/ssh-setup", params });
      expect(await fixture.collector.waitFor((m) => requestId(m, 1))).toMatchObject({
        result: { state: "not-installed" },
      });
      expect(setup).toHaveBeenCalledWith(params);
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "codexhost/remote/ssh-setup",
        params: { ...params, hostname: "-oProxyCommand=bad" },
      });
      expect(await fixture.collector.waitFor((m) => requestId(m, 2))).toHaveProperty("error");
      expect(setup).toHaveBeenCalledTimes(1);
    } finally {
      await stopFixture(fixture);
    }
  });
  it("keeps status readable while blocking native and external starts during installation", async () => {
    const runtimeMaintenance = new RuntimeMaintenance({
      runtimePath: "/missing/runtime.mjs",
      remote: false,
      environment: { HOME: "/missing" },
    });
    const fixture = createFixture({ runtimeMaintenance });
    try {
      await fixture.ready;
      vi.spyOn(runtimeMaintenance, "blocked", "get").mockReturnValue(true);
      writeRequest(fixture.desktopInput, { id: 1, method: "codexhost/runtime/status", params: {} });
      expect(await fixture.collector.waitFor((m) => requestId(m, 1))).toMatchObject({
        result: { runningVersion: null, updateSupported: false },
      });
      for (const [id, params] of [
        [2, {}],
        [3, { modelProvider: "codexhost", agent: "pi" }],
      ] as const) {
        writeRequest(fixture.desktopInput, { id, method: "thread/start", params });
        expect(await fixture.collector.waitFor((m) => requestId(m, id))).toMatchObject({
          error: { code: -32090, message: "Remote service is updating; reconnect shortly" },
        });
      }
      expect(fixture.adapter.sessions).toHaveLength(0);
    } finally {
      await stopFixture(fixture);
    }
  });
});
