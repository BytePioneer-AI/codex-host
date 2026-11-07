import { createHash } from "node:crypto";

export const paths = {
  agent: "/v1/agent",
  register: "/v1/register",
  tcp: "/v1/tcp",
  notice: "/v1/notice",
  authenticated: "/v1/authenticated",
} as const;

export const headers = {
  challenge: "relay-challenge",
  publicKey: "relay-public-key",
  signature: "relay-signature",
  name: "relay-name",
  invite: "relay-invite",
  clientAddress: "relay-client-address",
  clientPort: "relay-client-port",
  connectionId: "relay-connection-id",
} as const;

export const closeCodes = {
  invalidSignature: 4401,
  registrationTimeout: 4408,
  replaced: 4409,
  invite: 4410,
  nameTaken: 4411,
  banned: 4412,
  full: 4413,
} as const;

export const streamWindowSize = 2 * 1024 * 1024;
export const connectionWindowSize = 8 * 1024 * 1024;
export const maxPayload = 1024 * 1024;

export function deriveId(publicKey: Uint8Array): string {
  const digest = createHash("sha256").update(publicKey).digest().subarray(0, 16);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let id = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      id += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits > 0) id += alphabet[(value << (5 - bits)) & 31];
  return id;
}

export function isDnsLabel(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(name);
}

export function normalizeControlHost(controlHost: string): string {
  return new URL(`https://${controlHost}`).hostname.replace(/\.$/, "");
}

export function registrationContent(controlHost: string, challenge: string): string {
  return `codexhost-relay-register-v1\n${normalizeControlHost(controlHost)}\n${challenge}`;
}
