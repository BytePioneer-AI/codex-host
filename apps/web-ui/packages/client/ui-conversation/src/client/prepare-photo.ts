const MAX_EDGE = 2048;
const MAX_UNCOMPRESSED_BYTES = 1024 * 1024;
const JPEG_QUALITY = 0.85;
const PNG_WEBP_QUALITY = 0.9;

type CanvasSurface = OffscreenCanvas | HTMLCanvasElement;

/** Whether a raster image MIME type participates in client-side upload compression. */
export function isPreparablePhotoType(type: string): boolean {
  return type === "image/jpeg" || type === "image/webp" || type === "image/png";
}

function replaceExtension(name: string, extension: string): string {
  return name === "" ? "" : `${name.replace(/\.[^.]*$/u, "")}${extension}`;
}

function renderToCanvas(bitmap: ImageBitmap, width: number, height: number): CanvasSurface | null {
  if (
    typeof OffscreenCanvas === "function" &&
    typeof OffscreenCanvas.prototype.convertToBlob === "function"
  ) {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (context === null) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    return canvas;
  }
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) return null;
  context.drawImage(bitmap, 0, 0, width, height);
  return canvas;
}

async function encodeCanvas(
  canvas: CanvasSurface,
  type: string,
  quality?: number,
): Promise<Blob | null> {
  try {
    if ("convertToBlob" in canvas && typeof canvas.convertToBlob === "function") {
      return await canvas.convertToBlob(quality === undefined ? { type } : { type, quality });
    }
    const htmlCanvas = canvas as HTMLCanvasElement;
    return await new Promise<Blob | null>((resolve) => htmlCanvas.toBlob(resolve, type, quality));
  } catch {
    return null;
  }
}

/**
 * Prepare camera photos and large PNG screenshots for upload; unsupported,
 * non-shrinking, or unsuccessful conversions retain the original file.
 */
export async function preparePhoto(file: File): Promise<File> {
  if (!isPreparablePhotoType(file.type)) return file;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const edge = Math.max(bitmap.width, bitmap.height);
    if (edge <= MAX_EDGE && file.size <= MAX_UNCOMPRESSED_BYTES) return file;
    const scale = Math.min(1, MAX_EDGE / edge);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = renderToCanvas(bitmap, width, height);
    if (canvas === null) return file;

    if (file.type === "image/png") {
      const webp = await encodeCanvas(canvas, "image/webp", PNG_WEBP_QUALITY);
      if (webp !== null && webp.type === "image/webp") {
        if (webp.size === 0 || webp.size >= file.size) return file;
        return new File([webp], replaceExtension(file.name, ".webp"), {
          type: "image/webp",
          lastModified: file.lastModified,
        });
      }
      if (scale < 1) {
        const png =
          webp !== null && webp.type === "image/png"
            ? webp
            : await encodeCanvas(canvas, "image/png");
        if (png !== null && png.type === "image/png" && png.size > 0 && png.size < file.size) {
          return new File([png], file.name, {
            type: "image/png",
            lastModified: file.lastModified,
          });
        }
      }
      return file;
    }

    const blob = await encodeCanvas(canvas, "image/jpeg", JPEG_QUALITY);
    if (blob === null || blob.type !== "image/jpeg" || blob.size === 0 || blob.size >= file.size)
      return file;
    return new File([blob], replaceExtension(file.name, ".jpg"), {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    bitmap?.close();
  }
}
