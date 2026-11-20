import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildCatalog } from "../../../registry/desktop-extensions/validate-and-build-catalog.mjs";
import { extensionZip } from "../../../tests/fixtures/desktop-extension-zip.js";

const repository = "https://github.com/owner/repo";
const api = "https://api.github.com/repos/owner/repo";
const releaseUrl = `${repository}/releases/download/v1`;
const publishedAt = "2026-01-01T00:00:00.000Z";
const ids = ["sample", "other"];
let directory: URL;

beforeEach(async () => {
  directory = pathToFileURL(
    (await mkdtemp(path.join(tmpdir(), "desktop-extension-registry-"))) + path.sep,
  );
  await writeFile(
    new URL("sources.json", directory),
    JSON.stringify({
      schemaVersion: 1,
      sources: ids.map((id) => ({
        id,
        repository: id === "sample" ? "https://github.com/Owner/Repo.git/" : repository,
        asset: `${id}.zip`,
      })),
    }),
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

function mockGitHub(readMetadata: (headers: Headers) => Response) {
  vi.stubGlobal("fetch", async (url: URL, { headers }: RequestInit) => {
    const href = url.href.toLowerCase();
    if (href === api) return readMetadata(new Headers(headers));
    if (href === `${api}/releases/latest`)
      return Response.json({
        published_at: publishedAt,
        assets: ids.map((id) => ({
          name: `${id}.zip`,
          browser_download_url: `${releaseUrl}/${id}.zip`,
        })),
      });
    for (const id of ids) {
      if (href === `${releaseUrl}/${id}.zip`)
        return new Response(new Uint8Array(extensionZip({ id })));
    }
    throw new Error(`Unexpected request: ${url.href}`);
  });
}

async function syncCatalog() {
  const { failed, markdown } = await buildCatalog({ directory });
  expect(failed, markdown).toBe(false);
  return readFile(new URL("catalog.json", directory), "utf8");
}

it("writes stargazers_count for both assets using a single authenticated repository request", async () => {
  vi.stubEnv("GITHUB_TOKEN", "test-token");
  let requestsLeft = 1;
  mockGitHub((headers) => {
    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(headers.get("user-agent")).toBe("codexhost-desktop-extension-registry");
    if (requestsLeft-- <= 0) return new Response(null, { status: 429 });
    return Response.json({ stargazers_count: 42 });
  });
  expect(JSON.parse(await syncCatalog()).extensions).toMatchObject([
    { id: "other", stars: 42 },
    { id: "sample", stars: 42 },
  ]);
});

it.each([
  ["unavailable", () => new Response(null, { status: 503 })],
  ["negative", () => Response.json({ stargazers_count: -1 })],
  ["fractional", () => Response.json({ stargazers_count: 1.5 })],
  ["missing", () => Response.json({})],
] as const)("omits %s star data without failing package validation", async (_label, metadata) => {
  mockGitHub(metadata);
  const { extensions } = JSON.parse(await syncCatalog());
  expect(extensions).toHaveLength(2);
  for (const entry of extensions) expect(entry).not.toHaveProperty("stars");
});

it("leaves identical catalog content in place and publishes a star-only change", async () => {
  let stars = 1;
  mockGitHub(() => Response.json({ stargazers_count: stars }));
  const before = JSON.parse(await syncCatalog());
  const catalogPath = new URL("catalog.json", directory);
  const compact = JSON.stringify(before);
  await writeFile(catalogPath, compact);
  expect(await syncCatalog()).toBe(compact);

  stars = 0;
  expect(JSON.parse(await syncCatalog()).extensions).toEqual(
    before.extensions.map((entry: { stars: number }) => ({ ...entry, stars: 0 })),
  );
});
