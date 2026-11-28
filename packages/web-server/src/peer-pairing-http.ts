import type { IncomingMessage, ServerResponse } from "node:http";
import type { PeerHostManager } from "./peer-host-manager.ts";
import { PeerEndpointError } from "./peer-manifest.ts";

const MAX_INTRODUCTION_BODY_BYTES = 32 * 1024;

export function peerPairingEnabled(): boolean {
  return process.env.CODEXHOST_DISABLE_PEER_PAIRING !== "1";
}

/** POST /api/peer/v1/peers, after the Web server's authentication and same-origin gates. */
export async function servePeerPairing(
  request: IncomingMessage,
  response: ServerResponse,
  manager: Pick<PeerHostManager, "introducePeer">,
): Promise<void> {
  const send = (status: number, body: unknown) => {
    if (response.destroyed || response.writableEnded || response.headersSent) return;
    response
      .writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      })
      .end(JSON.stringify(body));
  };
  try {
    if (request.method !== "POST") throw new PeerEndpointError(405, "Method not allowed");
    if (!peerPairingEnabled())
      throw new PeerEndpointError(503, "Peer pairing is disabled on this Host");
    const tooLarge = () =>
      new PeerEndpointError(413, "Peer introduction request body is too large");
    if (Number(request.headers["content-length"]) > MAX_INTRODUCTION_BODY_BYTES) throw tooLarge();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > MAX_INTRODUCTION_BODY_BYTES) throw tooLarge();
      chunks.push(buf);
    }
    let input: unknown;
    try {
      input = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    } catch {
      throw new PeerEndpointError(400, "Invalid JSON request body");
    }
    send(200, await manager.introducePeer(input));
  } catch (error) {
    if (error instanceof PeerEndpointError) send(error.status, { error: error.message });
    else send(500, { error: "Internal peer pairing error" });
    request.resume();
  }
}
