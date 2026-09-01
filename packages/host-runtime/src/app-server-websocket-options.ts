/**
 * Handshake options shared by every WebSocket client that talks to a codex
 * app-server listener.
 *
 * The stock codex app-server uses tokio-tungstenite, which supports no
 * WebSocket extension and aborts the upgrade without writing an HTTP response
 * when a client offers one. `ws` enables permessage-deflate by default, so any
 * client that omits this flag hangs until its own timeout instead of
 * completing the handshake. Keep the same handshake for every private
 * listener.
 */
export const APP_SERVER_WEBSOCKET_CLIENT_OPTIONS = {
  maxPayload: 128 * 1024 * 1024,
  perMessageDeflate: false,
} as const;
