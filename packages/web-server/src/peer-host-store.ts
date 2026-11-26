import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { isIP, isIPv4 } from "node:net";
import { z } from "zod";
import type { DataDir } from "./store.ts";
import {
  remotePeerColorSchema,
  remotePeerIdSchema,
  remotePeerNodeIdSchema,
  type RemotePeerAddParams,
  type RemotePeerColor,
  type RemotePeerTransportKind,
} from "@codexhost/shared-contracts";

export interface PeerRecord {
  peerId: string;
  /** Last verified identity, for matching an introduction while this record is disabled or offline. */
  nodeId?: string | undefined;
  name: string;
  color?: RemotePeerColor | undefined;
  origin: string;
  token: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

const peerRecordSchema = z.object({
  peerId: remotePeerIdSchema,
  nodeId: remotePeerNodeIdSchema.optional(),
  name: z.string().min(1).max(120),
  color: remotePeerColorSchema.optional(),
  origin: z.string().min(1).max(2048),
  token: z.string().min(1).max(2048),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export interface ParseConnectionLinkOptions {
  /** Allow loopback origins (`localhost`, `127.0.0.0/8`, `[::1]`). Disabled by default to block SSRF. */
  allowLoopback?: boolean;
  /** Skip SSRF host validation (used only for classifying already-persisted peer summaries). */
  skipHostPolicy?: boolean;
}

export interface PeerResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type PeerDnsLookup = (hostname: string) => Promise<readonly PeerResolvedAddress[]>;

/** Raised when a peer URL or its DNS-resolved IP violates SSRF / loopback policy. */
export class PeerHostPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerHostPolicyError";
  }
}

function unbracket(hostname: string): string {
  const raw =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname.replace(/\.$/u, "");
  const zoneIndex = raw.indexOf("%");
  return (zoneIndex >= 0 ? raw.slice(0, zoneIndex) : raw).toLowerCase();
}

function decodeIpv4MappedIpv6(bare: string): string | undefined {
  if (!bare.startsWith("::ffff:")) return undefined;
  const suffix = bare.slice("::ffff:".length);
  if (isIPv4(suffix)) return suffix;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(suffix);
  const hiHex = hex?.[1];
  const loHex = hex?.[2];
  if (!hiHex || !loHex) return undefined;
  const hi = Number.parseInt(hiHex, 16);
  const lo = Number.parseInt(loHex, 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isLoopbackHost(hostname: string): boolean {
  const bare = unbracket(hostname);
  if (
    bare === "localhost" ||
    bare.endsWith(".localhost") ||
    bare === "::1" ||
    bare === "0:0:0:0:0:0:0:1"
  ) {
    return true;
  }
  const ipv4 = decodeIpv4MappedIpv6(bare) ?? (isIPv4(bare) ? bare : undefined);
  return ipv4 !== undefined && ipv4.startsWith("127.");
}

function isBlockedMetadataOrUnspecifiedHost(hostname: string): boolean {
  const bare = unbracket(hostname);
  if (
    bare === "metadata.google.internal" ||
    bare === "metadata.goog" ||
    bare === "instance-data" ||
    bare === "fd00:ec2::254" ||
    bare === "::" ||
    bare === "0:0:0:0:0:0:0:0"
  ) {
    return true;
  }
  // IPv6 link-local (fe80::/10)
  if (/^fe[89ab][0-9a-f]:/iu.test(bare)) return true;
  const ipv4 = decodeIpv4MappedIpv6(bare) ?? (isIPv4(bare) ? bare : undefined);
  if (ipv4 !== undefined) {
    // 0.0.0.0/8 (unspecified) and 169.254.0.0/16 (link-local & cloud metadata)
    if (ipv4.startsWith("0.") || ipv4.startsWith("169.254.")) return true;
  }
  return false;
}

export function assertAllowedPeerHost(
  hostname: string,
  options: Pick<ParseConnectionLinkOptions, "allowLoopback"> = {},
): void {
  if (isBlockedMetadataOrUnspecifiedHost(hostname))
    throw new PeerHostPolicyError("Peer host address is not allowed");
  if (!options.allowLoopback && isLoopbackHost(hostname))
    throw new PeerHostPolicyError("Loopback peer addresses are not allowed");
}

/** Resolve non-IP hostnames via DNS and validate every returned address against the host policy. */
export async function resolveAndValidatePeerHost(
  url: URL,
  options: Pick<ParseConnectionLinkOptions, "allowLoopback"> & {
    dnsLookup?: PeerDnsLookup | undefined;
  } = {},
): Promise<PeerResolvedAddress[]> {
  assertAllowedPeerHost(url.hostname, options);
  const bare = unbracket(url.hostname);
  const literalFamily = isIP(bare);
  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: bare, family: literalFamily }];
  }
  const lookup =
    options.dnsLookup ??
    (async (host: string) => {
      const entries = await dnsLookup(host, { all: true, verbatim: true });
      return entries.map((entry) => ({
        address: entry.address,
        family: entry.family === 6 ? (6 as const) : (4 as const),
      }));
    });
  const resolved = await lookup(bare);
  if (resolved.length === 0) {
    throw Error("Peer host address could not be resolved");
  }
  const verified: PeerResolvedAddress[] = [];
  for (const entry of resolved) {
    const family = typeof entry?.address === "string" ? isIP(entry.address) : 0;
    if (family !== 4 && family !== 6) {
      throw new PeerHostPolicyError("Peer host address is not allowed");
    }
    assertAllowedPeerHost(entry.address, options);
    verified.push({ address: entry.address, family });
  }
  return verified;
}

