import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { DataDir } from "./store.ts";
import { RequestTrust } from "./request-trust.ts";

export const SETTINGS_CHANGED_EXIT_CODE = 42;

const serviceSchema = z.object({
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(4400),
  publicUrl: z
    .string()
    .transform((value) => {
      publicAccessUrl(value);
      return value;
    })
    .optional(),
  relayHost: z.string().optional(),
  relayEnabled: z.boolean().default(false),
  relayName: z.string().optional(),
  relayInvite: z.string().optional(),
  relayHostname: z.string().optional(),
  trustedProxies: z
    .string()
    .transform((value) => {
      new RequestTrust(value);
      return value;
    })
    .optional(),
});

export function publicAccessUrl(value: string): string {
  if (!URL.canParse(value) || !/^https?:\/\/[^\\/?#]+\/?$/iu.test(value)) {
    throw new Error(
      "--public-url: only an http or https site root is supported (no path, query or fragment)",
    );
  }
  const url = new URL(value);
  if (url.username !== "" || url.password !== "") {
    throw new Error("--public-url: user information is not allowed");
  }
  return url.href;
}

export function readServiceOptions(data: DataDir) {
  const file = data.path("service.json");
  return serviceSchema.parse(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
}

/** Empty options clear saved values; validation precedes the atomic replacement. */
export function saveServiceOptions(
  data: DataDir,
  options: {
    host?: string;
    port?: string;
    "public-url"?: string;
    "trusted-proxy"?: string;
    relay?: string;
  },
): boolean {
  const file = data.path("service.json");
  const saved: Record<string, unknown> = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : {};
  const next = { ...saved };
  for (const [option, field] of [
    ["host", "host"],
    ["port", "port"],
    ["public-url", "publicUrl"],
    ["relay", "relayHost"],
    ["trusted-proxy", "trustedProxies"],
  ] as const) {
    const value = options[option];
    if (value === undefined) continue;
    if (value === "") Reflect.deleteProperty(next, field);
    else next[field] = option === "port" ? Number(value) : value;
  }
  if (next.relayHost !== saved.relayHost) Reflect.deleteProperty(next, "relayHostname");
  const result = serviceSchema.safeParse(next);
  if (!result.success) throw new Error(z.prettifyError(result.error));
  const validated = result.data;
  if (isDeepStrictEqual(serviceSchema.parse(saved), validated)) return false;
  data.writeJson("service.json", validated, { mode: 0o600 });
  return true;
}
