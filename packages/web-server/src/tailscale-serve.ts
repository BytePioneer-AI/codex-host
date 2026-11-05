/** Tailscale diagnostics and explicitly confirmed Serve changes. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { WebTailscaleState } from "@codexhost/shared-contracts";
import { z } from "zod";

const exec = promisify(execFile);
const STATUS_TIMEOUT_MS = 3_000;
const LOOPBACK_TARGETS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** The macOS app does not always install a `tailscale` command on PATH. */
const CLI_CANDIDATES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
const statusSchema = z.object({
  BackendState: z.string(),
  Self: z
    .object({ CapMap: z.record(z.string(), z.unknown()).optional() })
    .nullable()
    .optional(),
});
const serveStatusSchema = z
  .object({
    TCP: z.record(z.string(), z.object({ HTTPS: z.boolean().optional() })).optional(),
    Web: z
      .record(
        z.string(),
        z.object({
          Handlers: z
            .record(
              z.string(),
              z.object({
                Proxy: z.string().optional(),
                Path: z.string().optional(),
                Text: z.string().optional(),
              }),
            )
            .optional(),
        }),
      )
      .optional(),
    AllowFunnel: z.record(z.string(), z.boolean()).optional(),
  })
  .nullable();

function forwardsTo(proxy: string | undefined, port: number): boolean {
  if (proxy === undefined || !URL.canParse(proxy)) return false;
  const target = new URL(proxy);
  return (
    target.protocol === "http:" &&
    LOOPBACK_TARGETS.has(target.hostname) &&
    Number(target.port || 80) === port &&
    target.pathname === "/"
  );
}

/** Tries the next candidate only when one is not installed. */
async function run(args: string[], candidates: readonly string[]): Promise<string> {
  let missing: Error | undefined;
  for (const command of candidates) {
    try {
      const { stdout } = await exec(command, args, { timeout: STATUS_TIMEOUT_MS });
      return stdout;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing = error as Error;
    }
  }
  throw missing;
}

async function readJson(args: string[], candidates: readonly string[]): Promise<unknown> {
  return JSON.parse(await run(args, candidates));
}

function failure(error: unknown): WebTailscaleState {
  return (error as NodeJS.ErrnoException).code === "ENOENT"
    ? { status: "not-installed" }
    : { status: "error", message: (error as Error).message };
}

/** An HTTPS root forwarding here supplies the address and loopback proxy trust. */
export async function tailscaleServeState(
  port: number,
  candidates: readonly string[] = CLI_CANDIDATES,
): Promise<WebTailscaleState> {
  try {
    const status = serveStatusSchema.parse(
      await readJson(["serve", "status", "--json"], candidates),
    );
    let occupied: string | undefined;
    for (const [hostPort, web] of Object.entries(status?.Web ?? {})) {
      const separator = hostPort.lastIndexOf(":");
      const servePort = hostPort.slice(separator + 1);
      const root = web.Handlers?.["/"];
      if (root === undefined) continue;
      if (status?.TCP?.[servePort]?.HTTPS === true && forwardsTo(root.Proxy, port)) {
        const host = hostPort.slice(0, separator);
        return {
          status: "serving",
          url: servePort === "443" ? `https://${host}/` : `https://${host}:${servePort}/`,
          funnel: status.AllowFunnel?.[hostPort] === true,
        };
      }
      if (servePort === "443") {
        occupied = root.Proxy ?? root.Path ?? root.Text ?? JSON.stringify(root);
      }
    }
    if (occupied !== undefined) return { status: "occupied", target: occupied };
    return {
      status: "not-serving",
      command: `tailscale serve --bg http://127.0.0.1:${String(port)}`,
    };
  } catch (error) {
    return failure(error);
  }
}

/** Re-read before writing: --bg otherwise replaces an existing root without asking. */
export async function setTailscaleServe(
  port: number,
  enabled: boolean,
): Promise<{ state: WebTailscaleState; error?: string }> {
  const before = await tailscaleState(port);
  if (enabled ? before.status !== "not-serving" : before.status !== "serving") {
    return { state: before, error: "Tailscale status changed; no configuration was modified." };
  }
  const servePort = before.status === "serving" ? new URL(before.url).port || "443" : "443";
  let error: string | undefined;
  try {
    await run(
      enabled
        ? ["serve", "--bg", `http://127.0.0.1:${String(port)}`]
        : ["serve", `--https=${servePort}`, "--set-path=/", "off"],
      CLI_CANDIDATES,
    );
  } catch (cause) {
    error = (cause as Error).message;
  }
  const state = await tailscaleState(port);
  // A successful CLI exit does not mean HTTPS provisioning wrote the configuration.
  const applied = enabled
    ? state.status === "serving"
    : state.status === "not-serving" ||
      state.status === "occupied" ||
      (state.status === "serving" && before.status === "serving" && state.url !== before.url);
  return applied
    ? { state }
    : { state, error: error ?? "Tailscale Serve configuration did not take effect." };
}

/** Full diagnostics for startup and the connection page, bounded to three seconds. */
export async function tailscaleState(
  port: number,
  candidates: readonly string[] = CLI_CANDIDATES,
): Promise<WebTailscaleState> {
  try {
    const [raw, serve] = await Promise.all([
      readJson(["status", "--json"], candidates),
      tailscaleServeState(port, candidates),
    ]);
    const status = statusSchema.parse(raw);
    if (status.BackendState === "NeedsLogin") return { status: "not-logged-in" };
    if (status.BackendState !== "Running") return { status: "not-running" };
    if (status.Self?.CapMap?.https === undefined) return { status: "https-disabled" };
    return serve;
  } catch (error) {
    return failure(error);
  }
}
