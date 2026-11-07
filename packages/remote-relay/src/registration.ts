import { createPublicKey, randomBytes, verify } from "node:crypto";
import { connect, type ClientHttp2Session } from "node:http2";
import type { Socket } from "node:net";
import { createWebSocketStream, WebSocket } from "ws";
import { log } from "./log.js";
import type { RelayOptions } from "./index.js";
import { Usage } from "./usage.js";
import {
  closeCodes,
  deriveId,
  headers,
  isDnsLabel,
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

export interface RegistrationRequest {
  id: string;
  ip: string | undefined;
  name?: string;
  invite?: string;
}

export type RegistrationResult =
  | { name: string; rate?: number; dailyQuota?: number; usedToday?: number }
  | { reject: "invite" | "name-taken" | "banned" | "full" };

export interface Agent {
  session: ClientHttp2Session;
  phones: Set<Socket>;
  authentications: Map<string, () => void>;
  close: (code: number) => void;
  notifyQuota: () => void;
}

export function registerAgent(
  ws: WebSocket,
  agents: Map<string, Agent>,
  usageByName: Map<string, Usage>,
  options: RelayOptions & { controlHost: string },
  ip: string | undefined,
): void {
  const duplex = createWebSocketStream(ws);
  const session = connect("http://relay", {
    createConnection: () => duplex,
    settings: { initialWindowSize: streamWindowSize },
  });
  session.setLocalWindowSize(connectionWindowSize);
  let name: string | undefined;
  let pong = true;
  const agent: Agent = {
    session,
    phones: new Set(),
    authentications: new Map(),
    close(code) {
      unregister(code === closeCodes.replaced ? "replace" : "unregister");
      ws.close(code);
    },
    notifyQuota() {
      const until = new Date();
      until.setUTCHours(24, 0, 0, 0);
      const notice = session.request({ ":method": "POST", ":path": paths.notice });
      notice.on("error", () => notice.destroy());
      notice.resume();
      notice.end(JSON.stringify({ quota: "exhausted", until: until.toISOString() }));
    },
  };
  // Reports travel over this computer's signed control session and identify a live relay stream,
  // never an IP supplied by an HTTP client. Old computers simply do not send these optional pushes.
  session.on("stream", (stream, request) => {
    stream.on("error", () => stream.destroy());
    const id = request[headers.connectionId];
    const authenticated =
      name !== undefined &&
      agents.get(name) === agent &&
      request[":method"] === "GET" &&
      request[":path"] === paths.authenticated &&
      typeof id === "string"
        ? agent.authentications.get(id)
        : undefined;
    if (!authenticated) {
      stream.close();
      return;
    }
    let accepted = false;
    let empty = true;
    stream.once("push", (response) => {
      accepted = Number(response[":status"]) === 204;
    });
    stream.on("data", () => {
      empty = false;
      stream.close();
    });
    stream.once("end", () => {
      if (empty && accepted) authenticated();
    });
    stream.resume();
  });
  const unregister = (reason: "replace" | "unregister" | "timeout" = "unregister") => {
    if (name && agents.get(name) === agent) {
      agents.delete(name);
      log(reason === "timeout" ? "unregister" : reason, name, ip);
      options.onConnection?.({
        type: "computer",
        state: "offline",
        name,
        ip,
        time: Date.now(),
        reason,
      });
    }
    for (const phone of agent.phones) phone.destroy();
  };
  const timeout = setTimeout(() => agent.close(closeCodes.registrationTimeout), 10_000);
  const heartbeat = setInterval(() => {
    if (!pong) {
      unregister("timeout");
      ws.terminate();
      return;
    }
    pong = false;
    ws.ping();
  }, options.heartbeatInterval ?? 25_000);
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
  request.once("response", async (response, _flags, rawHeaders) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    let id: string;
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
        !verify(
          null,
          Buffer.from(registrationContent(options.controlHost, challenge)),
          key,
          signature,
        )
      ) {
        agent.close(closeCodes.invalidSignature);
        return;
      }
      id = deriveId(publicKey);
    } catch {
      agent.close(closeCodes.invalidSignature);
      return;
    }
    try {
      const result = options.check
        ? await options.check({
            id,
            ip,
            ...(response[headers.name] === undefined
              ? {}
              : { name: String(response[headers.name]) }),
            ...(response[headers.invite] === undefined
              ? {}
              : { invite: String(response[headers.invite]) }),
          })
        : { name: id };
      if (ws.readyState !== WebSocket.OPEN) return;
      if ("reject" in result) {
        const codes = {
          invite: closeCodes.invite,
          "name-taken": closeCodes.nameTaken,
          banned: closeCodes.banned,
          full: closeCodes.full,
        };
        agent.close(codes[result.reject]);
        return;
      }
      if (!isDnsLabel(result.name)) {
        agent.close(1000);
        return;
      }
      name = result.name.toLowerCase();
      const rate = result.rate ?? options.rate;
      const dailyQuota = result.dailyQuota ?? options.dailyQuota;
      let usage = usageByName.get(name);
      if (!usage) {
        usage = new Usage(rate, dailyQuota, result.usedToday);
        usageByName.set(name, usage);
      } else if (options.check) {
        usage.configure(rate, dailyQuota, result.usedToday);
      }
      clearTimeout(timeout);
      agents.get(name)?.close(closeCodes.replaced);
      request.end(JSON.stringify({ hostname: `${name}.${options.domain}` }));
      agents.set(name, agent);
      log("register", name, ip);
      options.onConnection?.({ type: "computer", state: "online", name, ip, time: Date.now() });
      if (usage.exceeded) agent.notifyQuota();
    } catch {
      agent.close(1000);
    }
  });
  request.resume();
}
