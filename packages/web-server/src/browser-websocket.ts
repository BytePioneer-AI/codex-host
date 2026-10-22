/** WebSocket server options for the browser-facing multiplexed stream. */
import { WebSocketServer, type ServerOptions } from "ws";

/** Frames shorter than this are sent uncompressed: deflate costs more than it saves.
 * ws applies the threshold only when the sending side has no context takeover. */
export const BROWSER_DEFLATE_THRESHOLD = 1024;

/**
 * Compress large JSON frames (history, tool output) for LAN/Tailscale/remote
 * browsers. Only the browser leg is compressed; the Host leg is loopback HTTP.
 * Both directions disable context takeover: each frame is compressed on its own,
 * so the threshold applies, small projection updates cost no CPU, and a socket
 * keeps no deflate window between frames. Compression runs in the libuv thread
 * pool, so concurrency is capped; level 3 favors latency over ratio.
 */
export const BROWSER_WEBSOCKET_OPTIONS: ServerOptions = {
  noServer: true,
  maxPayload: 64 * 1024 * 1024,
  perMessageDeflate: {
    threshold: BROWSER_DEFLATE_THRESHOLD,
    zlibDeflateOptions: { level: 3, chunkSize: 16 * 1024 },
    zlibInflateOptions: { chunkSize: 16 * 1024 },
    serverNoContextTakeover: true,
    clientNoContextTakeover: true,
    concurrencyLimit: 4,
  },
};

export function createBrowserWebSocketServer(): WebSocketServer {
  return new WebSocketServer(BROWSER_WEBSOCKET_OPTIONS);
}
