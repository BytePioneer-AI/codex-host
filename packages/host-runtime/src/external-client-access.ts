import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExternalClientServer } from "./external-client-server.js";
import { codexhostDataDirectory, type ClientNetwork } from "./external-clients.js";
import { FUNNEL_PATH, type TailscaleControl } from "./tailscale.js";

const RECONCILE_INTERVAL_MS = 30_000;

/** Whether the tailnet and public listeners should run; both are off until the user turns them on. */
export interface ExternalAccessSettings {
  tailnet: boolean;
  public: boolean;
}

export interface ListenerStatus {
  state: "off" | "on" | "unavailable";
  endpoint?: string;
  /** Public only: the URL hosted MCP connectors use. */
  mcpUrl?: string;
  reason?: string;
}

export interface ExternalAccessStatus {
  tailnet: ListenerStatus;
  public: ListenerStatus;
  updatedAt: string;
}

export function externalAccessPaths(environment: NodeJS.ProcessEnv): {
  settings: string;
  status: string;
} {
  const directory = codexhostDataDirectory(environment);
  return {
    settings: path.join(directory, "external-client-access.json"),
    status: path.join(directory, "external-client-access-status.json"),
  };
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readAccessSettings(filePath: string): Promise<ExternalAccessSettings> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as Partial<ExternalAccessSettings>;
    return { tailnet: value.tailnet === true, public: value.public === true };
  } catch {
    return { tailnet: false, public: false };
  }
}

export async function writeAccessSettings(
  filePath: string,
  settings: ExternalAccessSettings,
): Promise<void> {
  await writePrivateJson(filePath, { formatVersion: 1, ...settings });
}

export async function readAccessStatus(
  filePath: string,
): Promise<ExternalAccessStatus | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as ExternalAccessStatus;
  } catch {
    return undefined;
  }
}

type StartListener = (options: {
  network: ClientNetwork;
  host: string;
  port: number;
  publicBaseUrl?: () => string | undefined;
}) => Promise<ExternalClientServer | undefined>;

/**
 * Keeps the tailnet and public listeners in line with the settings file and
 * Tailscale: starts, rebinds after an address change, or stops them. The
 * public listener is a separate loopback port that only the Funnel forwards
 * to, so requests through it can never pass as local.
 */
export class ExternalAccessSupervisor {
  readonly #settingsPath: string;
  readonly #statusPath: string;
  readonly #tailscale: TailscaleControl;
  readonly #start: StartListener;
  readonly #port: number;
  readonly #diagnose: (message: string) => void;
  #tailnet: { server: ExternalClientServer; address: string } | undefined;
  #public: ExternalClientServer | undefined;
  #publicBaseUrl: string | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> = Promise.resolve();
  #closed = false;
  /** Whether a Funnel mapping of ours may exist and should be removed when public is off. */
  #funnelMayExist: boolean | undefined;

  constructor(options: {
    settingsPath: string;
    statusPath: string;
    tailscale: TailscaleControl;
    start: StartListener;
    /** The local listener's port, reused on the tailnet address. */
    port: number;
    diagnose?: (message: string) => void;
  }) {
    this.#settingsPath = options.settingsPath;
    this.#statusPath = options.statusPath;
    this.#tailscale = options.tailscale;
    this.#start = options.start;
    this.#port = options.port;
    this.#diagnose = options.diagnose ?? (() => undefined);
  }

