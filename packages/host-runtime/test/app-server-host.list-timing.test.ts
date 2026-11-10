import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { createFixture, stopFixture } from "./app-server-host-fixture.js";

afterEach(() => vi.unstubAllEnvs());

for (const trace of [undefined, "1"]) {
  for (const fail of [false, true]) {
    it(`handles ${fail ? "failure" : "success"} with list tracing ${trace ? "enabled" : "disabled"} without altering the wire reply`, async () => {
      vi.stubEnv("CODEXHOST_TRACE_SESSION_LIST", trace);
      const fixture = createFixture();
      try {
        await fixture.ready;
        fixture.official.stdin.on("data", (chunk: Buffer) => {
          const request = JSON.parse(chunk.toString("utf8")) as JsonObject;
          if (request.method !== "thread/list") return;
          fixture.official.stdout.write(
            `${JSON.stringify({
              id: request.id,
              ...(fail
                ? { error: { code: -32000, message: "official unavailable details" } }
                : {
                    result: {
                      data: [
                        {
                          id: "private-thread",
                          cwd: "/private",
                          name: "private-title",
                          createdAt: 1,
                          updatedAt: 1,
                        },
                      ],
                      nextCursor: null,
                      backwardsCursor: null,
                    },
                  }),
            })}\n`,
          );
        });
        const reply = await fixture.host.handleClientRequest("thread/list", { limit: 200 });
        if (fail)
          expect(reply).toEqual({
            error: { code: -32000, message: "official unavailable details" },
          });
        else
          expect(reply).toMatchObject({
            result: { data: [{ id: "private-thread" }], nextCursor: null },
          });
        await setImmediate();
        const lines = String(fixture.diagnosticOutput.read() ?? "")
          .split("\n")
          .filter((line) => line.includes("[thread/list] "));
        if (!trace) {
          expect(lines).toHaveLength(fail ? 1 : 0);
          if (fail) expect(lines[0]).toContain("[thread/list] request failed");
          return;
        }
        expect(lines).toHaveLength(1);
        const log = JSON.parse(lines[0]?.split("[thread/list] ")[1] ?? "");
        expect(log).toMatchObject({
          origin: "client",
          ok: !fail,
          archived: false,
          limit: 100, // Host clamps the requested 200 rows to its native page bound.
          counts: { returnedRows: fail ? 0 : 1 },
          stages: {
            store: { calls: 1 },
            aggregate: { calls: 1 },
            official_page: { calls: 1 },
            external: { calls: 1 },
          },
          officialCalls: [{ kind: "page", limit: 100, ok: !fail }],
        });
        expect(log.requestId).toContain("client:");
        expect(log.totalMs).toBeGreaterThanOrEqual(0);
        expect(lines[0]).not.toMatch(
          /private-thread|private-title|\/private|official unavailable details/,
        );
        expect(reply).not.toHaveProperty("timing");
      } finally {
        await stopFixture(fixture);
      }
    });
  }
}
