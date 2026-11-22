/** `/D:/`-style drive prefixes in image paths resolve like the plain Windows path. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readImageFile } from "../../packages/web-server/src/web-images.ts";

/** A 1×1 PNG. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "web-image-drive-prefix-"));
  await writeFile(join(directory, "pixel.png"), PIXEL);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("reads the image through the plain absolute path", () => {
  expect(readImageFile(join(directory, "pixel.png"))).toEqual(PIXEL);
});

it.runIf(process.platform === "win32")(
  "reads a Windows absolute path written with the `/D:/`-style prefix harness links carry",
  () => {
    const prefixed = `/${join(directory, "pixel.png").replaceAll("\\", "/")}`;
    expect(readImageFile(prefixed)).toEqual(PIXEL);
  },
);

it("still refuses a relative path", () => {
  expect(() => readImageFile("pixel.png")).toThrow();
});
