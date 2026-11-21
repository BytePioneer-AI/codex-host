import { expect, it } from "vitest";
import worker from "../../../registry/desktop-extensions/worker/worker.js";

it("counts valid install IDs and returns a CORS-enabled snapshot across KV pages", async () => {
  const storage = new Map([
    ["count:existing", "7"],
    ["other-key", "99"],
  ]);
  async function get(key: string): Promise<string | null>;
  async function get(keys: string[]): Promise<Map<string, string | null>>;
  async function get(key: string | string[]) {
    return Array.isArray(key)
      ? new Map(key.map((name) => [name, storage.get(name) ?? null]))
      : (storage.get(key) ?? null);
  }
  const env = {
    STATS_KV: {
      get,
      async put(key: string, value: string) {
        storage.set(key, value);
      },
      async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
        const keys = [...storage.keys()].filter((key) => key.startsWith(prefix));
        const index = Number(cursor ?? 0);
        return {
          keys: keys.slice(index, index + 1).map((name) => ({ name })),
          list_complete: index + 1 >= keys.length,
          cursor: String(index + 1),
        };
      },
    },
  };
  const request = (path: string, method = "GET") =>
    worker.fetch(new Request(`https://stats.example${path}`, { method }), env);
  expect(await (await request("/health")).json()).toEqual({ ok: true });
  expect((await request("/install/sample-1", "OPTIONS")).status).toBe(204);
  for (const id of ["", "Uppercase", "with.dot", "a--b", "a%2Fb", "%ZZ"]) {
    expect((await request(`/install/${id}`, "POST")).status).toBe(400);
  }
  for (const downloads of [1, 2]) {
    expect(await (await request("/install/sample-1", "POST")).json()).toEqual({
      id: "sample-1",
      downloads,
    });
  }
  const snapshot = await request("/stats.json");
  expect(snapshot.headers.get("access-control-allow-origin")).toBe("*");
  expect(snapshot.headers.get("cache-control")).toBe("public, max-age=300");
  expect(await snapshot.json()).toEqual({
    generatedAt: expect.any(String),
    downloads: { existing: 7, "sample-1": 2 },
  });
});
