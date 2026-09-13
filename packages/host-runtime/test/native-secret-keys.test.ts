import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NativeSecretKeys } from "../src/native-secret-keys.js";

describe.skipIf(process.platform === "win32")("legacy secret-key read IPC", () => {
  it("reads existing keys without creating missing ones and validates IDs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codexhost-secret-key-"));
    try {
      const launcher = path.join(root, "launcher");
      await writeFile(
        launcher,
        `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.operation !== "read") process.exit(2);
  const file = path.join(process.env.HOME, request.key_id);
  const content = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  process.stdout.write(JSON.stringify({content}) + "\\n");
});
`,
      );
      await chmod(launcher, 0o700);
      const keys = new NativeSecretKeys({
        launcher,
        environment: { HOME: root, PATH: process.env.PATH },
      });
      const keyId = "a".repeat(64);
      expect(await keys.read(keyId)).toBeNull();
      const existing = Array.from({ length: 32 }, (_, index) => index);
      await writeFile(path.join(root, keyId), JSON.stringify(existing), { mode: 0o600 });
      expect(await keys.read(keyId)).toEqual(Buffer.from(existing));
      await expect(keys.read("A".repeat(64))).rejects.toThrow("Native secret storage failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
