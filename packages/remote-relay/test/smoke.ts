import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:tls";
import { collect, credentials, fakeAgent, phone } from "./helpers.js";

const tls = createServer(credentials, (socket) => {
  socket.once("data", () =>
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nrelay-ok!\n"),
  );
});
const agent = await fakeAgent({
  port: 4488,
  tcp: (stream) => {
    tls.emit("connection", stream);
  },
});
const hostname = await agent.registered;
const client = phone(hostname, undefined, 4488);
try {
  await once(client, "secureConnect");
  const response = collect(client);
  client.write(`GET / HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`);
  assert.equal(
    (await response).toString(),
    "HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nrelay-ok!\n",
  );
  console.log("relay forwarding OK");
} finally {
  client.destroy();
  agent.ws.terminate();
  await agent.closed;
}
