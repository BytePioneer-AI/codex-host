import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { startHarnessBrokerServer } from "@codexhost/harness-broker";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { createHarnessAdapter } from "../src/plugin.js";

const delegationEnvironment = {
  CODEXHOST_CLI_PATH: "/opt/codexhost/bin/codexhost",
  CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
  CODEXHOST_RUNTIME_TOKEN: "private-runtime-token",
  CODEXHOST_THREAD_ID: "workbuddy-child",
};

describe("WorkBuddy managed broker delegation", () => {
  it("forwards only scoped CODEXHOST variables on create and resume", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-workbuddy-broker-"));
    const descriptorPath = path.join(root, "broker.json");
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\codexhost-workbuddy-${randomUUID()}`
        : path.join(root, "broker.sock");
    const native = new FakeHarnessAdapter(harnessIdSchema.parse("workbuddy"));
    const open = vi.spyOn(native, "open");
    const server = await startHarnessBrokerServer({ descriptorPath, socketPath, adapter: native });
    const adapter = createHarnessAdapter({
      environment: {},
      platform: "darwin",
      managedRemoteHost: true,
      brokerDescriptorPath: descriptorPath,
    });
    try {
      expect(adapter.constructor.name).toBe("BrokeredHarnessAdapter");
      const created = await adapter.open({
        kind: "create",
        cwd: root,
        environment: {
          ...delegationEnvironment,
          HOME: "/must/not/forward",
          PATH: "/must/not/forward",
        },
        executionPolicy: "unattended-full-access",
      });
      if (!created.ok) throw new Error(created.error.message);
      const nativeRef = created.value.initialState.nativeRef;
      if (!nativeRef) throw new Error("Broker did not return WorkBuddy native identity");
      await created.value.close();
      const resumed = await adapter.open({
        kind: "resume",
        cwd: root,
        nativeRef,
        environment: {
          ...delegationEnvironment,
          HOME: "/must/not/forward",
          PATH: "/must/not/forward",
        },
      });
      if (!resumed.ok) throw new Error(resumed.error.message);

      expect(open).toHaveBeenCalledTimes(2);
      for (const input of open.mock.calls.map(([value]) => value)) {
        expect(input.environment).toEqual(delegationEnvironment);
        expect(input.environment).not.toHaveProperty("HOME");
        expect(input.environment).not.toHaveProperty("PATH");
      }
    } finally {
      await adapter.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
