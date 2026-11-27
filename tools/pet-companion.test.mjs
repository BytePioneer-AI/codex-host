import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { makeZip } from "../tests/fixtures/desktop-extension-zip.js";
import { readPetArchive } from "../extensions/pet-companion/backend/archive.mjs";
import { createLibrary } from "../extensions/pet-companion/backend/library.mjs";
import { normalizePet, searchMarket } from "../extensions/pet-companion/backend/markets.mjs";
import { createWindowServer } from "../extensions/pet-companion/backend/window-server.mjs";
import { activate } from "../extensions/pet-companion/backend/index.mjs";
import { readGallery } from "../extensions/pet-companion/backend/gallery.mjs";
import { DEFAULT_PET_KEY } from "../extensions/pet-companion/backend/builtin.mjs";

const cleanup = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const image = (version = 1) => {
  const bytes = Buffer.alloc(30);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(bytes);
  bytes.writeUInt32BE(1536, 16);
  bytes.writeUInt32BE(version === 2 ? 2288 : 1872, 20);
  return bytes;
};
const archive = (extra = [], version = 1) =>
  makeZip([
    {
      name: "pet.json",
      data: JSON.stringify({
        id: "sample",
        displayName: "Sample",
        spritesheetPath: "atlas.png",
        spriteVersionNumber: version,
      }),
    },
    { name: "atlas.png", data: image(version), deflate: true },
    { name: "LICENSE.txt", data: "Test creator permission" },
    ...extra,
  ]);

it("reads both atlas versions, retains license text and ignores executable payloads", async () => {
  for (const version of [1, 2]) {
    const parsed = await readPetArchive(
      archive([{ name: "untrusted.mjs", data: "throw new Error('never evaluate')" }], version),
    );
    expect(parsed).toMatchObject({
      version,
      mime: "image/png",
      licenses: [{ name: "LICENSE.txt", text: "Test creator permission" }],
    });
    expect(parsed.image).toEqual(image(version));
  }
});

it.each([
  { name: "../escape.txt" },
  { name: "C:/escape.txt" },
  { name: "link", mode: 0xa000 },
  { name: "PET.JSON", data: "{}" },
])("rejects unsafe pet ZIP paths and ambiguous manifests: $name", async (extra) => {
  await expect(readPetArchive(archive([extra]))).rejects.toThrow(/Invalid pet package/u);
});

it("normalizes public markets and refuses credential-bearing or unrelated asset URLs", async () => {
  const row = {
    slug: "boba",
    displayName: "Boba",
    submittedBy: { name: "Artist" },
    spritesheetPath: "https://assets.petdex.dev/boba.webp",
    zipUrl: "https://assets.petdex.dev/boba.zip",
  };
  expect(normalizePet("petdex", row)).toMatchObject({
    key: "petdex:boba",
    author: "Artist",
    previewUrl: "https://assets.petdex.dev/pets/boba/thumb.webp",
  });
  expect(() => normalizePet("petdex", { ...row, zipUrl: "http://127.0.0.1/private" })).toThrow();
  expect(() =>
    normalizePet("petdex", { ...row, zipUrl: "https://secret@assets.petdex.dev/boba.zip" }),
  ).toThrow();
  vi.stubGlobal("fetch", async (url) => {
    expect(new URL(url).searchParams.get("cursor")).toBe("12");
    return Response.json({ pets: [row], nextCursor: 24, total: 30 });
  });
  expect(await searchMarket({ market: "petdex", page: 2, query: "Boba" })).toMatchObject({
    page: 2,
    hasMore: true,
    pets: [{ key: "petdex:boba" }],
  });
});

it("reads public gallery data without executing page scripts and rejects an unrecognized format", () => {
  const pet = {
    slug: "sample",
    name: 'A "quoted" pet',
    description: "Sample",
    tags: ["pixel"],
    contributorName: "Artist",
    spritesheetUrl: "https://codexpets.net/sample.png",
    detailHref: "/pets/sample",
    downloadHref: "/api/pets/sample/download",
  };
  const frame = JSON.stringify([1, `1:["$","$L11",{"pet":${JSON.stringify(pet)}}]\n`]);
  const rows = readGallery(
    `<script>throw new Error('never execute')</script><script>self.__next_f.push(${frame})</script>`,
  );
  expect(normalizePet("codexpets", rows[0])).toMatchObject({
    name: 'A "quoted" pet',
    author: "Artist",
    downloadUrl: "https://codexpets.net/api/pets/sample/download",
  });
  expect(() => readGallery("<html>Unavailable</html>")).toThrow("gallery format");
});

