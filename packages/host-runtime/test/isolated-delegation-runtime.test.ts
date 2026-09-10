import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { startIsolatedDelegationRuntime } from "../src/isolated-delegation-runtime.js";
import { DELEGATION_RUNTIME_ENDPOINT_ENV } from "../src/delegation-types.js";

describe("isolated delegation runtime", () => {
  it("starts a loopback control plane that does not inherit the Desktop endpoint", async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-isolated-runtime-"));
    const inherited = process.env[DELEGATION_RUNTIME_ENDPOINT_ENV];
    process.env[DELEGATION_RUNTIME_ENDPOINT_ENV] = "http://127.0.0.1:1";
    let runtime;
    try {
      runtime = await startIsolatedDelegationRuntime({
        dataDirectory,
        cliPath: "/synthetic/codexhost-cli",
        mode: "hermetic",
        environment: process.env,
        externalAdapters: new Map([
          ["grok", new FakeHarnessAdapter(harnessIdSchema.parse("grok"))],
        ]),
      });
      expect(new URL(runtime.endpoint).hostname).toBe("127.0.0.1");
      expect(runtime.endpoint).not.toBe("http://127.0.0.1:1");
      expect(runtime.officialKind).toBe("fixture");
      const child = runtime.childEnvironment();
      expect(child[DELEGATION_RUNTIME_ENDPOINT_ENV]).toBe(runtime.endpoint);
      expect(child.CODEXHOST_DATA_DIR).toBe(path.resolve(dataDirectory));
    } finally {
      if (inherited === undefined) delete process.env[DELEGATION_RUNTIME_ENDPOINT_ENV];
      else process.env[DELEGATION_RUNTIME_ENDPOINT_ENV] = inherited;
      if (runtime) await runtime.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});
