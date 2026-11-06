import { createPublicKey, randomBytes, verify } from "node:crypto";
import { connect, type ClientHttp2Session } from "node:http2";
import type { Socket } from "node:net";
import { createWebSocketStream, WebSocket } from "ws";
import { log } from "./log.js";
import {
  closeCodes,
  deriveId,
  headers,
  paths,
  registrationContent,
  streamWindowSize,
  connectionWindowSize,
} from "./protocol.js";

function decodeField(value: unknown, length: number): Buffer {
  if (typeof value !== "string") throw new Error("Invalid registration field");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== length || decoded.toString("base64url") !== value) {
    throw new Error("Invalid registration encoding or length");
  }
  return decoded;
}

export interface Agent {
  session: ClientHttp2Session;
  phones: Set<Socket>;
  close: (code: number) => void;
}

export function registerAgent(
  ws: WebSocket,
  agents: Map<string, Agent>,
  domain: string,
  controlHost: string,
  heartbeatInterval: number,
  ip: string | undefined,
): void {
  const duplex = createWebSocketStream(ws);
  const session = connect("http://relay", {
    createConnection: () => duplex,
    settings: { initialWindowSize: streamWindowSize },
  });
  session.setLocalWindowSize(connectionWindowSize);
  let id: string | undefined;
  let pong = true;
  const agent: Agent = {
    session,
    phones: new Set(),
    close(code) {
      unregister(code === closeCodes.replaced ? "replace" : "unregister");
      ws.close(code);
    },
  };
  const unregister = (reason: "replace" | "unregister" = "unregister") => {
    if (id && agents.get(id) === agent) {
      agents.delete(id);
      log(reason, id, ip);
    }
    for (const phone of agent.phones) phone.destroy();
  };
  const timeout = setTimeout(() => agent.close(closeCodes.registrationTimeout), 10_000);
  const heartbeat = setInterval(() => {
    if (!pong) {
      unregister();
      ws.terminate();
      return;
    }
    pong = false;
    ws.ping();
  }, heartbeatInterval);
  ws.on("pong", () => {
    pong = true;
  });
  ws.once("close", () => {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    unregister();
    // HTTP/2 must not retain a Duplex after its WebSocket has closed.
    session.destroy();
    duplex.destroy();
  });
  const abort = () => {
    unregister();
    ws.terminate();
  };
  ws.on("error", abort);
  duplex.on("error", abort);
  session.on("error", abort);
  session.once("goaway", abort);
  session.once("close", () => {
    unregister();
    ws.close();
  });

  const challenge = randomBytes(32).toString("base64url");
  const request = session.request({
    ":method": "POST",
    ":path": paths.register,
    [headers.challenge]: challenge,
  });
  request.on("error", () => ws.terminate());
  request.once("response", (response, _flags, rawHeaders) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      for (const name of [headers.publicKey, headers.signature]) {
        if (rawHeaders.filter((value, index) => index % 2 === 0 && value === name).length !== 1) {
          throw new Error("Repeated or missing registration field");
        }
      }
      const publicKey = decodeField(response[headers.publicKey], 32);
      const signature = decodeField(response[headers.signature], 64);
      const key = createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: publicKey.toString("base64url") },
        format: "jwk",
      });
      if (
        response[":status"] !== 200 ||
        !verify(null, Buffer.from(registrationContent(controlHost, challenge)), key, signature)
      ) {
        agent.close(closeCodes.invalidSignature);
        return;
      }
      id = deriveId(publicKey);
    } catch {
      agent.close(closeCodes.invalidSignature);
      return;
    }
    clearTimeout(timeout);
    agents.get(id)?.close(closeCodes.replaced);
    request.end(JSON.stringify({ hostname: `${id}.${domain}` }));
    agents.set(id, agent);
    log("register", id, ip);
  });
  request.resume();
}
