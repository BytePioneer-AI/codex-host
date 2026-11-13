import { createHash } from "node:crypto";

export const paths = {
  agent: "/v1/agent",
  register: "/v1/register",
  tcp: "/v1/tcp",
  notice: "/v1/notice",
  authenticated: "/v1/authenticated",
  externalAccount: "/v1/external-account",
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

/** Let's Encrypt production, used when the deployer configures no certificate authority. */
export const defaultCertificateDirectory = "https://acme-v02.api.letsencrypt.org/directory";

export interface CertificateAuthority {
  directory: string;
}

/**
 * Body of a successful registration. Relays without certificate requests through the
 * relay omit `token` and `certificateAuthority`.
 */
export interface RegistrationResponse {
  hostname: string;
  token?: string;
  certificateAuthority?: CertificateAuthority;
}

/** Body of `POST /v1/notice` from the relay to a registered computer. */
export type RelayNotice =
  { quota: "exhausted"; until: string } | { certificateAuthority: CertificateAuthority };

/**
 * Body of a successful `POST /v1/external-account`; `hmacKey` is base64url. `contact` holds
 * the deployer's account contact URLs for authorities that require one, such as GTS.
 */
export interface ExternalAccount {
  keyId: string;
  hmacKey: string;
  contact?: string[];
}

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
