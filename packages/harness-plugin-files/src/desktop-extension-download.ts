import {
  desktopExtensionHttpUrlSchema,
  desktopExtensionZipUrlSchema,
  isGitHubDesktopExtensionZipballUrl,
} from "@codexhost/shared-contracts";

const githubHeaders = {
  accept: "application/vnd.github+json",
  "user-agent": "codexhost-desktop-extensions",
};

export class DesktopExtensionPackageError extends Error {}

export class ExtensionHttpError extends DesktopExtensionPackageError {
  constructor(readonly status: number) {
    super(`Download returned HTTP ${status}`);
  }
}

export async function downloadExtensionBytes(
  url: string,
  limit: number,
  headers?: Record<string, string>,
) {
  const parsed = desktopExtensionHttpUrlSchema.safeParse(url);
  if (!parsed.success)
    throw new DesktopExtensionPackageError("Expected a credential-free HTTP(S) URL");
  try {
    if (isGitHubDesktopExtensionZipballUrl(new URL(parsed.data))) headers ??= githubHeaders;
    const response = await fetch(parsed.data, {
      signal: AbortSignal.timeout(12_000),
      redirect: "follow",
      ...(headers ? { headers } : {}),
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

export async function resolveDesktopExtensionDownload(
  input: string,
): Promise<{ url: string; subpath?: string }> {
  const url = desktopExtensionHttpUrlSchema.safeParse(input);
  if (!url.success)
    throw new DesktopExtensionPackageError("Expected a credential-free HTTP(S) URL");
  const parsed = new URL(url.data);
  // Match the original path so a tree subdirectory with dot segments is rejected, not normalized.
  const pathname = /^https:\/\/[^/?#]+([^?#]*)/iu.exec(url.data)?.[1] ?? "";
  const repository =
    parsed.origin === "https://github.com" &&
    /^\/([\w-]+)\/([\w-][\w.-]*)(?:\/tree\/([^/]+)(?:\/(.+?))?)?\/?$/u.exec(pathname);
  if (!repository) {
    if (desktopExtensionZipUrlSchema.safeParse(url.data).success) return { url: url.data };
    throw new DesktopExtensionPackageError(
      "Use a .zip download URL, GitHub repository homepage, or GitHub tree URL",
    );
  }
  const [, owner, repositoryName, encodedRef, encodedSubpath] = repository;
  const repo = repositoryName?.replace(/\.git$/iu, "");
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  if (encodedRef !== undefined) {
    try {
      const ref = decodeURIComponent(encodedRef);
      const parts = encodedSubpath?.split("/").map(decodeURIComponent);
      if (
        /[\x00-\x1f\x7f\\]/u.test(ref) ||
        ref.split("/").some((part) => !part || part === "." || part === "..") ||
        parts?.some(
          (part) => !part || part === "." || part === ".." || /[\x00-\x1f\x7f/\\]/u.test(part),
        )
      )
        throw new Error("Invalid ref or subdirectory");
      return {
        url: `${api}/zipball/${encodeURIComponent(ref)}`,
        ...(parts ? { subpath: parts.join("/") } : {}),
      };
    } catch (error) {
      throw new DesktopExtensionPackageError("Invalid GitHub tree ref or subdirectory", {
        cause: error,
      });
    }
  }
  const zipball = { url: `${api}/zipball` };
  let release: unknown;
  try {
    release = JSON.parse(
      (await downloadExtensionBytes(`${api}/releases/latest`, 1024 * 1024, githubHeaders)).toString(
        "utf8",
      ),
    );
  } catch (error) {
    if (error instanceof ExtensionHttpError && error.status === 404) return zipball;
    if (error instanceof DesktopExtensionPackageError) throw error;
    throw new DesktopExtensionPackageError("Invalid GitHub Release response", { cause: error });
  }
  const assets = release && typeof release === "object" && "assets" in release && release.assets;
  if (Array.isArray(assets)) {
    for (const asset of assets) {
      if (typeof asset?.name !== "string" || !/\.zip$/iu.test(asset.name)) continue;
      const download = desktopExtensionZipUrlSchema.safeParse(asset.browser_download_url);
      if (download.success) {
        const assetUrl = new URL(download.data);
        if (assetUrl.origin === "https://github.com" && /\.zip$/iu.test(assetUrl.pathname))
          return { url: download.data };
      }
    }
  }
  return zipball;
}
