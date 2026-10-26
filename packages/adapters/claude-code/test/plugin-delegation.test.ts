import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { startHarnessBrokerServer } from "@codexhost/harness-broker";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import { createHarnessAdapter } from "../src/plugin.js";

it("the managed Mac Claude plugin forwards scoped CLI credentials through its real broker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cx-claude-delegation-"));
  const descriptorPath = path.join(root, "broker.json");
  const native = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
  const open = vi.spyOn(native, "open");
  const server = await startHarnessBrokerServer({
    adapter: native,
    descriptorPath,
    socketPath:
      process.platform === "win32"
        ? `\\\\.\\pipe\\cx-claude-${randomUUID()}`
        : path.join(root, "b.sock"),
  });
  const adapter = await createHarnessAdapter({
    platform: "darwin",
    managedRemoteHost: true,
    brokerDescriptorPath: descriptorPath,
    environment: {},
  });
  const scoped = {
    CODEXHOST_CLI_PATH: "/synthetic/codexhost",
    CODEXHOST_CLI_NODE_PATH: "/synthetic/node",
    CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
    CODEXHOST_RUNTIME_TOKEN: "synthetic-runtime-token",
    CODEXHOST_THREAD_ID: "parent",
  };
  try {
    const result = await adapter.open({
      kind: "create",
      cwd: root,
      environment: { ...scoped, HOME: "/foreign", PATH: "/foreign", NATIVE_SECRET: "excluded" },
    });
    expect(result.ok).toBe(true);
    expect(open.mock.calls[0]?.[0].environment).toEqual(scoped);
  } finally {
    await adapter.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
