import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, join } from "node:path";
import { discoverHostClientChannel } from "./host-client-channel.js";
import type { ClientChannelDescriptor } from "@codexhost/shared-contracts";

export interface HostServiceLaunch {
  launcher: string;
  runtime: string;
  dataDirectory: string;
  node?: string;
  bundledPlugins?: string;
  codexHome?: string;
  stockCodex?: string;
}

/** PID presence alone is not liveness: a descriptor may outlive its original PID. */
export async function isHostClientChannelOnline(
  descriptor: ClientChannelDescriptor,
): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${descriptor.port}/v1/events`, {
      headers: { authorization: `Bearer ${descriptor.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return false;
    }
    const reader = response.body.getReader();
    try {
      let buffer = "";
      const decoder = new TextDecoder();
      while (buffer.length < 4096) {
        const part = await reader.read();
        if (part.done) return false;
        buffer += decoder.decode(part.value, { stream: true });
        const line = buffer.split("\n").find((entry) => entry.trim());
        if (buffer.includes("\n") && line) {
          const hello = JSON.parse(line) as { type?: string; cursor?: { epoch?: string } };
          return hello.type === "hello" && hello.cursor?.epoch === descriptor.epoch;
        }
      }
      return false;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  } catch {
    return false;
  }
}

/** Native Launcher owns detachment; callers never spawn a second Adapter or store. */
export async function ensureHostService(options: HostServiceLaunch): Promise<void> {
  const directory = join(options.dataDirectory, "client-hosts");
  const existing = await discoverHostClientChannel(directory);
  const online = existing && (await isHostClientChannelOnline(existing));
  if (existing?.owner === "service" && online) return;
  if (existing && online)
    throw new Error(
      "A Desktop-owned CH Host is still running. Update and restart Desktop before enabling the independent Host; it will not be taken over.",
    );
  const args = ["host", "ensure"];
  for (const [flag, value] of [
    ["--node", options.node ?? process.execPath],
    ["--host-runtime", options.runtime],
    ["--data", options.dataDirectory],
    ["--plugins", options.bundledPlugins],
    ["--codex-home", options.codexHome],
    ["--stock-codex", options.stockCodex],
  ]) {
    if (value === undefined) continue;
    if (!isAbsolute(value)) throw new Error(`Shared Host ${flag} must be an absolute path`);
    args.push(flag as string, value);
  }
  if (!isAbsolute(options.launcher))
    throw new Error("Shared Host Launcher must be an absolute path");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.toUpperCase().startsWith("CODEXHOST_") &&
        !["NODE_OPTIONS", "NODE_PATH"].includes(key.toUpperCase()),
    ),
  );
  await promisify(execFile)(options.launcher, args, {
    env,
    timeout: 45_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  const ready = await discoverHostClientChannel(directory);
  if (ready?.owner !== "service" || !(await isHostClientChannelOnline(ready)))
    throw new Error("Independent CH Host did not publish a ready authenticated endpoint");
}
