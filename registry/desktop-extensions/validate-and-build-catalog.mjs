import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Script } from "node:vm";
import { z } from "zod";
import {
  DESKTOP_EXTENSION_ICON_MAX_BYTES,
  DESKTOP_EXTENSION_MANIFEST_MAX_BYTES,
  DESKTOP_EXTENSION_SCREENSHOT_MAX_BYTES,
  DESKTOP_EXTENSION_SCRIPT_MAX_BYTES,
  DESKTOP_EXTENSION_STYLE_MAX_BYTES,
  DESKTOP_EXTENSION_ZIP_MAX_BYTES,
  compareExtensionVersions,
  desktopExtensionCatalogEntrySchema,
  desktopExtensionCatalogSchema,
  desktopExtensionHttpUrlSchema,
  desktopExtensionIdSchema,
  desktopExtensionManifestSchema,
  desktopExtensionScreenshotMimeType,
  desktopExtensionZipUrlSchema,
  isGitHubDesktopExtensionZipballUrl,
  readDesktopExtensionZip,
} from "./runtime.mjs";

const github = /^https:\/\/github\.com\/([\w-]+)\/([\w-][\w.-]*)\/?$/u;
const githubHeaders = {
  accept: "application/vnd.github+json",
  "user-agent": "codexhost-desktop-extension-registry",
};
const safeAssetName = /^[\w.-]+\.zip$/iu;
const sourcesSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    sources: z.array(
      z.strictObject({
        id: desktopExtensionIdSchema,
        repository: z.string().regex(github),
        asset: z.string().regex(safeAssetName).optional(),
        trustTier: z.enum(["official", "community"]).default("community"),
        minCodexHostVersion: z.string().min(1).optional(),
      }),
    ),
  })
  .refine(
    ({ sources }) => new Set(sources.map(({ id }) => id)).size === sources.length,
    "Duplicate source IDs",
  );
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const utf8 = new TextDecoder("utf-8", { fatal: true });
const assetOrigins = new Set([
  "https://github.com",
  "https://release-assets.githubusercontent.com",
  "https://objects.githubusercontent.com",
  "https://github-releases.githubusercontent.com",
]);
const checks = [
  ["eval", /\beval\s*\(/u],
  ["Function constructor", /\bnew\s+Function\b/u],
  ["child_process", /\bchild_process\b/u],
];

async function readResponseBytes(response, limit, label) {
  const { body } = response;
  if (!response.ok || !body || Number(response.headers.get("content-length")) > limit) {
    await body?.cancel();
    throw new Error(`${label} unavailable or too large (HTTP ${response.status})`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error(`${label} exceeds the size limit`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function download(input, limit, { headers, missingOk = false } = {}) {
  let url = new URL(input);
  const zipball = isGitHubDesktopExtensionZipballUrl(url);
  const signal = AbortSignal.timeout(15_000);
  for (let redirects = 0; redirects <= 4; redirects++) {
    const response = await fetch(url, { headers, signal, redirect: "manual" });
    const body = response.body;
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await body?.cancel();
      const location = response.headers.get("location");
      if (!location || (headers && !zipball))
        throw new Error("Unexpected GitHub API or asset redirect");
      url = new URL(location, url);
      if (
        !(zipball ? url.origin === "https://codeload.github.com" : assetOrigins.has(url.origin)) ||
        url.username ||
        url.password
      )
        throw new Error("Untrusted GitHub archive or asset redirect");
      continue;
    }
    if (missingOk && response.status === 404) {
      await body?.cancel();
      return undefined;
    }
    return readResponseBytes(response, limit, "GitHub download");
  }
  throw new Error("Too many GitHub asset redirects");
}

function assetUrl(asset, owner, repo) {
  const url = new URL(asset.browser_download_url);
  if (
    url.origin !== "https://github.com" ||
    url.username ||
    url.password ||
    !url.pathname.toLowerCase().startsWith(`/${owner}/${repo}/releases/download/`.toLowerCase())
  )
    throw new Error("Release asset URL does not belong to the source repository");
  return url.href;
}

function getResource(files, path, limit) {
  const bytes = files.get(path);
  if (!bytes || bytes.length > limit) throw new Error(`Missing or oversized resource: ${path}`);
  return bytes;
}

function validateImage(bytes, path, label) {
  const mime = desktopExtensionScreenshotMimeType(path);
  const valid =
    mime === "image/png"
      ? bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
      : mime === "image/jpeg"
        ? bytes.subarray(0, 3).toString("hex") === "ffd8ff"
        : mime === "image/webp" &&
          bytes.subarray(0, 4).toString() === "RIFF" &&
          bytes.subarray(8, 12).toString() === "WEBP";
  if (!valid) throw new Error(`${label} type does not match ${path}`);
}

async function loadGitHubJson(url, headers, missingOk = false) {
  const bytes = await download(url, 1024 * 1024, { headers, missingOk });
  return bytes === undefined ? undefined : JSON.parse(utf8.decode(bytes));
}

async function readRepositoryStars(api, headers) {
  try {
    const metadata = await loadGitHubJson(api, headers);
    const { data } = desktopExtensionCatalogEntrySchema.shape.stars.safeParse(
      metadata?.stargazers_count,
    );
    return data;
  } catch {
    return undefined;
  }
}

async function readDownloadCounts() {
  try {
    const { data } = desktopExtensionHttpUrlSchema.safeParse(
      process.env.CODEXHOST_DESKTOP_EXTENSIONS_STATS_URL?.trim() || process.env.STATS_URL,
    );
    if (data === undefined) return;
    const url = new URL(data);
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}/stats.json`;
    url.search = "";
    url.hash = "";
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5_000) });
    const bytes = await readResponseBytes(response, 1024 * 1024, "Download stats");
    const { downloads } = JSON.parse(utf8.decode(bytes));
    if (downloads && typeof downloads === "object" && !Array.isArray(downloads)) return downloads;
  } catch {
    // Optional data; missing counts must not prevent publishing the index.
  }
}

async function selectPackage(source, { owner, repo, api, headers }) {
  const release = await loadGitHubJson(`${api}/releases/latest`, headers, true);
  if (release !== undefined) {
    if (
      release.draft ||
      release.prerelease ||
      !release.published_at ||
      !Array.isArray(release.assets)
    )
      throw new Error("Expected a public stable Release");
    const zipAssets = release.assets.filter(
      ({ name }) =>
        typeof name === "string" &&
        safeAssetName.test(name) &&
        (!source.asset || name === source.asset),
    );
    if (zipAssets.length > 1)
      throw new Error("Multiple Release .zip assets; set sources[].asset to disambiguate");
    const [asset] = zipAssets;
    if (asset)
      return {
        downloadUrl: assetUrl(asset, owner, repo),
        asset,
        release,
        date: release.published_at,
      };
  }
  if (source.asset) throw new Error(`Expected Release .zip asset ${source.asset}`);

  // Pin the catalog to the commit we validate, not a moving default branch.
  const [head] = await loadGitHubJson(`${api}/commits?per_page=1`, headers);
  const sha = z
    .string()
    .regex(/^[a-f0-9]{40}$/u)
    .parse(head?.sha);
  return {
    downloadUrl: `${api}/zipball/${sha}`,
    sha,
    date: z.iso.datetime().parse(head?.commit?.committer?.date),
  };
}

async function validateSource(source, previous, starsByRepository, downloads) {
  const [, owner, repositoryName] = github.exec(source.repository);
  const repo = repositoryName.replace(/\.git$/iu, "");
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const headers = { ...githubHeaders };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const selected = await selectPackage(source, { owner, repo, api, headers });
  const { asset, release, date } = selected;
  const downloadUrl = desktopExtensionZipUrlSchema.parse(selected.downloadUrl);
  // The catalog URL must work for unauthenticated users, even when metadata uses a token.
  const zip = await download(
    downloadUrl,
    DESKTOP_EXTENSION_ZIP_MAX_BYTES,
    asset ? {} : { headers: githubHeaders },
  );
  const sha256 = digest(zip);
  if (asset?.digest != null && asset.digest !== `sha256:${sha256}`)
    throw new Error("Release SHA-256 does not match GitHub's digest");
  const files = readDesktopExtensionZip(zip);
  const manifest = desktopExtensionManifestSchema.parse(
    JSON.parse(
      utf8.decode(getResource(files, "manifest.json", DESKTOP_EXTENSION_MANIFEST_MAX_BYTES)),
    ),
  );
  if (manifest.id !== source.id) throw new Error("Manifest id does not match sources.json");
  if (manifest.version !== manifest.version.trim())
    throw new Error("Manifest version has surrounding whitespace");
  if (
    previous &&
    (compareExtensionVersions(manifest.version, previous.version) < 0 ||
      (previous.version === manifest.version && previous.sha256 !== sha256))
  )
    throw new Error("Package is a downgrade or changed ZIP bytes without a version bump");
  if (manifest.desktop) {
    const { script, style } = manifest.desktop;
    if (!files.has(script))
      throw new Error(
        `Missing entry file ${script}. Commit the built JavaScript entry or publish a Release .zip.`,
      );
    const source = utf8.decode(getResource(files, script, DESKTOP_EXTENSION_SCRIPT_MAX_BYTES));
    new Script(`(function(define) { "use strict";\n${source}\n})`);
    if (style) utf8.decode(getResource(files, style, DESKTOP_EXTENSION_STYLE_MAX_BYTES));
  }
  if (manifest.backend)
    utf8.decode(getResource(files, manifest.backend.script, DESKTOP_EXTENSION_SCRIPT_MAX_BYTES));
  for (const [file, bytes] of files) {
    if (
      file !== manifest.desktop?.script &&
      file !== manifest.backend?.script &&
      !/\.[cm]?[jt]sx?$/iu.test(file)
    )
      continue;
    const code = utf8.decode(bytes);
    const hits = checks.filter(([, pattern]) => pattern.test(code)).map(([label]) => label);
    if (hits.length) throw new Error(`Static scan flagged ${file}: ${hits.join(", ")}`);
  }
  async function resolveImage(path, maxBytes, label) {
    const bytes = getResource(files, path, maxBytes);
    validateImage(bytes, path, label);
    let url;
    if (release) {
      const matches = release.assets.filter(({ name }) => name === path.split("/").at(-1));
      if (matches.length !== 1)
        throw new Error(`Also attach ${path} to the Release as an individual image asset`);
      url = assetUrl(matches[0], owner, repo);
    } else {
      url = `https://raw.githubusercontent.com/${owner}/${repo}/${selected.sha}/${path.split("/").map(encodeURIComponent).join("/")}`;
    }
    if (!bytes.equals(await download(url, maxBytes)))
      throw new Error(`Published ${label.toLowerCase()} differs from ZIP: ${path}`);
    return url;
  }
  const icon = manifest.icon
    ? await resolveImage(manifest.icon, DESKTOP_EXTENSION_ICON_MAX_BYTES, "Icon")
    : undefined;
  const screenshots = [];
  for (const path of manifest.screenshots ?? []) {
    screenshots.push(
      await resolveImage(path, DESKTOP_EXTENSION_SCREENSHOT_MAX_BYTES, "Screenshot"),
    );
  }
  // Multiple sources can publish distinct assets from the same GitHub repository.
  const repositoryKey = api.toLowerCase();
  if (!starsByRepository.has(repositoryKey))
    starsByRepository.set(repositoryKey, await readRepositoryStars(api, headers));
  return desktopExtensionCatalogEntrySchema.parse({
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    details: manifest.details,
    author: manifest.author,
    repository: manifest.repository ?? source.repository,
    stars: starsByRepository.get(repositoryKey),
    downloads,
    categories: manifest.categories,
    slots: manifest.slots,
    trustTier: source.trustTier,
    icon,
    screenshots: screenshots.length ? screenshots : undefined,
    downloadUrl,
    sha256,
    publishedAt: previous?.publishedAt ?? date,
    updatedAt: date,
    minCodexHostVersion: source.minCodexHostVersion,
  });
}

function inline(text) {
  // GitHub job summaries and report artifacts contain untrusted metadata.
  return String(text)
    .replace(/[\r\n]+/gu, " ")
    .replace(/[&<>`|\[\]()]/gu, (character) => `&#${character.charCodeAt(0)};`)
    .slice(0, 800);
}

export async function buildCatalog({
  directory = new URL("./", import.meta.url),
  checkOnly = false,
} = {}) {
  const report = [
    "# Desktop extension safety report",
    "",
    "ZIP integrity, bundle layout, metadata, images and static patterns only. Passing is not a code audit or sandbox.",
    "",
  ];
  const catalogPath = new URL("catalog.json", directory);
  const entries = [];
  const starsByRepository = new Map();
  let failed = false;
  try {
    const { sources } = sourcesSchema.parse(
      JSON.parse(await readFile(new URL("sources.json", directory), "utf8")),
    );
    const previous = await readFile(catalogPath, "utf8")
      .then((data) => desktopExtensionCatalogSchema.parse(JSON.parse(data)))
      .catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
    const existing = new Map(previous?.extensions.map((entry) => [entry.id, entry]));
    const counts = checkOnly ? undefined : await readDownloadCounts();
    for (const source of [...sources].sort((a, b) => a.id.localeCompare(b.id, "en"))) {
      try {
        const count = counts && Object.hasOwn(counts, source.id) ? counts[source.id] : undefined;
        const { data: downloads } =
          desktopExtensionCatalogEntrySchema.shape.downloads.safeParse(count);
        const entry = await validateSource(
          source,
          existing.get(source.id),
          starsByRepository,
          downloads,
        );
        entries.push(entry);
        report.push(
          `- PASS — ${inline(entry.id)} ${inline(entry.version)} (${entry.trustTier}) · ${inline(source.repository)} · ${inline(entry.downloadUrl)} · SHA-256: ${entry.sha256}`,
        );
      } catch (error) {
        failed = true;
        report.push(`- FAIL — ${inline(source.id)}: ${inline(error.message)}`);
      }
    }
    if (!failed && !checkOnly && JSON.stringify(entries) !== JSON.stringify(previous?.extensions)) {
      const catalog = desktopExtensionCatalogSchema.parse({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        extensions: entries,
      });
      const temporary = new URL("catalog.json.tmp", directory);
      await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`);
      await rename(temporary, catalogPath);
    }
  } catch (error) {
    failed = true;
    report.push(`- FAIL — ${inline(error.message)}`);
  }
  const markdown = `${report.join("\n")}\n`;
  await writeFile(new URL("safety-report.md", directory), markdown);
  return { failed, markdown };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== "--check-only"))
    throw new Error("Usage: node validate-and-build-catalog.mjs [--check-only]");
  const { failed, markdown } = await buildCatalog({ checkOnly: args.length > 0 });
  if (failed) process.exitCode = 1;
  console.log(markdown);
}
