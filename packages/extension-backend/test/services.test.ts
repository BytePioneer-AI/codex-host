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
    ctx.handle('state', async () => ({ activity: await ctx.activity.read(), windows: ctx.windows.available, secret: process.env.PET_HOST_SECRET ?? null }));
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
    await expect(backend.invoke("icon", { id: "../escape" })).rejects.toThrow();
    await expect(backend.invoke("window", null)).rejects.toThrow("unavailable");
    await expect(backend.invoke("show-host", null)).rejects.toThrow(
      "Could not open the Host window",
    );
    await backend.stop();
    expect(disposed).toBe(true);
  } finally {
    delete process.env.PET_HOST_SECRET;
    await backend.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
