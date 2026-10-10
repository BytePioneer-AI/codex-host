import { describe, expect, it, vi } from "vitest";
import type { HarnessAdapter } from "@codexhost/harness-adapter";
import { handleHarnessInstallation } from "../src/harness-installation.js";

const state = {
  currentVersion: "1.0.0",
  latestVersion: "1.0.0",
  updateAvailable: false,
  canUpdate: true,
};
function fixture() {
  const install = vi.fn(async (): Promise<void> => undefined);
  const inspection = vi.fn(async () => ({ status: "notInstalled" }));
  const installation = vi.fn(async () => state);
  const adapter = { inspect: inspection, install, installation } as unknown as HarnessAdapter;
  const adapters = new Map([["pi", adapter]]);
  return {
    install,
    inspection,
    installation,
    adapter,
    run: (action = "install") => handleHarnessInstallation({ harnessId: "pi", action }, adapters),
  };
}
describe("first-time Harness installation", () => {
  it("coalesces duplicate installs and concurrent checks, then verifies the CLI", async () => {
    const f = fixture();
    const gate = Promise.withResolvers<undefined>();
    f.install.mockImplementation(() => gate.promise);
    const first = f.run();
    const second = f.run();
    const check = f.run("check");
    await vi.waitFor(() => expect(f.install).toHaveBeenCalledOnce());
    expect(f.installation).not.toHaveBeenCalled();
    gate.resolve(undefined);
    await expect(Promise.all([first, second, check])).resolves.toEqual([state, state, state]);
    expect(f.installation).toHaveBeenCalledExactlyOnceWith("check");
  });
  it.each(["ready", "unavailable", "error"])("never overwrites a %s Harness", async (status) => {
    const f = fixture();
    f.inspection.mockResolvedValue({ status });
    await expect(f.run()).rejects.toMatchObject({ code: -32077 });
    expect(f.install).not.toHaveBeenCalled();
  });
  it("sanitizes failures, clears pending state, and allows retry", async () => {
    const f = fixture();
    f.install.mockRejectedValueOnce(new Error("secret-token"));
    await expect(f.run()).rejects.toThrow("installation failed");
    await expect(f.run()).resolves.toEqual(state);
    expect(f.install).toHaveBeenCalledTimes(2);
  });
  it("requires a first-time install capability, not just update support", async () => {
    const f = fixture();
    delete f.adapter.install;
    await expect(f.run()).rejects.toMatchObject({ code: -32078 });
    expect(f.installation).not.toHaveBeenCalled();
  });
  it("does not report success when readback fails", async () => {
    const f = fixture();
    f.installation.mockRejectedValueOnce(new Error("native-secret"));
    await expect(f.run()).rejects.toThrow("could not be confirmed");
  });
});
