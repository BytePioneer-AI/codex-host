/** Tailscale Serve addresses that already forward to this server; Serve is never configured here. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { WebNetworkAccessUrl } from "@codexhost/shared-contracts";
import { z } from "zod";

import { isLoopbackHost, isWildcardHost } from "./network-urls.ts";

const exec = promisify(execFile);
const STATUS_TIMEOUT_MS = 3_000;
const LOOPBACK_TARGETS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** The macOS app does not always install a `tailscale` command on PATH. */
const CLI_CANDIDATES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

const serveStatusSchema = z.object({
  TCP: z.record(z.string(), z.object({ HTTPS: z.boolean().optional() })).optional(),
  Web: z
    .record(
      z.string(),
      z.object({
        Handlers: z.record(z.string(), z.object({ Proxy: z.string().optional() })).optional(),
      }),
    )
    .optional(),
});

function forwardsTo(proxy: string | undefined, port: number): boolean {
  if (proxy === undefined || !URL.canParse(proxy)) return false;
  const target = new URL(proxy);
  return (
    target.protocol === "http:" &&
    LOOPBACK_TARGETS.has(target.hostname) &&
    target.port === String(port) &&
    target.pathname === "/"
  );
}

/**
 * @param status - the parsed output of `tailscale serve status --json`.
 * @param port - this server's listening port.
 * @returns the HTTPS addresses whose root forwards to this server.
 */
export function serveUrlsFromStatus(status: unknown, port: number): string[] {
  const parsed = serveStatusSchema.safeParse(status);
  if (!parsed.success) return [];
  return Object.entries(parsed.data.Web ?? {}).flatMap(([hostPort, web]) => {
    const separator = hostPort.lastIndexOf(":");
    const servePort = hostPort.slice(separator + 1);
    if (parsed.data.TCP?.[servePort]?.HTTPS !== true) return [];
    if (!forwardsTo(web.Handlers?.["/"]?.Proxy, port)) return [];
    const host = hostPort.slice(0, separator);
    return [servePort === "443" ? `https://${host}/` : `https://${host}:${servePort}/`];
  });
}

/**
 * @param host - the listening address; Serve forwards over loopback, so a specific interface is unreachable.
 * @param port - the listening port.
 * @param candidates - the Tailscale commands to try.
 * @returns this server's Serve addresses; empty when Tailscale is absent, stopped, or not forwarding here.
 */
export async function tailscaleServeAccessUrls(
  host: string,
  port: number,
  candidates: readonly string[] = CLI_CANDIDATES,
): Promise<WebNetworkAccessUrl[]> {
  if (!isWildcardHost(host) && !isLoopbackHost(host)) return [];
  for (const command of candidates) {
    try {
      const { stdout } = await exec(command, ["serve", "status", "--json"], {
        timeout: STATUS_TIMEOUT_MS,
      });
      return serveUrlsFromStatus(JSON.parse(stdout), port).map((url) => ({
        kind: "tailscale-https",
        url,
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return [];
    }
  }
  return [];
}
