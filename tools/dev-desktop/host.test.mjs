import { describe, expect, it, vi } from "vitest";
import { restartDevelopmentHost } from "./host.mjs";

const artifacts = { launcher: "/launcher", node: "/node", hostRuntime: "/repo/host.js" };
describe("development Host restart", () => {
  it("uses the already validated build and explicit data directory without building again", async () => {
    const environment = {
      CODEXHOST_DATA_DIR: "/data",
      CODEXHOST_NPM_PACKAGE_ROOT: "/old",
      HTTPS_PROXY: "http://proxy",
    };
    const run = vi.fn(async () => ({ code: 0 }));
    await restartDevelopmentHost({ artifacts, environment, run });
    expect(run).toHaveBeenCalledExactlyOnceWith(
      {
        command: "/launcher",
        arguments: [
          "host",
          "restart",
          "--node",
          "/node",
          "--host-runtime",
          "/repo/host.js",
          "--data",
          "/data",
        ],
      },
      { CODEXHOST_DATA_DIR: "/data", HTTPS_PROXY: "http://proxy" },
    );
    expect(environment.CODEXHOST_NPM_PACKAGE_ROOT).toBe("/old");
  });
  it("stops interface startup when native restart fails", async () => {
    await expect(
      restartDevelopmentHost({ artifacts, environment: {}, run: async () => ({ code: 1 }) }),
    ).rejects.toThrow("Host restart failed");
  });
});
