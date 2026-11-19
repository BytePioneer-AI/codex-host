const MAX_EDGE = 2048;
const MAX_UNCOMPRESSED_BYTES = 1024 * 1024;

/** Prepare camera photos for upload; unsupported or unsuccessful conversions retain the original. */
export async function preparePhoto(file: File): Promise<File> {
  if (file.type !== "image/jpeg" && file.type !== "image/webp") return file;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const edge = Math.max(bitmap.width, bitmap.height);
    if (edge <= MAX_EDGE && file.size <= MAX_UNCOMPRESSED_BYTES) return file;
    const scale = Math.min(1, MAX_EDGE / edge);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    let blob: Blob | null;
    if (
      typeof OffscreenCanvas === "function" &&
      typeof OffscreenCanvas.prototype.convertToBlob === "function"
    ) {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (context === null) return file;
      context.drawImage(bitmap, 0, 0, width, height);
      blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (context === null) return file;
      context.drawImage(bitmap, 0, 0, width, height);
      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.85),
      );
    }
    if (blob === null || blob.type !== "image/jpeg" || blob.size === 0 || blob.size >= file.size)
      return file;
    const name = file.name === "" ? "" : `${file.name.replace(/\.[^.]*$/u, "")}.jpg`;
    return new File([blob], name, { type: "image/jpeg", lastModified: file.lastModified });
  } catch {
    return file;
  } finally {
    bitmap?.close();
  }
}
