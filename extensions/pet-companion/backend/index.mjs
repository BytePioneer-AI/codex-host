import { randomUUID } from "node:crypto";
import { createLibrary } from "./library.mjs";
import { markets, searchMarket } from "./markets.mjs";
import { download } from "./network.mjs";
import { imageInfo } from "./archive.mjs";
import { createWindowServer } from "./window-server.mjs";
import { DEFAULT_PET_KEY } from "./builtin.mjs";

const EMPTY_ACTIVITY = {
  epoch: "",
  revision: 0,
  running: 0,
  waiting: 0,
  sessions: [],
  notifications: [],
};
const defaults = {
  selectedKey: DEFAULT_PET_KEY,
  desktopVisible: true,
  faviconNotifications: true,
  hoverExpand: true,
  showStatus: true,
  lockPosition: false,
  size: 192,
};

export async function activate(ctx) {
  if (!ctx.activity)
    throw new Error("Update CodexHost to a version with extension activity services");
  const library = await createLibrary(ctx.dataDir);
  const controller = new AbortController();
  const catalog = new Map();
  const previews = new Map();
  let values = { ...defaults, ...(await ctx.readSettings()) };
  let activity = EMPTY_ACTIVITY;
  let job = null;
  let mutation = Promise.resolve();
  let windowError = "";
  let windowAttempt = 0;
  let refreshing;
  let timer;
  let nativeSeen = { epoch: "", revision: 0 };
  let closed = false;
  const selected = () => library.get(values.selectedKey) ?? library.get(DEFAULT_PET_KEY);
  const describe = (pet) => {
    if (!pet) return null;
    const { manifest, licenses, ...publicPet } = pet;
    return publicPet;
  };
  const nativeActivity = () => ({
    ...activity,
    notifications: activity.notifications.filter(
      (item) => nativeSeen.epoch !== activity.epoch || item.revision > nativeSeen.revision,
    ),
  });
  const snapshot = () => ({
    pets: library.list().map(describe),
    selected: describe(selected()),
    settings: values,
    activity,
    job,
    windowError,
    capabilities: { activity: true, windows: ctx.windows?.available === true },
  });
  const serialize = (run) => {
    const result = mutation.then(run);
    mutation = result.catch(() => undefined);
    return result;
  };
  const configure = (change) =>
    serialize(async () => {
      const current = await ctx.readSettings();
      const next = { ...defaults, ...current };
      if (Object.hasOwn(change, "selectedKey")) {
        if (change.selectedKey !== "" && !library.get(change.selectedKey))
          throw new Error("Pet is not installed");
        next.selectedKey = change.selectedKey || DEFAULT_PET_KEY;
      }
      for (const key of [
        "desktopVisible",
        "faviconNotifications",
        "hoverExpand",
        "showStatus",
        "lockPosition",
      ]) {
        if (Object.hasOwn(change, key)) {
          if (typeof change[key] !== "boolean") throw new Error("Invalid setting");
          next[key] = change[key];
        }
      }
      if (Object.hasOwn(change, "size")) {
        if (!Number.isInteger(change.size) || change.size < 120 || change.size > 260)
          throw new Error("Pet size must be between 120 and 260");
        next.size = change.size;
      }
      values = await ctx.writeSettings(next);
      return snapshot();
    });
  const windowServer = await createWindowServer({
    extensionDir: ctx.extensionDir,
    state: () => ({ selected: describe(selected()), settings: values, activity: nativeActivity() }),
    sprite: async () =>
      selected() ? { mime: selected().mime, bytes: await library.sprite(selected().key) } : null,
    harness: async (id) => {
      if (!(activity.sessions ?? []).some((session) => session.harness?.id === id)) return null;
      return (await ctx.harnesses?.describe(id)) ?? null;
    },
    action: async (input) => {
      if (input.type === "acknowledge") {
        if (
          input.epoch !== activity.epoch ||
          !Number.isInteger(input.revision) ||
          input.revision < 0 ||
          input.revision > activity.revision
        )
          throw new Error("Notification state changed; refresh before acknowledging");
        nativeSeen = {
          epoch: input.epoch,
          revision: Math.max(
            nativeSeen.epoch === input.epoch ? nativeSeen.revision : 0,
            input.revision,
          ),
        };
      } else if (input.type === "configure") {
        if (
          !input.values ||
          typeof input.values !== "object" ||
          Array.isArray(input.values) ||
          Object.keys(input.values).some(
            (key) => !["size", "hoverExpand", "showStatus", "lockPosition"].includes(key),
          )
        )
          throw new Error("Invalid window preferences");
        await configure(input.values);
      } else if (input.type === "hide") {
        await configure({ desktopVisible: false });
        await ctx.windows?.close();
      } else if (input.type === "open") {
        if (
          input.threadId !== undefined &&
          !(activity.sessions ?? []).some((item) => item.threadId === input.threadId)
        )
          throw new Error("This session is no longer in the task summary");
        if (!ctx.windows?.showHost) throw new Error("Update CodexHost to open its main window");
        await ctx.windows.showHost(
          input.threadId === undefined ? "/" : `/?session=${encodeURIComponent(input.threadId)}`,
        );
      } else throw new Error("Unknown window action");
    },
  });
  const refresh = () =>
    (refreshing ??= (async () => {
      values = { ...defaults, ...(await ctx.readSettings()) };
      activity = await ctx.activity.read();
      if (closed) return;
      if (!values.desktopVisible || !selected()) {
        await ctx.windows?.close();
        windowError = "";
      } else if (ctx.windows?.available && Date.now() >= windowAttempt) {
        windowAttempt = Date.now() + 30_000;
        try {
          await ctx.windows.open({ url: windowServer.url, width: 640, height: 500 });
          windowError = "";
        } catch (error) {
          windowError =
            error instanceof Error ? error.message.slice(0, 240) : "Could not open native window";
        }
      }
    })().finally(() => {
      refreshing = undefined;
      if (!closed)
        timer = setTimeout(() => {
          void refresh().catch(() => undefined);
        }, 1500);
    }));

  ctx.handle("status", () => snapshot());
  ctx.handle("acknowledge", () => {
    nativeSeen = { epoch: activity.epoch, revision: activity.revision };
    return null;
  });
  ctx.handle("details", ({ key } = {}) => {
    const pet = library.get(key);
    if (!pet) throw new Error("Pet is not installed");
    return { manifest: pet.manifest, licenses: pet.licenses };
  });
  ctx.handle("configure", async (change) => {
    if (!change || typeof change !== "object" || Array.isArray(change))
      throw new Error("Invalid settings");
    const result = await configure(change);
    windowAttempt = 0;
    clearTimeout(timer);
    void refresh().catch(() => undefined);
    return result;
  });
  ctx.handle("markets", () => markets);
  ctx.handle("search", async (input) => {
    const result = await searchMarket(input ?? {}, controller.signal);
    for (const pet of result.pets) {
      catalog.set(pet.key, pet);
      if (catalog.size > 240) catalog.delete(catalog.keys().next().value);
    }
    return result;
  });
  ctx.handle("preview", async ({ key, offset = 0 } = {}) => {
    const pet = catalog.get(key) ?? library.get(key);
    if (!pet) return null;
    if (!Number.isInteger(offset) || offset < 0 || offset > 8 * 1024 * 1024)
      throw new Error("Invalid preview request");
    try {
      let preview = previews.get(key);
      if (!preview) {
        const bytes = await download(pet.previewUrl, {
          limit: 8 * 1024 * 1024,
          signal: controller.signal,
        });
        const info = imageInfo(bytes);
        if (info.width * info.height > 5_000_000)
          throw new Error("Preview dimensions exceed limit");
        preview = { bytes, ...info };
        previews.set(key, preview);
        if (previews.size > 16) previews.delete(previews.keys().next().value);
      }
      return {
        data: preview.bytes.subarray(offset, offset + 512 * 1024).toString("base64"),
        total: preview.bytes.length,
        mime: preview.mime,
        atlas: preview.width === 1536 && [1872, 2288].includes(preview.height),
      };
    } catch {
      return null;
    }
  });
  ctx.handle("install", ({ key } = {}) => {
    if (job?.state === "working") throw new Error("A pet download is already running");
    const pet = catalog.get(key);
    if (!pet) throw new Error("Refresh the market listing before downloading");
    const current = (job = { id: randomUUID(), key, state: "working", error: "" });
    void (async () => {
      const zip = await download(pet.downloadUrl, {
        limit: 16 * 1024 * 1024,
        signal: controller.signal,
        timeoutMs: 30_000,
      });
      if (closed) return;
      await serialize(() => library.install(pet, zip));
      if (closed) return;
      await configure({ selectedKey: key });
      current.state = "complete";
      windowAttempt = 0;
    })().catch((error) => {
      current.state = "failed";
      current.error = error instanceof Error ? error.message.slice(0, 240) : "Download failed";
    });
    return current;
  });
  ctx.handle("sprite", async ({ key, digest, offset = 0 } = {}) => {
    if (
      typeof key !== "string" ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 8 * 1024 * 1024
    )
      throw new Error("Invalid sprite request");
    if (digest !== undefined && digest !== library.get(key)?.digest)
      throw new Error("The pet changed while loading; try again");
    const bytes = await library.sprite(key);
    return {
      data: bytes.subarray(offset, offset + 512 * 1024).toString("base64"),
      total: bytes.length,
    };
  });
  ctx.handle("remove", async ({ key } = {}) => {
    if (job?.state === "working") throw new Error("Wait for the current download to finish");
    if (typeof key !== "string" || !library.get(key)) throw new Error("Pet is not installed");
    if (key === DEFAULT_PET_KEY) throw new Error("The built-in pet cannot be removed");
    if (values.selectedKey === key) await configure({ selectedKey: DEFAULT_PET_KEY });
    await serialize(() => library.remove(key));
    return snapshot();
  });
  void refresh().catch(() => undefined);
  return async () => {
    closed = true;
    controller.abort();
    clearTimeout(timer);
    await ctx.windows?.close();
    await windowServer.close();
  };
}
