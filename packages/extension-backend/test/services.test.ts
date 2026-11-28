import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { ExtensionBackendProcess } from "../src/index.js";
import { extensionHarnessPresentationSchema } from "@codexhost/shared-contracts";

it("exposes current activity over isolated backend IPC without inheriting Host secrets", async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "extension-services-")));
  const source = `export function activate(ctx) {
    ctx.handle('state', async () => ({
      activity: await ctx.activity.read(),
      windows: ctx.windows.available,
      clickThrough: ctx.windows.clickThroughSupported,
      secret: process.env.PET_HOST_SECRET ?? null,
    }));
    ctx.handle('window', () => ctx.windows.open({ url: 'http://127.0.0.1:1234/', width: 240, height: 280 }));
    ctx.handle('show-host', () => ctx.windows.showHost('/'));
    ctx.handle('icon', ({ id }) => ctx.harnesses.describe(id));
    return () => ctx.writeSettings({ disposed: true });
  }`;
  const entry = path.join(directory, "backend.mjs");
  await writeFile(entry, source);
  const { dev, ino } = await stat(directory, { bigint: true });
  let running = 1;
  let disposed = false;
  process.env.PET_HOST_SECRET = "host-only";
  const backend = new ExtensionBackendProcess({
    readSettings: async () => ({}),
    writeSettings: async (values) => {
      disposed = values.disposed === true;
      return values;
    },
    readActivity: async () => ({
      epoch: "test",
      revision: 1,
      running,
      waiting: 0,
      sessions: [],
      notifications: [],
    }),
    describeHarness: async (id) =>
      id === "example"
        ? extensionHarnessPresentationSchema.parse({
            id,
            name: "Example Agent",
            iconStyle: {
              vector: {
                viewBox: "0 0 24 24",
                color: "currentColor",
                paths: [{ d: "M0 0h24v24H0z" }],
              },
            },
          })
        : null,
  });
  try {
    await backend.activate({
      extensionId: "sample",
      extensionDir: directory,
      dataDir: directory,
      url: pathToFileURL(entry).href,
      hash: createHash("sha256").update(source).digest("hex"),
      installation: `${dev}:${ino}`,
    });
    expect(await backend.invoke("state", null)).toMatchObject({
      activity: { running: 1 },
      windows: false,
      clickThrough: false,
      secret: null,
    });
    running = 0;
    expect(await backend.invoke("state", null)).toMatchObject({ activity: { running: 0 } });
    expect(await backend.invoke("icon", { id: "example" })).toMatchObject({
      id: "example",
      name: "Example Agent",
      iconStyle: { vector: { color: "currentColor" } },
    });
    expect(await backend.invoke("icon", { id: "missing" })).toBe(null);
    await expect(backend.invoke("icon", { id: "../escape" })).rejects.toThrow(
      "Could not read Harness metadata",
    );
    await expect(backend.invoke("window", null)).rejects.toThrow("unavailable");
    await expect(backend.invoke("show-host", null)).rejects.toThrow(
      "Could not open the CodexHost Desktop Shell window",
    );
    await backend.stop();
    expect(disposed).toBe(true);
  } finally {
    delete process.env.PET_HOST_SECRET;
    await backend.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it("isolates harness metadata IPC quota from settings and activity requests", async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "extension-ipc-lanes-")));
  const source = `export function activate(ctx) {
    ctx.handle('burst', async () => {
      const harnesses = Promise.all(
        Array.from({ length: 8 }, (_, index) => ctx.harnesses.describe('agent-' + index)),
      );
      const settings = Promise.all([
        ctx.readSettings(),
        ctx.readSettings(),
        ctx.readSettings(),
        ctx.readSettings(),
      ]);
      const activity = ctx.activity.read();
      const [described, saved, current] = await Promise.all([harnesses, settings, activity]);
      return {
        described: described.map((item) => item?.id ?? null),
        settingsCount: saved.length,
        running: current.running,
      };
    });
  }`;
  const entry = path.join(directory, "backend.mjs");
  await writeFile(entry, source);
  const { dev, ino } = await stat(directory, { bigint: true });
  const release = Promise.withResolvers<undefined>();
  let inFlightSettings = 0;
  let inFlightHarnesses = 0;
  const maybeRelease = () => {
    if (inFlightSettings === 4 && inFlightHarnesses === 8) release.resolve(undefined);
  };
  const backend = new ExtensionBackendProcess({
    readSettings: async () => {
      inFlightSettings++;
      maybeRelease();
      await release.promise;
      return { ok: true };
    },
    writeSettings: async (values) => values,
    readActivity: async () => ({
      epoch: "lanes",
      revision: 1,
      running: 2,
      waiting: 0,
      sessions: [],
      notifications: [],
    }),
    describeHarness: async (id) => {
      inFlightHarnesses++;
      maybeRelease();
      await release.promise;
      return extensionHarnessPresentationSchema.parse({ id, name: id });
    },
  });
  try {
    await backend.activate({
      extensionId: "lanes",
      extensionDir: directory,
      dataDir: directory,
      url: pathToFileURL(entry).href,
      hash: createHash("sha256").update(source).digest("hex"),
      installation: `${dev}:${ino}`,
    });
    expect(await backend.invoke("burst", null)).toEqual({
      described: Array.from({ length: 8 }, (_, index) => `agent-${index}`),
      settingsCount: 4,
      running: 2,
    });
  } finally {
    release.resolve(undefined);
    await backend.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
