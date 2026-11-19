import { once } from "node:events";
import { request } from "node:https";
import type { AddressInfo } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { afterEach, expect, it, vi } from "vitest";
import { createRelay, type RelayOptions } from "../src/index.js";
import { certPath, collect, credentials, fakeAgent, keyPath, phone } from "./helpers.js";

const relays: ReturnType<typeof createRelay>[] = [];
async function start(options: Partial<RelayOptions> = {}) {
  const relay = createRelay({
    domain: "relay.test",
    controlHost: "relay.test",
    cert: certPath,
    key: keyPath,
    ...options,
  });
  relays.push(relay);
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  return (relay.server.address() as AddressInfo).port;
}

function get(port: number, path = "/admin") {
  return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, servername: "relay.test", rejectUnauthorized: false, path },
      (response) => {
        collect(response).then(
          (body) => resolve({ status: response.statusCode, body: body.toString() }),
          reject,
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close();
});

it("returns 404 without a request handler", async () => {
  const port = await start();
  expect(await get(port)).toEqual({ status: 404, body: "" });
  expect(await get(port, "/v1/agent")).toEqual({ status: 404, body: "" });
});

it("passes requests to the handler without changing registration or address forwarding", async () => {
  const onRequest = vi.fn<NonNullable<RelayOptions["onRequest"]>>(async (request, response) => {
    await Promise.resolve();
    response.writeHead(200).end(`${request.method} ${request.url}`);
  });
  const port = await start({ onRequest, check: () => ({ name: "alice" }) });
  expect(await get(port)).toEqual({ status: 200, body: "GET /admin" });
  expect(await get(port, "/v1/agent")).toEqual({ status: 200, body: "GET /v1/agent" });
  const target = createTlsServer(credentials, (socket) => {
    socket.on("error", () => {});
    socket.on("data", (chunk) => socket.end(chunk));
  });
  const agent = await fakeAgent({ port, tcp: (stream) => target.emit("connection", stream) });
  expect(await agent.registered).toBe("alice.relay.test");
  const client = phone("alice.relay.test", undefined, port);
  await once(client, "secureConnect");
  const body = collect(client);
  client.write("forwarded");
  expect((await body).toString()).toBe("forwarded");
  client.destroy();
  expect(onRequest).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "returns 500 and keeps serving when a handler fails (async: %s)",
  async (async) => {
    const port = await start({
      onRequest: (request, response) => {
        if (request.url === "/ok") {
          response.end("ok");
          return;
        }
        if (async) return Promise.reject(new Error("failed"));
        throw new Error("failed");
      },
    });
    expect(await get(port)).toEqual({ status: 500, body: "" });
    expect(await get(port, "/ok")).toEqual({ status: 200, body: "ok" });
  },
);

it("closes a failed response whose headers have already been sent", async () => {
  const port = await start({
    onRequest: async (_request, response) => {
      response.writeHead(200);
      response.flushHeaders();
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error("failed after headers");
    },
  });
  await expect(get(port)).rejects.toThrow();
  await expect(get(port)).rejects.toThrow();
});
