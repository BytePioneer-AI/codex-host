import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import {
  Extension,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";
import { OctetString } from "asn1js";

/** RFC 8737 validation uses a self-signed leaf, not a certificate authority. */
export async function createAlpnCertificate(
  hostname: string,
  keyAuthorization: string,
  challengeKey: Buffer,
): Promise<Buffer> {
  const key = createPrivateKey(challengeKey);
  const algorithm = { name: "ECDSA", namedCurve: "P-256" };
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    new Uint8Array(key.export({ format: "der", type: "pkcs8" })),
    algorithm,
    false,
    ["sign"],
  );
  const publicKey = await crypto.subtle.importKey(
    "spki",
    new Uint8Array(createPublicKey(key).export({ format: "der", type: "spki" })),
    algorithm,
    true,
    ["verify"],
  );
  const digest = createHash("sha256").update(keyAuthorization).digest();
  const now = Date.now();
  const certificate = await X509CertificateGenerator.createSelfSigned(
    {
      name: [{ CN: [hostname] }],
      keys: { privateKey, publicKey },
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
      notBefore: new Date(now - 60 * 60_000),
      notAfter: new Date(now + 7 * 24 * 60 * 60_000),
      extensions: [
        new SubjectAlternativeNameExtension([{ type: "dns", value: hostname }]),
        new Extension("1.3.6.1.5.5.7.1.31", true, new OctetString({ valueHex: digest }).toBER()),
      ],
    },
    crypto,
  );
  return Buffer.from(certificate.toString("pem"));
}
