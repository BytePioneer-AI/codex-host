import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import { BrokeredHarnessAdapter, startHarnessBrokerServer } from "../src/index.js";
import * as framing from "../src/framing.js";

it("keeps steering conservative on brokers that do not advertise capability reads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cx-caps-"));
  const descriptorPath = path.join(root, "broker.json");
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\cx-caps-${randomUUID()}`
      : path.join(root, "b.sock");
  const native = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
  native.supportsSteer = true;
  const write = framing.writeBrokerFrame;
  // Older open responses have capabilities but no declaration of the new read method.
  const frames = vi
    .spyOn(framing, "writeBrokerFrame")
    .mockImplementation((socket, value) =>
      write(
        socket,
        JSON.parse(
          JSON.stringify(value, (key, field) => (key === "readCapabilities" ? undefined : field)),
        ),
      ),
    );
  const server = await startHarnessBrokerServer({ descriptorPath, socketPath, adapter: native });
  const broker = new BrokeredHarnessAdapter({ harnessId: "pi", descriptorPath });
  try {
    const opened = await broker.open({ kind: "create", cwd: root });
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.value.capabilities.steer).toBe(true);
    await expect(opened.value.readCapabilities?.()).resolves.toMatchObject({ steer: false });
    expect(frames).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ method: "session.readCapabilities" }),
    );
    await expect(opened.value.readSnapshot()).resolves.toMatchObject({ ok: true });
    await opened.value.close();
  } finally {
    await broker.close();
    await server.close();
    frames.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
