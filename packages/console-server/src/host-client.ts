import { readdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";

import {
  harnessInstallationRequestTimeoutMs,
  updateCheckResultSchema,
  updateStartResultSchema,
  updateStatusResultSchema,
} from "@codexhost/shared-contracts";
import type { ConsoleUpdates } from "./updates.js";

import { processIsAlive } from "./diagnostics.js";

const DESCRIPTOR_PATTERN = /^host-\d{1,10}\.json$/u;
const DESCRIPTOR_MAX_BYTES = 4 * 1024;

export type HostReply = { result: unknown } | { error: { code: number; message: string } };

export interface HostEndpoint {
  pid: number;
  port: number;
  token: string;
  startedAt: number;
  runtimePath?: string;
}

export class HostUnavailableError extends Error {
  constructor() {
    super("Codex Desktop with codexhost is not running");
    this.name = "HostUnavailableError";
  }
}

function parseDescriptor(value: unknown): HostEndpoint | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.pid !== "number" ||
    typeof record.port !== "number" ||
    typeof record.token !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.token) ||
    typeof record.startedAt !== "number"
  ) {
    return null;
  }
  return {
    pid: record.pid,
    port: record.port,
    token: record.token,
    startedAt: record.startedAt,
    ...(typeof record.runtimePath === "string" && path.isAbsolute(record.runtimePath)
      ? { runtimePath: record.runtimePath }
      : {}),
  };
}

/**
 * The newest live local Host that published a console channel. Descriptors
 * left by exited Hosts are removed.
 */
export async function findHost(
  descriptorDirectory: string,
  isAlive: (pid: number) => boolean = processIsAlive,
): Promise<HostEndpoint | null> {
  let names: string[];
  try {
    names = await readdir(descriptorDirectory);
  } catch {
    return null;
  }
  const hosts: HostEndpoint[] = [];
  for (const name of names.filter((candidate) => DESCRIPTOR_PATTERN.test(candidate))) {
    const filePath = path.join(descriptorDirectory, name);
    try {
      const text = await readFile(filePath, "utf8");
      if (text.length > DESCRIPTOR_MAX_BYTES) continue;
      const endpoint = parseDescriptor(JSON.parse(text));
      if (!endpoint) continue;
      if (isAlive(endpoint.pid)) hosts.push(endpoint);
      else await rm(filePath, { force: true });
    } catch {
      continue;
    }
  }
  return hosts.sort((left, right) => right.startedAt - left.startedAt)[0] ?? null;
}

export interface ConsoleHostClient {
  displayEvents?(signal: AbortSignal): Promise<Response>;
  available(): Promise<boolean>;
  request(method: string, params: unknown): Promise<HostReply>;
}

export function createConsoleHostClient(
  descriptorDirectory: string,
  options: {
    isAlive?: (pid: number) => boolean;
    timeoutMs?: number;
    updateAppDirectory?: string;
  } = {},
): ConsoleHostClient {
  const timeoutMs = options.timeoutMs ?? 150_000;
  return {
    async displayEvents(signal) {
      const host = await findHost(descriptorDirectory, options.isAlive);
      if (!host) throw new HostUnavailableError();
      return fetch(`http://127.0.0.1:${host.port}/display-events`, {
        headers: { authorization: `Bearer ${host.token}` },
        signal,
      });
    },
    async available() {
      return (await findHost(descriptorDirectory, options.isAlive)) !== null;
    },
    async request(method, params) {
      const host = await findHost(descriptorDirectory, options.isAlive);
      if (!host) throw new HostUnavailableError();
      if (method.startsWith("codexhost/update/") && options.updateAppDirectory) {
        if (!host.runtimePath)
          throw new Error(
            "The running Host does not identify its installation; restart it before updating",
          );
        const [hostDirectory, requestedDirectory] = await Promise.all([
          realpath(path.dirname(host.runtimePath)),
          realpath(options.updateAppDirectory),
        ]).catch(() => {
          throw new Error("The running Host installation could not be verified");
        });
        if (hostDirectory !== requestedDirectory)
          throw new Error("The running Host belongs to a different codexhost installation");
      }
      const response = await fetch(`http://127.0.0.1:${host.port}/rpc`, {
        method: "POST",
        headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
        body: JSON.stringify({ method, params: params ?? {} }),
        signal: AbortSignal.timeout(
          Math.max(
            timeoutMs,
            method === "codexhost/remote/ssh-setup" ? 330_000 : 0,
            harnessInstallationRequestTimeoutMs(method, params) ?? 0,
          ),
        ),
      });
      const body = (await response.json().catch(() => null)) as HostReply | null;
      if (!body || (!("result" in body) && !("error" in body))) {
        return {
          error: { code: -32603, message: `Host channel returned HTTP ${response.status}` },
        };
      }
      return body;
    },
  };
}

export function createHostUpdates(host: ConsoleHostClient): ConsoleUpdates {
  const request = async (method: string): Promise<unknown> => {
    const reply = await host.request(method, {});
    if ("error" in reply) throw new Error(reply.error.message);
    if (reply.result === null)
      throw new Error("Application updates are unavailable on the running Host");
    return reply.result;
  };
  return {
    check: async () => updateCheckResultSchema.parse(await request("codexhost/update/check")),
    start: async () => updateStartResultSchema.parse(await request("codexhost/update/start")),
    status: async () => updateStatusResultSchema.parse(await request("codexhost/update/status")),
  };
}
