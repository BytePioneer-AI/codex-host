import { afterEach, describe, expect, it, vi } from "vitest";
import { isPreparablePhotoType, preparePhoto } from "../src/client/prepare-photo.ts";

interface CanvasCall {
  readonly width: number;
  readonly height: number;
  readonly type: string;
  readonly quality: number | undefined;
}

function installCanvasEnvironment(options: {
  readonly bitmapWidth: number;
  readonly bitmapHeight: number;
  readonly encode: (call: CanvasCall) => Blob | null | Promise<Blob | null>;
}) {
  const close = vi.fn();
  const drawImage = vi.fn();
  const calls: CanvasCall[] = [];

  const createImageBitmapMock = vi.fn(async () => ({
    width: options.bitmapWidth,
    height: options.bitmapHeight,
    close,
  }));

  class FakeOffscreenCanvas {
    constructor(
      public readonly width: number,
      public readonly height: number,
    ) {}

    getContext(kind: string) {
      return kind === "2d" ? { drawImage } : null;
    }

    async convertToBlob(opts?: { type?: string; quality?: number }): Promise<Blob> {
      const call: CanvasCall = {
        width: this.width,
        height: this.height,
        type: opts?.type ?? "image/png",
        quality: opts?.quality,
      };
      calls.push(call);
      const blob = await options.encode(call);
      if (blob === null) throw new Error("encode failed");
      return blob;
    }
  }

  vi.stubGlobal("createImageBitmap", createImageBitmapMock);
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  return { close, drawImage, calls, createImageBitmapMock };
}

function makeFile(name: string, type: string, bytes: number, lastModified = 1_700_000_000_000) {
  return new File([new Uint8Array(bytes)], name, { type, lastModified });
}

describe("preparePhoto", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("recognizes jpeg, webp, and png while leaving gif and non-images untouched", async () => {
    expect(isPreparablePhotoType("image/png")).toBe(true);
    expect(isPreparablePhotoType("image/jpeg")).toBe(true);
    expect(isPreparablePhotoType("image/webp")).toBe(true);
    expect(isPreparablePhotoType("image/gif")).toBe(false);
    expect(isPreparablePhotoType("application/pdf")).toBe(false);

    const env = installCanvasEnvironment({
      bitmapWidth: 4000,
      bitmapHeight: 3000,
      encode: () => new Blob([new Uint8Array(100)], { type: "image/webp" }),
    });
    const gif = makeFile("anim.gif", "image/gif", 2 * 1024 * 1024);
    expect(await preparePhoto(gif)).toBe(gif);
    expect(env.createImageBitmapMock).not.toHaveBeenCalled();
  });

  it("keeps small and normal-sized PNG screenshots untouched", async () => {
    const env = installCanvasEnvironment({
      bitmapWidth: 1600,
      bitmapHeight: 1200,
      encode: () => new Blob([new Uint8Array(100)], { type: "image/webp" }),
    });
    const smallPng = makeFile("small.png", "image/png", 512 * 1024);
    const result = await preparePhoto(smallPng);
    expect(result).toBe(smallPng);
    expect(env.calls).toEqual([]);
    expect(env.close).toHaveBeenCalledTimes(1);
  });

  it("scales large Retina PNG screenshots to max 2048px and encodes to high-clarity WebP", async () => {
    const env = installCanvasEnvironment({
      bitmapWidth: 3024,
      bitmapHeight: 1964,
      encode: ({ type }) => new Blob([new Uint8Array(240 * 1024)], { type }),
    });
    const retinaPng = makeFile("Screenshot 2026.png", "image/png", 4 * 1024 * 1024, 123456);
    const result = await preparePhoto(retinaPng);

    expect(result).not.toBe(retinaPng);
    expect(result.type).toBe("image/webp");
    expect(result.name).toBe("Screenshot 2026.webp");
    expect(result.size).toBe(240 * 1024);
    expect(result.lastModified).toBe(123456);
    expect(env.calls).toEqual([
      {
        width: 2048,
        height: Math.round(1964 * (2048 / 3024)),
        type: "image/webp",
        quality: 0.9,
      },
    ]);
    expect(env.close).toHaveBeenCalledTimes(1);
  });

  it("compresses PNGs over 1 MiB even when dimensions are within 2048px", async () => {
    const env = installCanvasEnvironment({
      bitmapWidth: 1800,
      bitmapHeight: 1200,
      encode: ({ type }) => new Blob([new Uint8Array(300 * 1024)], { type }),
    });
    const heavyPng = makeFile("dense.png", "image/png", 1_500_000);
    const result = await preparePhoto(heavyPng);

    expect(result.type).toBe("image/webp");
    expect(result.name).toBe("dense.webp");
    expect(result.size).toBe(300 * 1024);
    expect(env.calls[0]).toMatchObject({
      width: 1800,
      height: 1200,
      type: "image/webp",
      quality: 0.9,
    });
  });

  it("falls back to scaled PNG when WebP encoding is unsupported and scaled PNG is smaller", async () => {
    const env = installCanvasEnvironment({
      bitmapWidth: 4096,
      bitmapHeight: 2048,
      encode: () => new Blob([new Uint8Array(900 * 1024)], { type: "image/png" }),
    });
    const hugePng = makeFile("retina.png", "image/png", 3 * 1024 * 1024, 9876);
    const result = await preparePhoto(hugePng);

    expect(result).not.toBe(hugePng);
    expect(result.type).toBe("image/png");
    expect(result.name).toBe("retina.png");
    expect(result.size).toBe(900 * 1024);
    expect(result.lastModified).toBe(9876);
    expect(env.calls).toHaveLength(1);
    expect(env.calls[0]).toMatchObject({ width: 2048, height: 1024, type: "image/webp" });
  });

  it("retains the original PNG when converted output is not smaller or encoding fails", async () => {
    installCanvasEnvironment({
      bitmapWidth: 2560,
      bitmapHeight: 1440,
      encode: ({ type }) => new Blob([new Uint8Array(2 * 1024 * 1024)], { type }),
    });
    const png = makeFile("already-compact.png", "image/png", 1_500_000);
    expect(await preparePhoto(png)).toBe(png);

    installCanvasEnvironment({
      bitmapWidth: 2560,
      bitmapHeight: 1440,
      encode: () => null,
    });
    expect(await preparePhoto(png)).toBe(png);
  });

  it("preserves existing JPEG compression behavior for large JPEG photos", async () => {
    const env = installCanvasEnvironment({
      bitmapWidth: 4000,
      bitmapHeight: 3000,
      encode: ({ type }) => new Blob([new Uint8Array(200 * 1024)], { type }),
    });
    const photo = makeFile("camera.jpeg", "image/jpeg", 3 * 1024 * 1024);
    const result = await preparePhoto(photo);

    expect(result.type).toBe("image/jpeg");
    expect(result.name).toBe("camera.jpg");
    expect(result.size).toBe(200 * 1024);
    expect(env.calls).toEqual([{ width: 2048, height: 1536, type: "image/jpeg", quality: 0.85 }]);
  });
});
