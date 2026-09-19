import { describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import type { HarnessAdapter } from "@codexhost/harness-adapter";
import {
  HARNESS_CONNECTION_GET_METHOD as GET,
  HARNESS_CONNECTION_SET_METHOD as SET,
  harnessIdSchema,
} from "@codexhost/shared-contracts";
import { handleHarnessConnectionSettings } from "../src/harness-connection-settings.js";

type Connection = NonNullable<HarnessAdapter["connection"]>;
const id = harnessIdSchema.parse("fixture");
const state = {
  supported: true as const,
  configured: true,
  restartRequired: true,
  description: "Native connection",
};
function fixture() {
  const connection = {
    get: vi.fn<Connection["get"]>().mockResolvedValue({ ok: true, value: state }),
    set: vi.fn<Connection["set"]>().mockResolvedValue({ ok: true, value: state }),
  };
  const adapter = Object.assign(new FakeHarnessAdapter(id), { connection });
  const adapters = new Map<string, HarnessAdapter>([[id, adapter]]);
  return { connection, adapters };
}
describe("write-only native connection settings", () => {
  it("routes to the plugin and returns only validated status", async () => {
    const f = fixture();
    expect(await handleHarnessConnectionSettings(GET, { harnessId: id }, f.adapters)).toEqual({
      result: state,
    });
    expect(
      await handleHarnessConnectionSettings(
        SET,
        { harnessId: id, secret: "private-fixture-link" },
        f.adapters,
      ),
    ).toEqual({ result: state });
    expect(f.connection.set).toHaveBeenCalledExactlyOnceWith("private-fixture-link");
    await handleHarnessConnectionSettings(
      SET,
      { harnessId: id, secret: "link", cwd: "/fixture" },
      f.adapters,
    );
    expect(f.connection.set).toHaveBeenLastCalledWith("link", "/fixture");
    await handleHarnessConnectionSettings(SET, { harnessId: id, secret: null }, f.adapters);
    expect(f.connection.set).toHaveBeenLastCalledWith(null);
  });
  it("does not expose secrets from error bodies, thrown exceptions, or extra response fields", async () => {
    const f = fixture(),
      secret = "private-unstructured-link";
    f.connection.set
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "invalidRequest", message: secret, retryable: false },
      })
      .mockRejectedValueOnce(new Error(secret));
    f.connection.get.mockResolvedValueOnce({ ok: true, value: { ...state, ...{ secret } } });
    for (const method of [SET, SET, GET]) {
      const result = await handleHarnessConnectionSettings(
        method,
        { harnessId: id, ...(method === SET ? { secret } : {}) },
        f.adapters,
      );
      expect(result).toHaveProperty("error");
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });
  it("rejects invalid payloads before calling the plugin and supports older plugins", async () => {
    const f = fixture();
    for (const secret of ["", "x".repeat(8193), 42, undefined])
      expect(
        await handleHarnessConnectionSettings(SET, { harnessId: id, secret }, f.adapters),
      ).toHaveProperty("error");
    expect(f.connection.set).not.toHaveBeenCalled();
    const adapters = new Map<string, HarnessAdapter>([[id, new FakeHarnessAdapter(id)]]);
    expect(await handleHarnessConnectionSettings(GET, { harnessId: id }, adapters)).toEqual({
      result: { supported: false },
    });
    expect(
      await handleHarnessConnectionSettings(SET, { harnessId: id, secret: "link" }, adapters),
    ).toHaveProperty("error");
  });
});
