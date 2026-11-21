import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

const COMMAND_TIMEOUT_MS = 15_000;
/** codexhost's own Funnel paths; nothing else under the Funnel is touched. */
export const FUNNEL_PATH = "/codexhost";
export const FUNNEL_PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource/codexhost/mcp";
export const FUNNEL_AUTH_SERVER_PATH = "/.well-known/oauth-authorization-server/codexhost";

export interface TailscaleState {
  running: boolean;
  /** This machine's tailnet IPv4 address, when Tailscale is up. */
  address?: string;
  /** MagicDNS name without the trailing dot, used for the Funnel URL. */
  dnsName?: string;
  reason?: string;
}

export interface FunnelMapping {
  /** Where the codexhost path is proxied to, or undefined when it is not mapped. */
  target?: string;
  /** Whether the companion OAuth `.well-known` Funnel paths are also mapped to `target`. */
  complete?: boolean;
}

/** The Tailscale operations codexhost needs; injected so tests do not need Tailscale. */
export interface TailscaleControl {
  state(): Promise<TailscaleState>;
  funnel(): Promise<FunnelMapping>;
  setFunnel(target: string): Promise<void>;
  clearFunnel(): Promise<void>;
}

type Run = (args: string[]) => Promise<string>;

const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

function tailscaleCommand(environment: NodeJS.ProcessEnv): string {
  if (environment.CODEXHOST_TAILSCALE) return environment.CODEXHOST_TAILSCALE;
  // The Mac App Store build ships its CLI inside the app instead of on PATH.
  return process.platform === "darwin" && existsSync(MAC_APP_CLI) ? MAC_APP_CLI : "tailscale";
}

function runner(command: string): Run {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        { timeout: COMMAND_TIMEOUT_MS, windowsHide: true },
        (error, stdout, stderr) => {
          if (error)
            reject(
              new Error(
                `${["tailscale", ...args].join(" ")}: ${String(stderr || error.message).trim()}`,
              ),
            );
          else resolve(stdout);
        },
      );
    });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseTailscaleStatus(text: string): TailscaleState {
  const status = record(JSON.parse(text));
  const self = record(status?.Self);
  if (status?.BackendState !== "Running")
    return {
      running: false,
      reason: `Tailscale is ${String(status?.BackendState ?? "not running")}`,
    };
  const addresses = Array.isArray(self?.TailscaleIPs) ? (self.TailscaleIPs as unknown[]) : [];
  const address = addresses.find(
    (value): value is string => typeof value === "string" && !value.includes(":"),
  );
  const dnsName = typeof self?.DNSName === "string" ? self.DNSName.replace(/\.$/u, "") : undefined;
  return {
    running: true,
    ...(address ? { address } : { reason: "Tailscale has no IPv4 address for this machine" }),
    ...(dnsName ? { dnsName } : {}),
  };
}

/** Finds the proxy target of codexhost's path in `tailscale funnel status --json`. */
export function parseFunnelStatus(text: string): FunnelMapping {
  const web = record(record(text.trim() ? JSON.parse(text) : {})?.Web) ?? {};
  for (const host of Object.values(web)) {
    const handlers = record(record(host)?.Handlers);
    const handler = record(handlers?.[FUNNEL_PATH]);
    if (typeof handler?.Proxy === "string") {
      const target = handler.Proxy;
      const complete =
        record(handlers?.[FUNNEL_PROTECTED_RESOURCE_PATH])?.Proxy ===
          `${target}/.well-known/oauth-protected-resource` &&
        record(handlers?.[FUNNEL_AUTH_SERVER_PATH])?.Proxy ===
          `${target}/.well-known/oauth-authorization-server`;
      return { target, complete };
    }
  }
  return {};
}

export function createTailscaleControl(
  environment: NodeJS.ProcessEnv,
  run?: Run,
): TailscaleControl {
  const tailscale = run ?? runner(tailscaleCommand(environment));
  return {
    async state() {
      try {
        return parseTailscaleStatus(await tailscale(["status", "--json"]));
      } catch (error) {
        return { running: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    async funnel() {
      return parseFunnelStatus(await tailscale(["funnel", "status", "--json"]));
    },
    async setFunnel(target) {
      await tailscale(["funnel", "--bg", `--set-path=${FUNNEL_PATH}`, target]);
      await tailscale([
        "funnel",
        "--bg",
        `--set-path=${FUNNEL_PROTECTED_RESOURCE_PATH}`,
        `${target}/.well-known/oauth-protected-resource`,
      ]);
      await tailscale([
        "funnel",
        "--bg",
        `--set-path=${FUNNEL_AUTH_SERVER_PATH}`,
        `${target}/.well-known/oauth-authorization-server`,
      ]);
    },
    async clearFunnel() {
      await tailscale(["funnel", `--set-path=${FUNNEL_PATH}`, "off"]);
      await tailscale(["funnel", `--set-path=${FUNNEL_PROTECTED_RESOURCE_PATH}`, "off"]).catch(
        () => undefined,
      );
      await tailscale(["funnel", `--set-path=${FUNNEL_AUTH_SERVER_PATH}`, "off"]).catch(
        () => undefined,
      );
    },
  };
}
