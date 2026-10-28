import { HermesGatewayTransport } from "./gateway-transport.js";
import type { HermesPythonRuntime } from "./hermes-runtime.js";

function sameRuntime(a: HermesPythonRuntime, b: HermesPythonRuntime): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.launcher === b.launcher;
}

/**
 * Warm pool of started gateway bridges.
 *
 * A bridge is a stateless pipe between the host and the resident gateway's
 * canonical WebSocket (session state lives in the gateway process), so a
 * settled session's bridge can serve the next open instead of paying a fresh
 * interpreter start + WS attach (~1s). Each bridge serves one session at a
 * time: acquire hands out exclusive ownership and release returns it.
 *
 * The pool keys nothing per-thread on purpose: cwd is a session.create
 * parameter (never read from the bridge process) and CODEXHOST_THREAD_ID only
 * steers the delegation skill registered at spawn time, whose guidance text is
 * thread-independent.
 */
export class GatewayTransportPool {
  #idle: HermesGatewayTransport[] = [];
  #capacity: number;
  constructor(capacity = 2) {
    this.#capacity = Math.max(1, capacity);
  }
  /** A healthy started bridge for this runtime, or null when none is pooled. */
  acquire(runtime: HermesPythonRuntime): HermesGatewayTransport | null {
    while (this.#idle.length > 0) {
      const index = this.#idle.findIndex((transport) => sameRuntime(transport.runtime, runtime));
      const transport = index >= 0 ? this.#idle.splice(index, 1)[0] : undefined;
      if (transport === undefined) return null;
      if (!transport.closed && transport.started) return transport;
      void transport.close().catch(() => undefined);
    }
    return null;
  }
  /** Return a bridge after its session settled; unhealthy ones are discarded. */
  release(transport: HermesGatewayTransport): void {
    if (transport.closed) return;
    if (this.#idle.length >= this.#capacity) {
      void transport.close().catch(() => undefined);
      return;
    }
    this.#idle.push(transport);
  }
  async close(): Promise<void> {
    const transports = this.#idle;
    this.#idle = [];
    await Promise.all(transports.map((transport) => transport.close().catch(() => undefined)));
  }
}

/** Build and fully start a bridge (delegation prepare + spawn + capabilities). */
export async function startGatewayTransport(
  runtime: HermesPythonRuntime,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs?: number,
): Promise<HermesGatewayTransport> {
  const transport = new HermesGatewayTransport(runtime, cwd, environment, timeoutMs);
  await transport.prepareSession();
  await transport.start();
  return transport;
}