it("persists only validated sprites and reloads/removes a library without external file paths", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pet-library-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const library = await createLibrary(directory);
  expect(library.list()).toMatchObject([
    { key: DEFAULT_PET_KEY, builtin: true, renderer: "otter" },
  ]);
  expect((await library.sprite(DEFAULT_PET_KEY)).toString("utf8")).toContain(
    'aria-label="CodexHost"',
  );
  await expect(library.remove(DEFAULT_PET_KEY)).rejects.toThrow("cannot be removed");
  await library.install({ key: "petdex:sample", name: "Sample" }, archive());
  const restored = await createLibrary(directory);
  expect(restored.list()).toMatchObject([
    { key: DEFAULT_PET_KEY, builtin: true },
    { key: "petdex:sample", version: 1 },
  ]);
  expect(await restored.sprite("petdex:sample")).toEqual(image());
  await restored.remove("petdex:sample");
  expect((await createLibrary(directory)).list()).toMatchObject([{ key: DEFAULT_PET_KEY }]);
});

it("serves only authenticated window assets and denies cross-origin writes", async () => {
  let acknowledged = false;
  const service = await createWindowServer({
    extensionDir: path.resolve("extensions/pet-companion"),
    state: () => ({ selected: null }),
    sprite: async () => null,
    action: async (input) => {
      if (input.type === "acknowledge") acknowledged = true;
    },
  });
  cleanup.push(() => service.close());
  expect((await fetch(new URL("/state", service.url))).status).toBe(404);
  expect(await (await fetch(new URL("state", service.url))).json()).toEqual({ selected: null });
  expect(
    (
      await fetch(new URL("action", service.url), {
        method: "POST",
        headers: { origin: "https://example.com", "content-type": "application/json" },
        body: JSON.stringify({ type: "acknowledge" }),
      })
    ).status,
  ).toBe(403);
  expect(acknowledged).toBe(false);
  expect(
    (
      await fetch(new URL("action", service.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "acknowledge" }),
      })
    ).status,
  ).toBe(204);
  expect(acknowledged).toBe(true);
});

