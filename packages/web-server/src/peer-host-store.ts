import { readFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { z } from "zod";
import type { DataDir } from "./store.ts";
import {
  remotePeerIdSchema,
  type RemotePeerAddParams,
  type RemotePeerTransportKind,
} from "@codexhost/shared-contracts";

export interface PeerRecord {
  peerId: string;
  name: string;
  origin: string;
  token: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

const peerRecordSchema = z.object({
  peerId: remotePeerIdSchema,
  name: z.string().min(1).max(120),
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

function unbracket(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1).toLowerCase()
    : hostname.toLowerCase();
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
  if (bare === "localhost" || bare.endsWith(".localhost") || bare === "::1") return true;
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

export function parseConnectionLink(
  input: string | RemotePeerAddParams,
  options: ParseConnectionLinkOptions = {},
) {
  const p = typeof input === "string" ? { connectionUrl: input } : input;
  const url = URL.parse(p.connectionUrl ?? p.origin ?? "");
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw Error("Invalid peer URL");
  if (!options.skipHostPolicy) {
    if (isBlockedMetadataOrUnspecifiedHost(url.hostname))
      throw Error("Peer host address is not allowed");
    if (!options.allowLoopback && isLoopbackHost(url.hostname))
      throw Error("Loopback peer addresses are not allowed");
  }
  const token =
    p.token ?? new URLSearchParams(url.hash.slice(1)).get("token") ?? url.searchParams.get("token");
  if (!token || token.length > 2048 || /\s/u.test(token)) throw Error("Invalid peer token");
  const { transportKind, encrypted } = classifyPeerTransport(url.origin);
  return { origin: url.origin, token, transportKind, encrypted };
}

const file = "remote-peers-v1.json";

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
