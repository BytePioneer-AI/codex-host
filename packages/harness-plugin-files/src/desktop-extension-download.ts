import {
  desktopExtensionHttpUrlSchema,
  isGitHubDesktopExtensionZipballUrl,
} from "@codexhost/shared-contracts";

const githubHeaders = {
  accept: "application/vnd.github+json",
  "user-agent": "codexhost-desktop-extensions",
};

class ExtensionDownloadError extends Error {}

export class ExtensionHttpError extends ExtensionDownloadError {
  constructor(readonly status: number) {
    super(`Download returned HTTP ${status}`);
  }
}

export async function downloadExtensionBytes(
  url: string,
  limit: number,
  headers: Record<string, string> | undefined,
  { signal: callerSignal, allowUrl }: { signal?: AbortSignal; allowUrl: (url: URL) => boolean },
) {
  const parsed = desktopExtensionHttpUrlSchema.safeParse(url);
  if (!parsed.success) throw new ExtensionDownloadError("Expected a credential-free HTTP(S) URL");
  try {
    let target = new URL(parsed.data);
    if (isGitHubDesktopExtensionZipballUrl(target)) headers ??= githubHeaders;
    const timeout = AbortSignal.timeout(12_000);
    const signal = callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
    let response: Response;
    for (let redirects = 0; ; redirects++) {
      if (!allowUrl(target)) throw new ExtensionDownloadError("Unsafe download URL");
      response = await fetch(target.href, {
        signal,
        redirect: "manual",
        ...(headers ? { headers } : {}),
      });
      const location = response.headers.get("location");
      if (!location || ![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      if (redirects >= 4) throw new ExtensionDownloadError("Too many download redirects");
      target = new URL(location, target);
    }
    const body = response.body;
    if (!response.ok || !body || Number(response.headers.get("content-length")) > limit) {
      await body?.cancel().catch(() => undefined);
      if (!response.ok) throw new ExtensionHttpError(response.status);
      throw new ExtensionDownloadError("Download is empty or exceeds the size limit");
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new ExtensionDownloadError("Download exceeds the size limit");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof ExtensionDownloadError) throw error;
    throw new ExtensionDownloadError("Download failed or timed out", { cause: error });
  }
}
