import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { Script } from "node:vm";
import { z } from "zod";
import {
  DESKTOP_EXTENSION_MANIFEST_MAX_BYTES,
  DESKTOP_EXTENSION_SCREENSHOT_MAX_BYTES,
  DESKTOP_EXTENSION_SCRIPT_MAX_BYTES,
  DESKTOP_EXTENSION_STYLE_MAX_BYTES,
  DESKTOP_EXTENSION_ZIP_MAX_BYTES,
  compareExtensionVersions,
  desktopExtensionCatalogEntrySchema,
  desktopExtensionCatalogSchema,
  desktopExtensionIdSchema,
  desktopExtensionManifestSchema,
  desktopExtensionScreenshotMimeType,
  desktopExtensionZipUrlSchema,
  readDesktopExtensionZip,
} from "./runtime.mjs";

const github = /^https:\/\/github\.com\/([\w-]+)\/([\w-][\w.-]*)\/?$/u;
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

async function download(input, limit, headers) {
  let url = new URL(input);
  const signal = AbortSignal.timeout(15_000);
  for (let redirects = 0; redirects <= 4; redirects++) {
    const response = await fetch(url, { headers, signal, redirect: "manual" });
    const body = response.body;
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await body?.cancel();
      if (headers || !response.headers.get("location"))
        throw new Error("Unexpected GitHub API or asset redirect");
      url = new URL(response.headers.get("location"), url);
      if (!assetOrigins.has(url.origin) || url.username || url.password)
        throw new Error("Untrusted GitHub asset redirect");
      continue;
    }
    if (!response.ok || !body || Number(response.headers.get("content-length")) > limit) {
      await body?.cancel();
      throw new Error(`GitHub download unavailable or too large (HTTP ${response.status})`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > limit) throw new Error("GitHub response exceeds the size limit");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
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

function validateScreenshot(bytes, path) {
  const mime = desktopExtensionScreenshotMimeType(path);
  const valid =
    mime === "image/png"
      ? bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
      : mime === "image/jpeg"
        ? bytes.subarray(0, 3).toString("hex") === "ffd8ff"
        : mime === "image/webp" &&
          bytes.subarray(0, 4).toString() === "RIFF" &&
          bytes.subarray(8, 12).toString() === "WEBP";
  if (!valid) throw new Error(`Screenshot type does not match ${path}`);
}

async function validateSource(source, previous) {
  const [, owner, repo] = github.exec(source.repository);
  const headers = { accept: "application/vnd.github+json" };
  if (process.env.GH_TOKEN) headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
  const release = JSON.parse(
    utf8.decode(
      await download(
        `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
        1024 * 1024,
        headers,
      ),
    ),
  );
  if (
    release.draft ||
    release.prerelease ||
    !release.published_at ||
    !Array.isArray(release.assets)
  )
    throw new Error("Expected a public stable Release");
  const zipAssets = release.assets.filter(
    ({ name }) => safeAssetName.test(name) && (!source.asset || name === source.asset),
  );
  if (zipAssets.length !== 1)
    throw new Error(
      "Expected exactly one matching Release .zip asset; set sources[].asset to disambiguate",
    );
  const [asset] = zipAssets;
  const downloadUrl = desktopExtensionZipUrlSchema.parse(assetUrl(asset, owner, repo));
  const zip = await download(downloadUrl, DESKTOP_EXTENSION_ZIP_MAX_BYTES);
  const sha256 = digest(zip);
  if (asset.digest != null && asset.digest !== `sha256:${sha256}`)
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
    throw new Error("Release is a downgrade or changed ZIP bytes without a version bump");
  const script = utf8.decode(
    getResource(files, manifest.desktop.script, DESKTOP_EXTENSION_SCRIPT_MAX_BYTES),
  );
  new Script(`(function(define) { "use strict";\n${script}\n})`);
  if (manifest.desktop.style)
    utf8.decode(getResource(files, manifest.desktop.style, DESKTOP_EXTENSION_STYLE_MAX_BYTES));
  for (const [file, bytes] of files) {
    if (file !== manifest.desktop.script && !/\.[cm]?[jt]sx?$/iu.test(file)) continue;
    const code = utf8.decode(bytes);
    const hits = checks.filter(([, pattern]) => pattern.test(code)).map(([label]) => label);
    if (hits.length) throw new Error(`Static scan flagged ${file}: ${hits.join(", ")}`);
  }
  const screenshots = [];
  for (const path of manifest.screenshots ?? []) {
    const bytes = getResource(files, path, DESKTOP_EXTENSION_SCREENSHOT_MAX_BYTES);
    validateScreenshot(bytes, path);
    const matches = release.assets.filter(({ name }) => name === path.split("/").at(-1));
    if (matches.length !== 1)
      throw new Error(`Also attach ${path} to the Release as an individual image asset`);
    const url = assetUrl(matches[0], owner, repo);
    if (!bytes.equals(await download(url, DESKTOP_EXTENSION_SCREENSHOT_MAX_BYTES)))
      throw new Error(`Release screenshot differs from ZIP: ${path}`);
    screenshots.push(url);
  }
  return desktopExtensionCatalogEntrySchema.parse({
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    details: manifest.details,
    author: manifest.author,
    repository: manifest.repository ?? source.repository,
    categories: manifest.categories,
    slots: manifest.slots,
    trustTier: source.trustTier,
    screenshots: screenshots.length ? screenshots : undefined,
    downloadUrl,
    sha256,
    publishedAt: previous?.publishedAt ?? release.published_at,
    updatedAt: release.published_at,
    minCodexHostVersion: source.minCodexHostVersion,
  });
}

function inline(text) {
  // GitHub job summaries and report artifacts contain untrusted release metadata.
  return String(text)
    .replace(/[\r\n]+/gu, " ")
    .replace(/[&<>`|\[\]()]/gu, (character) => `&#${character.charCodeAt(0)};`)
    .slice(0, 800);
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length && args[0] !== "--check-only"))
  throw new Error("Usage: node validate-and-build-catalog.mjs [--check-only]");
const report = [
  "# Desktop extension safety report",
  "",
  "ZIP integrity, bundle layout, metadata, screenshots and static patterns only. Passing is not a code audit or sandbox.",
  "",
];
const catalogPath = new URL("catalog.json", import.meta.url);
const entries = [];
let previous;
try {
  const { sources } = sourcesSchema.parse(
    JSON.parse(await readFile(new URL("sources.json", import.meta.url), "utf8")),
  );
  previous = await readFile(catalogPath, "utf8")
    .then((data) => desktopExtensionCatalogSchema.parse(JSON.parse(data)))
    .catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
  const existing = new Map(previous?.extensions.map((entry) => [entry.id, entry]));
  for (const source of [...sources].sort((a, b) => a.id.localeCompare(b.id, "en"))) {
    try {
      const entry = await validateSource(source, existing.get(source.id));
      entries.push(entry);
      report.push(
        `- PASS — ${inline(entry.id)} ${inline(entry.version)} (${entry.trustTier}) · ${inline(source.repository)} · ${inline(entry.downloadUrl)} · SHA-256: ${entry.sha256}`,
      );
    } catch (error) {
      process.exitCode = 1;
      report.push(`- FAIL — ${inline(source.id)}: ${inline(error.message)}`);
    }
  }
  if (
    !process.exitCode &&
    !args.length &&
    JSON.stringify(entries) !== JSON.stringify(previous?.extensions)
  ) {
    const catalog = desktopExtensionCatalogSchema.parse({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      extensions: entries,
    });
    const temporary = new URL("catalog.json.tmp", import.meta.url);
    await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`);
    await rename(temporary, catalogPath);
  }
} catch (error) {
  process.exitCode = 1;
  report.push(`- FAIL — ${inline(error.message)}`);
}
const markdown = `${report.join("\n")}\n`;
await writeFile(new URL("safety-report.md", import.meta.url), markdown);
console.log(markdown);