it("routes native actions through current sessions and acknowledges only the displayed revision", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pet-window-actions-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let settings = {};
  let windowUrl;
  let opened;
  let activity = {
    epoch: "actions",
    revision: 1,
    running: 0,
    waiting: 1,
    sessions: [
      {
        threadId: "task#1",
        title: "Review",
        project: "demo",
        state: "waiting",
        updatedAt: 1,
        harness: { id: "claude-code", name: "Claude Code" },
      },
    ],
    notifications: [{ threadId: "task#1", key: "first", kind: "question", revision: 1 }],
  };
  const handlers = new Map();
  cleanup.push(
    await activate({
      extensionDir: path.resolve("extensions/pet-companion"),
      dataDir: directory,
      readSettings: async () => settings,
      writeSettings: async (next) => {
        settings = next;
        return settings;
      },
      activity: { read: async () => activity },
      harnesses: {
        describe: async (id) => ({ id, name: "Claude Code", icon: "data:image/png;base64,AAAA" }),
      },
      windows: {
        available: true,
        open: async ({ url }) => {
          windowUrl = url;
        },
        close: async () => undefined,
        showHost: async (route) => {
          opened = route;
        },
      },
      handle: (method, handler) => handlers.set(method, handler),
    }),
  );
  await expect.poll(() => windowUrl).toBeTruthy();
  expect(await (await fetch(new URL("harness?id=claude-code", windowUrl))).json()).toMatchObject({
    id: "claude-code",
    name: "Claude Code",
  });
  expect((await fetch(new URL("harness?id=unobserved", windowUrl))).status).toBe(404);
  const action = (input) =>
    fetch(new URL("action", windowUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  expect((await action({ type: "open", threadId: "task#1" })).status).toBe(204);
  expect(opened).toBe("/?session=task%231");
  expect((await action({ type: "open", threadId: "missing" })).status).toBe(500);
  activity = {
    ...activity,
    revision: 2,
    notifications: [
      ...activity.notifications,
      { threadId: "task#1", key: "later", kind: "approval", revision: 2 },
    ],
  };
  await expect.poll(() => handlers.get("status")().activity.revision, { timeout: 4000 }).toBe(2);
  expect((await action({ type: "acknowledge", epoch: "actions", revision: 1 })).status).toBe(204);
  const state = await (await fetch(new URL("state", windowUrl))).json();
  expect(state.activity.notifications).toMatchObject([{ key: "later" }]);
  expect(state.activity.waiting).toBe(1);
  expect(
    (
      await action({
        type: "configure",
        values: { hoverExpand: false, lockPosition: true, showStatus: false },
      })
    ).status,
  ).toBe(204);
  expect(settings).toMatchObject({ hoverExpand: false, lockPosition: true, showStatus: false });
  expect((await action({ type: "configure", values: { selectedKey: "unknown" } })).status).toBe(
    500,
  );
  expect((await action({ type: "hide" })).status).toBe(204);
  expect(settings.desktopVisible).toBe(false);
});

it("adopts market data, retains license details and keeps the installed library available offline", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pet-backend-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const handlers = new Map();
  let settings = {};
  const context = {
    extensionDir: path.resolve("extensions/pet-companion"),
    dataDir: directory,
    readSettings: async () => settings,
    writeSettings: async (next) => {
      settings = next;
      return settings;
    },
    activity: {
      read: async () => ({ epoch: "test", revision: 1, running: 1, waiting: 0, notifications: [] }),
    },
    windows: { available: false, close: async () => undefined },
    handle: (method, handler) => handlers.set(method, handler),
  };
  const row = {
    id: "sample",
    displayName: "Sample",
    spritesheetUrl: "https://codex-pets.net/atlas.webp",
    downloadUrl: "/api/pets/sample/download",
    previewUrl: "/preview.webp",
  };
  const largePreview = Buffer.concat([image(), Buffer.alloc(1800 * 1024)]);
  vi.stubGlobal("fetch", async (url) => {
    if (String(url).endsWith("/download")) return new Response(archive());
    if (String(url).endsWith("/preview.webp")) return new Response(largePreview);
    return Response.json({ pets: [row], total: 1, totalPages: 1 });
  });
  cleanup.push(await activate(context));
  expect(handlers.get("status")().selected).toMatchObject({ key: DEFAULT_PET_KEY, builtin: true });
  await expect(handlers.get("remove")({ key: DEFAULT_PET_KEY })).rejects.toThrow(
    "cannot be removed",
  );
  await handlers.get("search")({ market: "codex-pets" });
  const preview = await handlers.get("preview")({ key: "codex-pets:sample" });
  expect(preview).toMatchObject({ total: largePreview.length, mime: "image/png", atlas: true });
  expect(Buffer.from(preview.data, "base64").length).toBe(512 * 1024);
  expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThan(800_000);
  const job = handlers.get("install")({ key: "codex-pets:sample" });
  expect(job.state).toBe("working");
  await expect.poll(() => handlers.get("status")().job.state).toBe("complete");
  const installed = handlers.get("status")();
  expect(installed).toMatchObject({
    selected: { key: "codex-pets:sample" },
    activity: { running: 1 },
    capabilities: { windows: false },
  });
  expect(installed.selected).not.toHaveProperty("manifest");
  expect(installed.selected).not.toHaveProperty("licenses");
  expect(handlers.get("details")({ key: "codex-pets:sample" }).licenses).toEqual([
    { name: "LICENSE.txt", text: "Test creator permission" },
  ]);
  vi.stubGlobal("fetch", async () => {
    throw new Error("offline");
  });
  expect((await handlers.get("sprite")({ key: "codex-pets:sample" })).data).toBe(
    image().toString("base64"),
  );
  await handlers.get("configure")({ desktopVisible: false, size: 240 });
  expect(settings).toMatchObject({
    selectedKey: "codex-pets:sample",
    desktopVisible: false,
    size: 240,
  });
  await cleanup.pop()();
  cleanup.push(await activate(context));
  expect(handlers.get("status")().selected.key).toBe("codex-pets:sample");
  await handlers.get("remove")({ key: "codex-pets:sample" });
  expect(handlers.get("status")()).toMatchObject({
    selected: { key: DEFAULT_PET_KEY },
    pets: [{ key: DEFAULT_PET_KEY }],
  });
  await handlers.get("configure")({ selectedKey: "" });
  expect(settings.selectedKey).toBe(DEFAULT_PET_KEY);
});
