import { HermesGatewayTransport } from "./gateway-transport.js";
import type { HermesPythonRuntime } from "./hermes-runtime.js";

function sameRuntime(a: HermesPythonRuntime, b: HermesPythonRuntime): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.launcher === b.launcher;
}

/** Environment keys that change which gateway the bridge attaches to, or what it preloads. */
const ENVIRONMENT_IDENTITY_KEYS = ["HERMES_HOME", "HERMES_TUI_SKILLS"] as const;

function environmentIdentity(environment: NodeJS.ProcessEnv): string {
  return ENVIRONMENT_IDENTITY_KEYS.map((key) => `${key}=${environment[key] ?? ""}`).join("\u0000");
}

/** A warm bridge only serves opens that would spawn an identical bridge. */
function sameBridge(
  transport: HermesGatewayTransport,
  runtime: HermesPythonRuntime,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): boolean {
  return (
    sameRuntime(transport.runtime, runtime) &&
    transport.cwd === cwd &&
    environmentIdentity(transport.environment) === environmentIdentity(environment)
  );
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
 * Reuse is keyed by everything a bridge bakes in at spawn time: the runtime
 * (launcher/python), the process cwd, and the environment identities that
 * steer attachment and preloading (a different HERMES_HOME attaches to a
 * different gateway profile; different skills preload a different delegation
 * payload). Session cwd itself is a `session.create` parameter, but the
 * bridge process still runs where it was spawned, so opens in another
 * directory get their own bridge.
 */
export class GatewayTransportPool {
  #idle: HermesGatewayTransport[] = [];
  #capacity: number;
  #closed = false;
  constructor(capacity = 2) {
    this.#capacity = Math.max(1, capacity);
  }
  /** A healthy started bridge equivalent to a fresh spawn for these inputs, or null. */
  acquire(
    runtime: HermesPythonRuntime,
    cwd: string,
    environment: NodeJS.ProcessEnv,
  ): HermesGatewayTransport | null {
    while (this.#idle.length > 0) {
      const index = this.#idle.findIndex((transport) =>
        sameBridge(transport, runtime, cwd, environment),
      );
      const transport = index >= 0 ? this.#idle.splice(index, 1)[0] : undefined;
      if (transport === undefined) return null;
      if (!transport.closed && transport.started) return transport;
      void transport.close().catch(() => undefined);
    }
    return null;
  }
  /** Return a bridge after its session settled; unhealthy or late ones are discarded. */
  release(transport: HermesGatewayTransport): void {
    if (transport.closed || this.#closed || this.#idle.length >= this.#capacity) {
      void transport.close().catch(() => undefined);
      return;
    }
    this.#idle.push(transport);
  }
  async close(): Promise<void> {
    this.#closed = true;
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
