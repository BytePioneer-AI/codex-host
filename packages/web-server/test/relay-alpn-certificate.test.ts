import assert from "node:assert/strict";
import { createHash, createPublicKey, X509Certificate } from "node:crypto";
import { it } from "node:test";
import {
  BasicConstraintsExtension,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  X509Certificate as ParsedCertificate,
} from "@peculiar/x509";
import * as acme from "acme-client";
import { createAlpnCertificate } from "../src/remote-relay/alpn-certificate.ts";

it("creates a valid self-signed P-256 TLS-ALPN leaf with only SAN and critical acmeIdentifier", async () => {
  const hostname = "phone.relay.test";
  const authorization = "challenge-token.account-thumbprint";
  const key = await acme.crypto.createPrivateEcdsaKey("P-256");
  const before = Date.now();
  const pem = await createAlpnCertificate(hostname, authorization, key);
  const after = Date.now();
  const cert = new X509Certificate(pem);
  const parsed = new ParsedCertificate(pem);

  assert.equal(cert.ca, false);
  assert.equal(parsed.getExtension(BasicConstraintsExtension), null);
  // No KeyUsage extension means neither keyCertSign nor cRLSign is asserted.
  assert.equal(parsed.getExtension(KeyUsagesExtension), null);
  assert.deepEqual(Array.from(parsed.extensions, (extension) => extension.type).sort(), [
    "1.3.6.1.5.5.7.1.31",
    "2.5.29.17",
  ]);
  const san = parsed.getExtension(SubjectAlternativeNameExtension);
  assert.ok(san);
  assert.deepEqual(Array.from(san.names.toJSON()), [{ type: "dns", value: hostname }]);
  assert.equal(cert.subjectAltName, `DNS:${hostname}`);

  const identifier = parsed.getExtension("1.3.6.1.5.5.7.1.31");
  assert.ok(identifier);
  assert.equal(identifier.critical, true);
  const digest = createHash("sha256").update(authorization).digest();
  assert.deepEqual(
    Buffer.from(identifier.value),
    Buffer.concat([Buffer.from([0x04, 0x20]), digest]),
    "acmeIdentifier contains the DER OCTET STRING wrapping the SHA-256 digest",
  );

  const notBefore = Date.parse(cert.validFrom);
  const notAfter = Date.parse(cert.validTo);
  const hour = 60 * 60_000;
  const week = 7 * 24 * hour;
  assert.ok(notBefore <= before && notAfter > after);
  assert.ok(notBefore >= before - hour - 1_000 && notBefore <= after - hour);
  assert.ok(notAfter >= before + week - 1_000 && notAfter <= after + week);
  assert.ok(cert.publicKey.equals(createPublicKey(key)), "reuses the challenge key");
  assert.equal(cert.publicKey.asymmetricKeyType, "ec");
  assert.equal(cert.publicKey.asymmetricKeyDetails?.namedCurve, "prime256v1");
  assert.deepEqual(parsed.signatureAlgorithm, { name: "ECDSA", hash: { name: "SHA-256" } });
  assert.equal(cert.subject, cert.issuer);
  assert.equal(cert.verify(cert.publicKey), true);
});
