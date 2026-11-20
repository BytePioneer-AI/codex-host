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
const statsBase = "https://stats.example/counter/";
let directory: URL;

beforeEach(async () => {
  vi.stubEnv("CODEXHOST_DESKTOP_EXTENSIONS_STATS_URL", undefined);
  vi.stubEnv("STATS_URL", undefined);
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

function mockGitHub(
  readMetadata: (headers: Headers) => Response,
  archive = (id: string) => extensionZip({ id }),
  stats?: (init: RequestInit) => Response,
) {
  vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
    if (stats && url.href === `${statsBase}stats.json`) return stats(init);
    const { headers } = init;
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
      if (href === `${releaseUrl}/${id}.zip`) return new Response(new Uint8Array(archive(id)));
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
  const categories = ["interface", "analytics"];
  mockGitHub(
    (headers) => {
      expect(headers.get("authorization")).toBe("Bearer test-token");
      expect(headers.get("user-agent")).toBe("codexhost-desktop-extension-registry");
      if (requestsLeft-- <= 0) return new Response(null, { status: 429 });
      return Response.json({ stargazers_count: 42 });
    },
    (id) => extensionZip({ id, manifest: { categories } }),
  );
  expect(JSON.parse(await syncCatalog()).extensions).toMatchObject([
    { id: "other", stars: 42, categories },
    { id: "sample", stars: 42, categories },
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

it("fetches one anonymous stats snapshot and merges only valid counts for indexed IDs", async () => {
  vi.stubEnv("STATS_URL", statsBase);
  vi.stubEnv("GITHUB_TOKEN", "test-token");
  let payload = { sample: 25, other: 0, unrelated: 100 };
  const stats = vi.fn((init: RequestInit) => {
    expect(init.method ?? "GET").toBe("GET");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    return Response.json({ generatedAt: publishedAt, downloads: payload });
  });
  mockGitHub(() => Response.json({}), undefined, stats);
  const first = await syncCatalog();
  expect(stats).toHaveBeenCalledOnce();
  expect(JSON.parse(first).extensions).toMatchObject([
    { id: "other", downloads: 0 },
    { id: "sample", downloads: 25 },
  ]);
  const compact = JSON.stringify(JSON.parse(first));
  await writeFile(new URL("catalog.json", directory), compact);
  expect(await syncCatalog()).toBe(compact);

  payload = { ...payload, sample: 26, other: -1 };
  const { extensions } = JSON.parse(await syncCatalog());
  expect(extensions[0]).not.toHaveProperty("downloads");
  expect(extensions[1]).toMatchObject({ id: "sample", downloads: 26 });
});

it.each([
  ["unconfigured", undefined],
  ["HTTP failure", () => new Response(null, { status: 503 })],
  [
    "network error",
    () => {
      throw new Error("offline");
    },
  ],
  ["invalid JSON", () => new Response("not JSON")],
] as const)("omits download counts when stats are %s", async (_label, stats) => {
  vi.stubEnv("CODEXHOST_DESKTOP_EXTENSIONS_STATS_URL", statsBase);
  mockGitHub(
    () => Response.json({}),
    undefined,
    () => Response.json({ downloads: { sample: 12 } }),
  );
  expect(JSON.parse(await syncCatalog()).extensions[1]).toMatchObject({ downloads: 12 });

  if (!stats) vi.stubEnv("CODEXHOST_DESKTOP_EXTENSIONS_STATS_URL", undefined);
  mockGitHub(() => Response.json({}), undefined, stats);
  const { extensions } = JSON.parse(await syncCatalog());
  expect(extensions).toHaveLength(2);
  for (const entry of extensions) expect(entry).not.toHaveProperty("downloads");
});

it("indexes a backend-only package without executing its entry", async () => {
  mockGitHub(
    () => Response.json({}),
    (id) =>
      extensionZip({
        id,
        manifest: {
          slots: ["appearance.theme"],
          desktop: undefined,
          backend: { script: "backend.mjs" },
        },
        extras: [
          { name: "backend.mjs", data: 'throw new Error("must not execute in the registry");' },
        ],
      }),
  );
  expect(JSON.parse(await syncCatalog()).extensions).toMatchObject([
    { id: "other", slots: ["appearance.theme"] },
    { id: "sample", slots: ["appearance.theme"] },
  ]);
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
