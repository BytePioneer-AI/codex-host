import {
  desktopExtensionHttpUrlSchema,
  desktopExtensionZipUrlSchema,
} from "@codexhost/shared-contracts";

export class DesktopExtensionPackageError extends Error {}

export class ExtensionHttpError extends DesktopExtensionPackageError {
  constructor(readonly status: number) {
    super(`Download returned HTTP ${status}`);
  }
}

export async function downloadExtensionBytes(url: string, limit: number, accept?: string) {
  const parsed = desktopExtensionHttpUrlSchema.safeParse(url);
  if (!parsed.success)
    throw new DesktopExtensionPackageError("Expected a credential-free HTTP(S) URL");
  try {
    const response = await fetch(parsed.data, {
      signal: AbortSignal.timeout(12_000),
      ...(accept ? { headers: { accept } } : {}),
    });
    const body = response.body;
    if (!response.ok || !body || Number(response.headers.get("content-length")) > limit) {
      await body?.cancel().catch(() => undefined);
      if (!response.ok) throw new ExtensionHttpError(response.status);
      throw new DesktopExtensionPackageError("Download is empty or exceeds the size limit");
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new DesktopExtensionPackageError("Download exceeds the size limit");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof DesktopExtensionPackageError) throw error;
    throw new DesktopExtensionPackageError("Download failed or timed out", { cause: error });
  }
}

export async function resolveDesktopExtensionDownloadUrl(input: string): Promise<string> {
  const url = desktopExtensionHttpUrlSchema.safeParse(input);
  if (!url.success)
    throw new DesktopExtensionPackageError("Expected a credential-free HTTP(S) URL");
  const parsed = new URL(url.data);
  const repository =
    parsed.origin === "https://github.com" && /^\/([\w-]+)\/([\w.-]+)\/?$/u.exec(parsed.pathname);
  if (!repository) {
    if (desktopExtensionZipUrlSchema.safeParse(url.data).success) return url.data;
    throw new DesktopExtensionPackageError(
      "Use a .zip download URL or a GitHub repository homepage",
    );
  }
  const [, owner, repo] = repository;
  if (!repo || repo.endsWith(".git"))
    throw new DesktopExtensionPackageError("Use a GitHub repository homepage, without .git");
  let release: unknown;
  try {
    release = JSON.parse(
      (
        await downloadExtensionBytes(
          `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
          1024 * 1024,
          "application/vnd.github+json",
        )
      ).toString("utf8"),
    );
  } catch (error) {
    if (error instanceof ExtensionHttpError && error.status === 404)
      throw new DesktopExtensionPackageError("GitHub repository has no public stable Release");
    if (error instanceof DesktopExtensionPackageError) throw error;
    throw new DesktopExtensionPackageError("Invalid GitHub Release response", { cause: error });
  }
  const assets = release && typeof release === "object" && "assets" in release && release.assets;
  if (Array.isArray(assets)) {
    for (const asset of assets) {
      if (typeof asset?.name !== "string" || !/\.zip$/iu.test(asset.name)) continue;
      const download = desktopExtensionZipUrlSchema.safeParse(asset.browser_download_url);
      if (download.success && new URL(download.data).origin === "https://github.com")
        return download.data;
    }
  }
  throw new DesktopExtensionPackageError(
    "Latest GitHub Release has no .zip asset; use a direct .zip URL",
  );
}
