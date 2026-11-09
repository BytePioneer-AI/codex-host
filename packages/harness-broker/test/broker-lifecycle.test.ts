import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema } from "@codexhost/shared-contracts";

import {
  BrokeredHarnessAdapter,
  startHarnessBrokerServer,
  type HarnessBrokerServer,
} from "../src/index.js";

const roots: string[] = [];
const servers: HarnessBrokerServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ descriptorPath: string; socketPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cx-broker-life-"));
  roots.push(root);
  return {
    descriptorPath: path.join(root, "broker.json"),
    socketPath:
      process.platform === "win32"
        ? `\\\\.\\pipe\\cx-broker-${randomUUID()}`
        : path.join(root, "b.sock"),
  };
}

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

const until = async (condition: () => boolean | Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** Starts a broker the way the LaunchAgent would, exiting (closing) when it retires. */
function launcher(paths: { descriptorPath: string; socketPath: string }, idleMs: number) {
  const started: HarnessBrokerServer[] = [];
  let starting: Promise<void> | undefined;
  const start = vi.fn(async () => {
    // Like launchctl kickstart: a no-op while a broker process still runs.
    if (starting) return starting;
    if (started.some((server) => !retired.has(server))) return;
    starting = (async () => {
      const server = await startHarnessBrokerServer({
        ...paths,
        adapter: new FakeHarnessAdapter(harnessIdSchema.parse("codebuddy")),
        idle: {
          timeoutMs: idleMs,
          onRetire: () => {
            retired.add(server);
            void server.close();
          },
        },
      });
      started.push(server);
      servers.push(server);
    })().finally(() => {
      starting = undefined;
    });
    return starting;
  });
  const retired = new Set<HarnessBrokerServer>();
  return { start, started, retired };
}

describe("on-demand Aqua Harness broker lifecycle", () => {
  it("starts a broker only when needed and never for a CLI that is not installed", async () => {
    const paths = await fixture();
    const { start, started } = launcher(paths, 60_000);
    const missing = new BrokeredHarnessAdapter({
      harnessId: "codebuddy",
      descriptorPath: paths.descriptorPath,
      startBroker: start,
      isInstalled: () => false,
    });
    expect(await missing.inspect()).toMatchObject({
      status: "notInstalled",
      error: { code: "notInstalled" },
    });
    expect(start).not.toHaveBeenCalled();
    await missing.close();

    const client = new BrokeredHarnessAdapter({
      harnessId: "codebuddy",
      descriptorPath: paths.descriptorPath,
      startBroker: start,
      isInstalled: () => true,
    });
    try {
      expect((await client.inspect()).status).toBe("ready");
      expect(started).toHaveLength(1);
      expect((await client.inspect()).status).toBe("ready");
      expect(started).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("never retires while a Session is open", async () => {
    const paths = await fixture();
    const { start, retired } = launcher(paths, 50);
    const client = new BrokeredHarnessAdapter({
      harnessId: "codebuddy",
      descriptorPath: paths.descriptorPath,
      startBroker: start,
    });
    try {
      const opened = await client.open({ kind: "create", cwd: "/synthetic" });
      if (!opened.ok) throw new Error(opened.error.message);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(retired.size).toBe(0);
      await opened.value.close();
      await until(() => retired.size === 1);
    } finally {
      await client.close();
    }
  });

  it("retires right after an inspection reports the Harness unusable", async () => {
    const paths = await fixture();
    const native = new FakeHarnessAdapter(harnessIdSchema.parse("codebuddy"));
    vi.spyOn(native, "inspect").mockResolvedValue({
      status: "unavailable",
      error: { code: "authenticationRequired", message: "Sign in first", retryable: true },
    });
    let retiredOnce = false;
    const server = await startHarnessBrokerServer({
      ...paths,
      adapter: native,
      idle: {
        timeoutMs: 60_000,
        onRetire: () => {
          retiredOnce = true;
        },
      },
    });
    servers.push(server);
    const client = new BrokeredHarnessAdapter({
      harnessId: "codebuddy",
      descriptorPath: paths.descriptorPath,
      startBroker: false,
    });
    try {
      expect(await client.inspect()).toMatchObject({
        status: "unavailable",
        error: { message: "Sign in first" },
      });
      await until(() => retiredOnce);
    } finally {
      await client.close();
    }
  });

  it("refuses requests as retryable while retiring and the client retries on a new broker", async () => {
    const paths = await fixture();
    let first: HarnessBrokerServer | undefined;
    let releaseRetire = (): void => undefined;
    const start = vi.fn(async () => {
      if (!first) {
        // A retiring broker keeps its connection open briefly (the grace period).
        first = await startHarnessBrokerServer({
          ...paths,
          adapter: new FakeHarnessAdapter(harnessIdSchema.parse("codebuddy")),
          idle: {
            timeoutMs: 50,
            onRetire: () => {
              releaseRetire = () => void first?.close();
            },
          },
        });
        servers.push(first);
        return;
      }
      releaseRetire();
      if (await exists(paths.descriptorPath)) return;
      servers.push(
        await startHarnessBrokerServer({
          ...paths,
          adapter: new FakeHarnessAdapter(harnessIdSchema.parse("codebuddy")),
        }),
      );
    });
    const client = new BrokeredHarnessAdapter({
      harnessId: "codebuddy",
      descriptorPath: paths.descriptorPath,
      startBroker: start,
    });
    try {
      expect((await client.inspect()).status).toBe("ready");
      await until(async () => !(await exists(paths.descriptorPath)));
      // The open reaches the retiring broker over the kept connection, is refused
      // unprocessed, and is retried once on the replacement broker.
      const opened = await client.open({ kind: "create", cwd: "/synthetic" });
      expect(opened.ok).toBe(true);
      if (opened.ok) await opened.value.close();
    } finally {
      await client.close();
    }
  });
});
