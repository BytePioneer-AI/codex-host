import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { connect, type ClientHttp2Session, type ClientHttp2Stream } from "node:http2";
import { createServer } from "node:https";
import { it } from "node:test";
import { createWebSocketStream, WebSocketServer } from "ws";
import { headers, paths, type RegistrationResponse } from "@codexhost/remote-relay/protocol";
import { connectRelay } from "../src/remote-relay/client.ts";
import { relayIdentity } from "../src/remote-relay/identity.ts";
import { environment } from "./support/pebble.ts";
import { credentials, relayData, until } from "./support/relay.ts";

it("forwards the complete registration and authority notices, acknowledging unknown notices", async (t) => {
  environment(t, { HTTPS_PROXY: "", https_proxy: "" });
  const server = createServer(credentials);
  const websockets = new WebSocketServer({ server, path: paths.agent });
  let session: ClientHttp2Session | undefined;
  websockets.on("connection", (ws) => {
    session = connect("http://relay", { createConnection: () => createWebSocketStream(ws) });
    session.on("error", () => {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let registration: RegistrationResponse | undefined;
  const authorities: string[] = [];
  const quotas: string[] = [];
  const disconnect = connectRelay({
    host: `localhost:${(server.address() as { port: number }).port}`,
    identity: relayIdentity(relayData(t)),
    connecting() {},
    registered: (value) => {
      registration = value;
    },
    certificateAuthority: (value) => authorities.push(value.directory),
    notice: (until) => quotas.push(until),
    stopped() {},
    tcp(stream) {
      stream.close();
    },
  });
  t.after(async () => {
    disconnect();
    session?.destroy();
    for (const ws of websockets.clients) ws.terminate();
    websockets.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await until(() => session !== undefined);
  assert.ok(session);
  const expected = {
    hostname: "phone.relay.test",
    token: "token",
    certificateAuthority: { directory: "https://ca.invalid/dir" },
  };
  const request = session.request({
    ":method": "POST",
    ":path": paths.register,
    [headers.challenge]: randomBytes(32).toString("base64url"),
  });
  request.resume();
  request.end(JSON.stringify(expected));
  await once(request, "end");
  assert.deepEqual(registration, expected);
  for (const notice of [
    { certificateAuthority: { directory: "https://new-ca.invalid/dir" } },
    { unknown: true },
    { quota: "exhausted", until: "2030-01-01T00:00:00Z" },
  ]) {
    const request: ClientHttp2Stream = session.request({
      ":method": "POST",
      ":path": paths.notice,
    });
    request.resume();
    const response = once(request, "response");
    request.end(JSON.stringify(notice));
    const [responseHeaders] = await response;
    assert.equal(responseHeaders[":status"], 200);
    await once(request, "end");
  }
  assert.deepEqual(authorities, ["https://new-ca.invalid/dir"]);
  assert.deepEqual(quotas, ["2030-01-01T00:00:00Z"]);
});
