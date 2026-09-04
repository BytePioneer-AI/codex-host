import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { openPenguinConnection } from "../src/penguin-api.js";

describe("openPenguinConnection", () => {
  it("uses and refreshes the local server api-token for loopback connections", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-penguin-api-"));
    try {
      await writeFile(path.join(root, "api-token"), "local-test-token\n", { mode: 0o600 });
      let requestCount = 0;
      const fetchImpl: typeof fetch = async (input, init) => {
        expect(new URL(String(input)).pathname).toBe("/api/projects");
        requestCount += 1;
        if (requestCount === 1) {
          expect(new Headers(init?.headers).get("authorization")).toBeNull();
          return new Response("{}", { status: 200 });
        }
        if (requestCount === 2) {
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer local-test-token");
          await writeFile(path.join(root, "api-token"), "rotated-test-token\n", { mode: 0o600 });
          return new Response(
            JSON.stringify({ error: { code: "unauthorized", message: "Invalid API token." } }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer rotated-test-token");
        return new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };

      const connection = await openPenguinConnection({
        endpoint: "http://127.0.0.1:7364",
        root,
        fetchImpl,
      });
      await expect(connection.client.request("/api/projects")).resolves.toEqual({ projects: [] });
      await connection.close();
      expect(requestCount).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