export function classifyPeerTransport(origin: string): {
  transportKind: RemotePeerTransportKind;
  encrypted: boolean;
} {
  const url = URL.parse(origin);
  if (!url) return { transportKind: "custom", encrypted: false };
  const h = url.hostname.toLowerCase();
  let transportKind: RemotePeerTransportKind = "custom";
  if (h.endsWith(".r.chost.dev")) transportKind = "relay";
  else if (
    h.endsWith(".ts.net") ||
    (isIPv4(h) && /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u.test(h))
  )
    transportKind = "tailscale";
  else if (
    ["localhost", "[::1]"].includes(h) ||
    h.endsWith(".local") ||
    (isIPv4(h) && /^(?:127|10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\./u.test(h))
  )
    transportKind = "lan";
  return { transportKind, encrypted: url.protocol === "https:" };
}

export function parsePeerUrl(raw: string, options: ParseConnectionLinkOptions = {}): URL {
  const url = URL.parse(raw);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw Error("Invalid peer URL");
  if (!options.skipHostPolicy) {
    assertAllowedPeerHost(url.hostname, options);
  }
  return url;
}

export function parseConnectionLink(
  input: string | Pick<RemotePeerAddParams, "connectionUrl" | "origin" | "token">,
  options: ParseConnectionLinkOptions = {},
) {
  const p = typeof input === "string" ? { connectionUrl: input } : input;
  const url = parsePeerUrl(p.connectionUrl ?? p.origin ?? "", options);
  const token =
    p.token ?? new URLSearchParams(url.hash.slice(1)).get("token") ?? url.searchParams.get("token");
  if (!token || token.length > 2048 || /\s/u.test(token)) throw Error("Invalid peer token");
  const { transportKind, encrypted } = classifyPeerTransport(url.origin);
  return { origin: url.origin, token, transportKind, encrypted };
}

const file = "remote-peers-v1.json";
const NODE_IDENTITY_FILE = "node-identity-v1.json";

const nodeIdentitySchema = z.object({
  version: z.literal(1),
  nodeId: remotePeerNodeIdSchema,
});

/** Load or generate a persistent, restart-stable nodeId stored under the web data directory. */
export function loadOrCreatePeerNodeId(data: DataDir): string {
  try {
    const raw = readFileSync(data.path(NODE_IDENTITY_FILE), "utf8");
    const parsed = nodeIdentitySchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data.nodeId;
    console.warn("[remote-peers] invalid node-identity-v1.json; regenerating nodeId");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[remote-peers] unreadable node-identity-v1.json; regenerating nodeId");
    }
  }
  const nodeId = randomUUID();
  data.writeJson(NODE_IDENTITY_FILE, { version: 1, nodeId }, { mode: 0o600 });
  return nodeId;
}

export class PeerHostStore {
  constructor(private data: DataDir) {}

  load(): PeerRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.data.path(file), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      console.warn("[remote-peers] failed to read remote-peers-v1.json; starting with empty list");
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        console.warn("[remote-peers] invalid remote-peers-v1.json structure; ignoring");
        return [];
      }
      const records: PeerRecord[] = [];
      for (const entry of parsed) {
        const checked = peerRecordSchema.safeParse(entry);
        if (checked.success) records.push(checked.data);
        else console.warn("[remote-peers] skipping invalid peer record in remote-peers-v1.json");
      }
      return records;
    } catch {
      console.warn("[remote-peers] corrupt remote-peers-v1.json; starting with empty list");
      return [];
    }
  }

  save(records: PeerRecord[]) {
    this.data.writeJson(file, records, { mode: 0o600 });
  }
}
