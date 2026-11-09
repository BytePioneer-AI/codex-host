import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deriveId } from "@codexhost/remote-relay/protocol";
import type { DataDir } from "../store.ts";

export function relayIdentity(data: DataDir) {
  const file = data.path("remote-relay", "identity.pem");
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    const { privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), {
      mode: 0o600,
      flag: "wx",
    });
  }
  const privateKey = createPrivateKey(readFileSync(file));
  const publicKey = Buffer.from(
    createPublicKey(privateKey).export({ format: "jwk" }).x as string,
    "base64url",
  );
  return { privateKey, publicKey, id: deriveId(publicKey) };
}