  /** Reconciles now and then periodically. */
  start(): Promise<void> {
    const first = this.reconcile();
    const loop = () => {
      if (this.#closed) return;
      this.#timer = setTimeout(() => {
        void this.reconcile().finally(loop);
      }, RECONCILE_INTERVAL_MS);
      this.#timer.unref?.();
    };
    void first.finally(loop);
    return first;
  }

  /** One pass; passes never overlap. */
  reconcile(): Promise<void> {
    this.#running = this.#running
      .then(() => this.#reconcile())
      .catch((error: unknown) => {
        this.#diagnose(`access: ${error instanceof Error ? error.message : String(error)}`);
      });
    return this.#running;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#running;
    await this.#tailnet?.server.close();
    this.#tailnet = undefined;
    // Remove the Funnel mapping before releasing its ephemeral port, so public traffic never
    // reaches whatever binds that port next. If removal fails, the next Runtime still
    // re-points or removes the mapping it finds.
    if (this.#funnelMayExist) {
      try {
        await this.#removeFunnel();
        this.#funnelMayExist = false;
      } catch (error) {
        this.#diagnose(
          `access: Funnel ${FUNNEL_PATH} was not removed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await this.#public?.close();
    this.#public = undefined;
  }

  async #reconcile(): Promise<void> {
    if (this.#closed) return;
    // A previous Runtime that had public access on may have left its mapping behind.
    this.#funnelMayExist ??= (await readAccessStatus(this.#statusPath))?.public.state === "on";
    const settings = await readAccessSettings(this.#settingsPath);
    const tailscale =
      settings.tailnet || settings.public ? await this.#tailscale.state() : undefined;
    const status: ExternalAccessStatus = {
      tailnet: await this.#reconcileTailnet(settings.tailnet, tailscale),
      public: await this.#reconcilePublic(settings.public, tailscale),
      updatedAt: new Date().toISOString(),
    };
    await writePrivateJson(this.#statusPath, status).catch(() => undefined);
  }

  async #reconcileTailnet(
    wanted: boolean,
    tailscale: Awaited<ReturnType<TailscaleControl["state"]>> | undefined,
  ): Promise<ListenerStatus> {
    const address = wanted && tailscale?.running ? tailscale.address : undefined;
    if (this.#tailnet && this.#tailnet.address !== address) {
      await this.#tailnet.server.close();
      this.#tailnet = undefined;
    }
    if (!wanted) return { state: "off" };
    if (!address)
      return { state: "unavailable", reason: tailscale?.reason ?? "Tailscale has no address" };
    if (!this.#tailnet) {
      const server = await this.#start({ network: "tailnet", host: address, port: this.#port });
      if (!server) return { state: "unavailable", reason: `${address}:${this.#port} is in use` };
      this.#tailnet = { server, address };
      this.#diagnose(`tailnet listener on ${server.endpoint}`);
    }
    return { state: "on", endpoint: this.#tailnet.server.endpoint };
  }

  async #reconcilePublic(
    wanted: boolean,
    tailscale: Awaited<ReturnType<TailscaleControl["state"]>> | undefined,
  ): Promise<ListenerStatus> {
    if (!wanted) {
      if (this.#funnelMayExist) {
        await this.#removeFunnel();
        this.#funnelMayExist = false;
      }
      await this.#public?.close();
      this.#public = undefined;
      this.#publicBaseUrl = undefined;
      return { state: "off" };
    }
    if (!tailscale?.running || !tailscale.dnsName)
      return { state: "unavailable", reason: tailscale?.reason ?? "Tailscale has no DNS name" };
    const base = `https://${tailscale.dnsName}${FUNNEL_PATH}`;
    this.#publicBaseUrl = base;
    this.#public ??= await this.#start({
      network: "public",
      host: "127.0.0.1",
      port: 0,
      publicBaseUrl: () => this.#publicBaseUrl,
    });
    if (!this.#public) return { state: "unavailable", reason: "The public listener did not start" };
    const target = this.#public.endpoint;
    try {
      const funnel = await this.#tailscale.funnel();
      const current = funnel.target;
      if (current !== undefined && !isLoopbackTarget(current))
        return {
          state: "unavailable",
          reason: `${FUNNEL_PATH} is already mapped to ${current}; codexhost does not replace it`,
        };
      this.#funnelMayExist = true;
      if (current !== target || funnel.complete === false) {
        await this.#tailscale.setFunnel(target);
        this.#diagnose(`Funnel ${FUNNEL_PATH} → ${target}`);
      }
    } catch (error) {
      return {
        state: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return { state: "on", endpoint: base, mcpUrl: `${base}/mcp` };
  }

  /** Removes the mapping only when it points at a loopback port, as codexhost sets it. */
  async #removeFunnel(): Promise<void> {
    let current: string | undefined;
    try {
      current = (await this.#tailscale.funnel()).target;
    } catch {
      return;
    }
    if (current !== undefined && isLoopbackTarget(current)) {
      await this.#tailscale.clearFunnel();
      this.#diagnose(`Funnel ${FUNNEL_PATH} removed`);
    }
  }
}

function isLoopbackTarget(target: string): boolean {
  try {
    return new URL(target).hostname === "127.0.0.1";
  } catch {
    return false;
  }
}
