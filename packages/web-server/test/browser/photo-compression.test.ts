import assert from "node:assert/strict";
import { resolve } from "node:path";
import { it } from "node:test";
import { build } from "esbuild";
import { chromium, type Page, type Route } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";
import { defined } from "../support/defined.ts";

type PhotoFixture = { base64: string; type: string; name: string; width: number; height: number };

/** Deterministic textured camera-like input, without personal photos or metadata. */
async function photo(
  page: Page,
  options: { width: number; height: number; type?: string; orientation?: number; padTo?: number },
): Promise<PhotoFixture> {
  const base64 = await page.evaluate(async ({ width, height, type, orientation, padTo }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas unavailable");
    const pixels = context.createImageData(width, height);
    let seed = 42;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        const noise = (seed >>> 24) % 32;
        const i = (y * width + x) * 4;
        pixels.data[i] = 40 + (x / width) * 160 + noise;
        pixels.data[i + 1] = 40 + (y / height) * 160 + noise;
        pixels.data[i + 2] = 80 + noise;
        pixels.data[i + 3] = 255;
      }
    }
    context.putImageData(pixels, 0, 0);
    context.fillStyle = "red";
    context.fillRect(0, 0, width / 4, height / 4);
    const blob = await new Promise<Blob>((done) =>
      canvas.toBlob(
        (b) => {
          if (b !== null) done(b);
        },
        type ?? "image/jpeg",
        0.95,
      ),
    );
    let bytes = new Uint8Array(await blob.arrayBuffer());
    if (orientation !== undefined) {
      // JPEG APP1: Exif, little-endian TIFF, one SHORT Orientation entry.
      const exif = new Uint8Array([
        0xff,
        0xe1,
        0,
        34,
        0x45,
        0x78,
        0x69,
        0x66,
        0,
        0,
        0x49,
        0x49,
        42,
        0,
        8,
        0,
        0,
        0,
        1,
        0,
        0x12,
        1,
        3,
        0,
        1,
        0,
        0,
        0,
        orientation,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
      ]);
      const oriented = new Uint8Array(bytes.length + exif.length);
      oriented.set(bytes.subarray(0, 2));
      oriented.set(exif, 2);
      oriented.set(bytes.subarray(2), 2 + exif.length);
      bytes = oriented;
    }
    const file = new Blob([bytes, new Uint8Array(Math.max(0, (padTo ?? 0) - bytes.length))], {
      type: blob.type,
    });
    return await new Promise<string>((done) => {
      const reader = new FileReader();
      reader.onload = () =>
        done(String(reader.result).slice(String(reader.result).indexOf(",") + 1));
      reader.readAsDataURL(file);
    });
  }, options);
  return { ...options, base64, type: options.type ?? "image/jpeg", name: "camera.original.jpeg" };
}

