import { readFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import type { DataDir } from "./store.ts";
import type { RemotePeerAddParams, RemotePeerTransportKind } from "@codexhost/shared-contracts";
export interface PeerRecord {
  peerId: string;
  name: string;
  origin: string;
  token: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
export function parseConnectionLink(input: string | RemotePeerAddParams) {
  const p = typeof input === "string" ? { connectionUrl: input } : input;
  const url = URL.parse(p.connectionUrl ?? p.origin ?? "");
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw Error("Invalid peer URL");
  const token =
    p.token ?? new URLSearchParams(url.hash.slice(1)).get("token") ?? url.searchParams.get("token");
  if (!token || token.length > 2048 || /\s/u.test(token)) throw Error("Invalid peer token");
  const h = url.hostname;
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
  return { origin: url.origin, token, transportKind, encrypted: url.protocol === "https:" };
}
const file = "remote-peers-v1.json";
export class PeerHostStore {
  constructor(private data: DataDir) {}
  load() {
    try {
      return JSON.parse(readFileSync(this.data.path(file), "utf8")) as PeerRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw Error("Cannot read remote peer configuration");
    }
  }
  save(records: PeerRecord[]) {
    this.data.writeJson(file, records, { mode: 0o600 });
  }
}
