import assert from "node:assert/strict";
import { once } from "node:events";
import { Agent, createServer, get } from "node:http";
import { it } from "node:test";
import { createWebServer, HTTP_KEEP_ALIVE_TIMEOUT } from "../src/http-server.ts";
import { setTimeout as delay } from "node:timers/promises";

it("reuses an idle HTTP connection beyond five seconds without changing request deadlines", async (t) => {
  const servers = [
    createServer(),
    createWebServer((_request, response) => response.end("ok")),
  ] as const;
  const counts = [0, 0];
  const clients = await Promise.all(
    servers.map(async (server, index) => {
      if (index === 0) server.on("request", (_request, response) => response.end("ok"));
      server.on("connection", () => {
        counts[index] = (counts[index] ?? 0) + 1;
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const agent = new Agent({ keepAlive: true });
      t.after(() => {
        agent.destroy();
        server.closeAllConnections();
        server.close();
      });
      return () =>
        new Promise<void>((resolve, reject) => {
          const request = get(
            { host: "127.0.0.1", port: (server.address() as { port: number }).port, agent },
            (response) => {
              assert.equal(response.httpVersion, "1.1");
              response.resume();
              response.on("end", resolve);
            },
          );
          request.on("error", reject);
        });
    }),
  );
  assert.equal(servers[1].keepAliveTimeout, HTTP_KEEP_ALIVE_TIMEOUT);
  assert.equal(servers[1].headersTimeout, servers[0].headersTimeout);
  assert.equal(servers[1].requestTimeout, servers[0].requestTimeout);
  await Promise.all(clients.map((request) => request()));
  await delay(6_200); // Includes Node 24's one-second server timeout buffer.
  await Promise.all(clients.map((request) => request()));
  assert.deepEqual(counts, [2, 1]);
  t.diagnostic(`connections after idle: default=${counts[0]}, Web=${counts[1]}`);
});
