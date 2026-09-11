import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NativeSecretKeys } from "../src/native-secret-keys.js";

describe.skipIf(process.platform === "win32")("native secret-key IPC", () => {
  it("validates key IDs and provides create-only synthetic 32-byte keys", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codexhost-secret-key-"));
    const fakeLauncher = path.join(root, "launcher");
    await writeFile(
      fakeLauncher,
      `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const file = path.join(process.env.HOME, request.key_id);
  if (request.operation === "read") {
    const content = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    process.stdout.write(JSON.stringify({content}) + "\\n");
    return;
  }
  if (fs.existsSync(file)) process.exit(2);
  const content = Array.from({length: 32}, (_, index) => index);
  fs.writeFileSync(file, JSON.stringify(content), {flag: "wx", mode: 0o600});
  process.stdout.write(JSON.stringify({content}) + "\\n");
});
`,
    );
    await chmod(fakeLauncher, 0o700);
    const keys = new NativeSecretKeys({
      launcher: fakeLauncher,
      environment: { HOME: root, PATH: process.env.PATH },
    });
    const keyId = "a".repeat(64);
    try {
      expect(await keys.read(keyId)).toBeNull();
      const created = await keys.create(keyId);
      expect(created).toEqual(Buffer.from(Array.from({ length: 32 }, (_, index) => index)));
      await expect(keys.create(keyId)).rejects.toThrow("Native secret storage failed");
      expect(await keys.read(keyId)).toEqual(created);
      await expect(keys.read("A".repeat(64))).rejects.toThrow("Native secret storage failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
