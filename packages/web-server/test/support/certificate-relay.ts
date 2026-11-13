import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:https";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import type { TestContext } from "node:test";
import { paths, type ExternalAccount } from "@codexhost/remote-relay/protocol";
import { credentials } from "./relay.ts";

/** Protocol-only relay double; the CA remains a separate, TLS-verified server. */
export async function certificateRelay(
  t: TestContext,
  directory: string,
  externalAccount: { status: number; account?: ExternalAccount; retryAfter?: string } = {
    status: 404,
  },
) {
  const token = "registration-token";
  const authority = new URL(directory).host;
  const targets: string[] = [];
  const sockets = new Set<Duplex>();
  const requests: string[] = [];
  const server = createServer(credentials, (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, paths.externalAccount);
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    requests.push(request.url);
    response.writeHead(externalAccount.status, {
      "content-type": "application/json",
      ...(externalAccount.retryAfter ? { "retry-after": externalAccount.retryAfter } : {}),
    });
    response.end(JSON.stringify(externalAccount.account ?? {}));
  });
  server.on("connect", (request, socket, head) => {
    assert.equal(request.headers["proxy-authorization"], `Bearer ${token}`);
    assert.equal(request.url, authority);
    targets.push(request.url);
    const target = new URL(directory);
    const upstream = connect({ host: "127.0.0.1", port: Number(target.port || 443) }, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    sockets.add(socket);
    sockets.add(upstream);
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    host: `localhost:${(server.address() as { port: number }).port}`,
    token,
    targets,
    requests,
  };
}

export async function certificateProxy(t: TestContext, controlHost: string) {
  const targets: string[] = [];
  const sockets = new Set<Duplex>();
  const proxy = createHttpServer();
  proxy.on("connect", (request, socket, head) => {
    assert.equal(request.url, controlHost);
    targets.push(request.url);
    const control = new URL(`https://${controlHost}`);
    const upstream = connect({ host: "127.0.0.1", port: Number(control.port) }, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    sockets.add(socket);
    sockets.add(upstream);
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`, targets };
}
