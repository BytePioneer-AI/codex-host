import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open } from "node:fs/promises";

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export interface ArtifactSource {
  url: string;
  sha256: string;
  size?: number;
}

export interface ArtifactDownloadProgress {
  downloadedBytes: number;
  totalBytes: number | undefined;
}

export interface ArtifactDownloadResult {
  bytes: number;
  finalUrl: string;
}

export type ArtifactDownloader = (
  source: ArtifactSource,
  destination: string,
  onProgress?: (progress: ArtifactDownloadProgress) => void | Promise<void>,
) => Promise<ArtifactDownloadResult>;

export function validateArtifact(source: ArtifactSource): ArtifactSource {
  const url = new URL(source.url);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("update artifact URL must use HTTPS without credentials");
  }
  if (!SHA256_PATTERN.test(source.sha256)) {
    throw new Error("update artifact SHA-256 must be lowercase hexadecimal");
  }
  if (
    source.size !== undefined &&
    (!Number.isSafeInteger(source.size) || source.size <= 0 || source.size > MAX_ARTIFACT_BYTES)
  ) {
    throw new Error(`update artifact size must be between 1 and ${MAX_ARTIFACT_BYTES} bytes`);
  }
  return source;
}

async function writeChunk(
  file: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await file.write(chunk, offset, chunk.byteLength - offset, null);
    if (result.bytesWritten === 0) throw new Error("update artifact write made no progress");
    offset += result.bytesWritten;
  }
}

export async function downloadArtifact(
  source: ArtifactSource,
  destination: string,
  onProgress?: (progress: ArtifactDownloadProgress) => void | Promise<void>,
): Promise<ArtifactDownloadResult> {
  const response = await fetch(source.url, {
    redirect: "follow",
    headers: { "accept-encoding": "identity" },
  });
  if (!response.ok || response.body === null) {
    throw new Error(`update artifact download failed with HTTP ${response.status}`);
  }
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:" || finalUrl.username || finalUrl.password) {
    throw new Error("update artifact redirected to a non-HTTPS URL");
  }
  const file = await open(destination, "wx", 0o600);
  let bytes = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_ARTIFACT_BYTES) {
        await reader.cancel();
        throw new Error(`update artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
      }
      await writeChunk(file, item.value);
      await onProgress?.({ downloadedBytes: bytes, totalBytes: source.size });
    }
    await file.sync();
  } finally {
    await file.close();
  }
  return { bytes, finalUrl: finalUrl.toString() };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

export async function verifyDownloadedArtifact(
  source: ArtifactSource,
  filePath: string,
  result: ArtifactDownloadResult,
): Promise<void> {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) {
    throw new Error("downloaded update artifact is not a non-empty regular file");
  }
  if (metadata.size !== result.bytes) {
    throw new Error("downloaded update artifact size changed after download");
  }
  if (source.size !== undefined && metadata.size !== source.size) {
    throw new Error(`update artifact size mismatch: expected ${source.size}, got ${metadata.size}`);
  }
  const actual = await sha256File(filePath);
  if (actual !== source.sha256) {
    throw new Error(`update artifact SHA-256 mismatch: expected ${source.sha256}, got ${actual}`);
  }
}