it(
  "real Chromium prepares photos with oriented dimensions, thresholds and silent fallbacks",
  { timeout: 60_000 },
  async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const bundle = await build({
      entryPoints: [
        resolve("apps/web-ui/packages/client/ui-conversation/src/client/prepare-photo.ts"),
      ],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "photoPreparation",
    });
    await page.addScriptTag({ content: defined(bundle.outputFiles[0]).text });
    const large = await photo(page, { width: 4000, height: 3000 });
    const portrait = await photo(page, { width: 4000, height: 3000, orientation: 6 });
    const small = await photo(page, { width: 800, height: 600, padTo: 200 * 1024 });
    const byteHeavy = await photo(page, { width: 800, height: 600, padTo: 1024 * 1024 + 1 });
    const threshold = await photo(page, { width: 2048, height: 2, padTo: 1024 * 1024 });
    const webp = {
      ...(await photo(page, { width: 3200, height: 2400, type: "image/webp" })),
      name: "camera.webp",
    };
    const longOnly = await photo(page, { width: 2049, height: 100 });
    const png = await photo(page, { width: 2500, height: 2000, type: "image/png" });
    const gif = {
      ...small,
      type: "image/gif",
      name: "animated.gif",
      width: 1,
      height: 1,
      base64: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    };
    const invalid = { ...large, base64: Buffer.alloc(1024 * 1024 + 1).toString("base64") };
    const samples = [
      { label: "4000x3000 JPEG", fixture: large, width: 2048, height: 1536, same: false },
      { label: "EXIF 6 portrait", fixture: portrait, width: 1536, height: 2048, same: false },
      { label: "800x600 small JPEG", fixture: small, width: 800, height: 600, same: true },
      {
        label: "800x600 byte-heavy JPEG",
        fixture: byteHeavy,
        width: 800,
        height: 600,
        same: false,
      },
      { label: "exact thresholds", fixture: threshold, width: 2048, height: 2, same: true },
      { label: "3200x2400 WebP", fixture: webp, width: 2048, height: 1536, same: false },
      { label: "long edge only", fixture: longOnly, width: 2048, height: 100, same: false },
      { label: "PNG", fixture: png, width: 2500, height: 2000, same: true },
      { label: "GIF", fixture: gif, width: 1, height: 1, same: true },
      { label: "decode failure", fixture: invalid, same: true },
      { label: "larger encoding", fixture: large, same: true, mode: "larger" },
      { label: "equal encoding", fixture: large, same: true, mode: "equal" },
      { label: "encoding failure", fixture: large, same: true, mode: "throw" },
      {
        label: "canvas fallback",
        fixture: large,
        width: 2048,
        height: 1536,
        same: false,
        mode: "canvas",
      },
      { label: "canvas null encoding", fixture: large, same: true, mode: "null" },
    ];
    for (const sample of samples) {
      const result = await page.evaluate(
        async ({ fixture, mode }) => {
          const api = (
            window as unknown as { photoPreparation: { preparePhoto(file: File): Promise<File> } }
          ).photoPreparation;
          const file = new File(
            [Uint8Array.from(atob(fixture.base64), (c) => c.charCodeAt(0))],
            fixture.name,
            { type: fixture.type },
          );
          const offscreen = globalThis.OffscreenCanvas;
          const convert = offscreen.prototype.convertToBlob;
          const toBlob = HTMLCanvasElement.prototype.toBlob;
          let encoding: { type?: string | undefined; quality?: number | undefined } | undefined;
          offscreen.prototype.convertToBlob = async function (options) {
            encoding = options;
            if (mode === "throw") throw new Error("encoder unavailable");
            if (mode === "larger" || mode === "equal")
              return new Blob([new Uint8Array(file.size + (mode === "larger" ? 1 : 0))], {
                type: "image/jpeg",
              });
            return await convert.call(this, options);
          };
          if (mode === "canvas" || mode === "null") {
            Object.defineProperty(globalThis, "OffscreenCanvas", {
              configurable: true,
              value: undefined,
            });
            HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
              encoding = { type, quality };
              if (mode === "null") callback(null);
              else toBlob.call(this, callback, type, quality);
            };
          }
          const started = performance.now();
          const output = await api.preparePhoto(file);
          const ms = performance.now() - started;
          offscreen.prototype.convertToBlob = convert;
          Object.defineProperty(globalThis, "OffscreenCanvas", {
            configurable: true,
            value: offscreen,
          });
          HTMLCanvasElement.prototype.toBlob = toBlob;
          let width: number | undefined, height: number | undefined, topRight: number[] | undefined;
          try {
            const bitmap = await createImageBitmap(output);
            width = bitmap.width;
            height = bitmap.height;
            const canvas = new OffscreenCanvas(width, height);
            const context = canvas.getContext("2d");
            if (context === null) throw new Error("Canvas unavailable");
            context.drawImage(bitmap, 0, 0);
            topRight = [...context.getImageData(width - 10, 10, 1, 1).data];
            bitmap.close();
          } catch {
            /* Deliberately invalid decode fixture. */
          }
          return {
            before: file.size,
            after: output.size,
            width,
            height,
            ms,
            same: output === file,
            type: output.type,
            name: output.name,
            encoding,
            topRight,
          };
        },
        { fixture: sample.fixture, mode: sample.mode },
      );
      assert.equal(result.same, sample.same, sample.label);
      if (sample.width !== undefined)
        assert.deepEqual(
          [result.width, result.height],
          [sample.width, sample.height],
          sample.label,
        );
      if (!sample.same) {
        assert.ok(result.after < result.before, sample.label);
        assert.equal(result.type, "image/jpeg");
        assert.equal(result.name, sample.fixture.name.replace(/\.[^.]*$/u, ".jpg"));
        assert.deepEqual(result.encoding, { type: "image/jpeg", quality: 0.85 });
      }
      if (sample.label === "EXIF 6 portrait") {
        assert.ok(
          result.topRight && defined(result.topRight[0]) > 240 && defined(result.topRight[1]) < 20,
          "rotation moves the red top-left patch to top-right",
        );
      }
      t.diagnostic(
        `${sample.label}: ${result.before} -> ${result.after} bytes, ${sample.fixture.width}x${sample.fixture.height} -> ${result.width ?? "?"}x${result.height ?? "?"}, ${result.ms.toFixed(1)} ms`,
      );
    }
  },
);

it(
  "photo uploads declare JPEG and manual/foreground retries reuse encoded bytes",
  { timeout: 60_000 },
  async (t) => {
    const host = new FakeChHost();
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--session-source",
        "codexhost",
        "--ch-cdp",
        debug.endpoint,
        "--adapters",
        "test/fake-harness",
      ],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const context = await browser.newContext({
      viewport: { width: 390, height: 900 },
      isMobile: true,
      hasTouch: true,
    });
    await context.addInitScript(() => {
      const convert = OffscreenCanvas.prototype.convertToBlob;
      const counts = { encodes: 0 };
      (window as unknown as { photoCounts: typeof counts }).photoCounts = counts;
      OffscreenCanvas.prototype.convertToBlob = function (options) {
        counts.encodes++;
        return convert.call(this, options);
      };
    });
    const held: Route[] = [];
    await context.route("**/api/session/uploadFileBinary?*", (route) => {
      held.push(route);
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.getByText("Native Model", { exact: true }).waitFor();
    const fixture = await photo(page, { width: 4000, height: 3000, type: "image/webp" });
    // Ignore the fixture encoder, count only preparation after the actual file chooser.
    await page.evaluate(() => {
      (window as unknown as { photoCounts: { encodes: number } }).photoCounts.encodes = 0;
    });
    await page.locator("[data-composer-input]:visible").pressSequentially("/");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("option", { name: /^File\b/u }).click();
    const original = Buffer.from(fixture.base64, "base64");
    await (await chooser).setFiles({ name: "trip.webp", mimeType: "image/webp", buffer: original });
    const pending = page.getByRole("group", { name: "Pending attachments", exact: true });
    await pending.locator("img").waitFor();
    const waitForUpload = async (count: number) => {
      for (let i = 0; held.length < count && i < 500; i++) await page.waitForTimeout(10);
      assert.equal(held.length, count);
      const route = defined(held[count - 1]);
      const query = new URL(route.request().url()).searchParams;
      assert.equal(query.get("name"), "trip.jpg");
      assert.equal(query.get("imageMediaType"), "image/jpeg");
      return route;
    };
    const first = await waitForUpload(1);
    const bytes = defined(first.request().postDataBuffer());
    assert.ok(bytes.length < original.length);
    assert.equal(bytes.subarray(0, 2).toString("hex"), "ffd8");
    const retry = pending.getByRole("button", { name: "Retry uploading trip.webp", exact: true });
    await first.abort("failed");
    await retry.waitFor();
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    const second = await waitForUpload(2);
    assert.deepEqual(second.request().postDataBuffer(), bytes);
    await second.abort("failed");
    await retry.waitFor();
    await retry.click();
    const third = await waitForUpload(3);
    assert.deepEqual(third.request().postDataBuffer(), bytes);
    const response = page.waitForResponse((reply) => reply.url().includes("uploadFileBinary"));
    await third.continue();
    assert.equal((await response).status(), 200);
    await pending.getByRole("status").waitFor({ state: "detached" });
    assert.equal(
      await page.evaluate(
        () => (window as unknown as { photoCounts: { encodes: number } }).photoCounts.encodes,
      ),
      1,
    );
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.locator("[data-submission-echo]").waitFor({ state: "detached" });
    await page.locator("[data-message-attachments] img").waitFor();
    assert.equal(host.requests.filter((request) => request.method === "turn/start").length, 1);

    // A failed browser decode must still reach the normal upload transport unchanged.
    await page.locator("[data-composer-input]:visible").pressSequentially("/");
    const invalidChooser = page.waitForEvent("filechooser");
    await page.getByRole("option", { name: /^File\b/u }).click();
    const invalid = Buffer.alloc(1024 * 1024 + 1);
    await (
      await invalidChooser
    ).setFiles({
      name: "broken.jpeg",
      mimeType: "image/jpeg",
      buffer: invalid,
    });
    for (let i = 0; held.length < 4 && i < 500; i++) await page.waitForTimeout(10);
    assert.equal(held.length, 4);
    const fallback = defined(held[3]);
    const fallbackQuery = new URL(fallback.request().url()).searchParams;
    assert.equal(fallbackQuery.get("name"), "broken.jpeg");
    assert.equal(fallbackQuery.get("imageMediaType"), "image/jpeg");
    assert.deepEqual(fallback.request().postDataBuffer(), invalid);
    await fallback.continue();
    await pending
      .getByRole("button", { name: "Retry uploading broken.jpeg", exact: true })
      .waitFor();
    assert.deepEqual(errors, []);
  },
);
