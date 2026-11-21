import { createCipheriv, createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCredentials } from "../src/credentials.js";
import type { ZcodeInstallation } from "../src/installation.js";

// Synthetic reference vectors generated with Web Crypto, using the v3.18.2 envelope.
const SECRET = "  fixture managed credential secret  \n";
const ENV_VECTOR =
  "enc:v2:env:37c4d99cb9556efb2e0f684a:ABEiM0RVZneImaq7.tTJyxCBaftn4BqC0DZK3cw.Yo5P7XPKZA3rNs_zqvCrmM8Bf_0";
const OS_VECTOR =
  "enc:v2:os:630dcd2966c4336691125448:ABEiM0RVZneImaq7.V0OVUZXX0g45Ha-NiULjHQ.uO-X3iADLnI";
const OS_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const PLAINTEXT = "  BigModel 测试  \n";

function legacy(value: string, secret: string) {
  const iv = Buffer.alloc(12, 61);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
  const data = Buffer.concat([cipher.update(value), cipher.final()]);
  return `enc:v1:${[iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".")}`;
}

describe("ZCode credential snapshots", () => {
  let directory: string, file: string, secretFile: string, installation: ZcodeInstallation;
  const unexpectedSystemRead = vi.fn(async () => {
    throw new Error("Unexpected operating system lookup");
  });
  beforeEach(async () => {
    unexpectedSystemRead.mockClear();
    directory = await mkdtemp(path.join(tmpdir(), "zcode-credentials-"));
    file = path.join(directory, "credentials.json");
    secretFile = path.join(directory, "credential-secret");
    installation = {
      dataRoot: directory,
      version: "3.18.2",
      runtime: "",
      cli: "",
      builtinProviderConfig: "",
      personalProviderConfig: "",
    };
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    expect(unexpectedSystemRead).not.toHaveBeenCalled();
  });
  const save = async (values: Record<string, string>) => writeFile(file, JSON.stringify(values));
  const reader = (environment: NodeJS.ProcessEnv = {}) =>
    readCredentials(installation, environment, unexpectedSystemRead);

  it.each(["environment", "explicit file", "private default file"])(
    "reads the same v2:env vector via %s without trimming or writing",
    async (mode) => {
      await save({ token: ENV_VECTOR });
      const before = await readFile(file, "utf8");
      const environment: NodeJS.ProcessEnv = {};
      if (mode === "environment") environment.ZCODE_CREDENTIAL_SECRET = SECRET;
      else {
        await writeFile(secretFile, SECRET, { mode: 0o600 });
        if (mode === "explicit file") environment.ZCODE_CREDENTIAL_SECRET_FILE = secretFile;
      }
      const files = (await readdir(directory)).sort();
      expect(await (await reader(environment))("token")).toBe(PLAINTEXT);
      expect(await readFile(file, "utf8")).toBe(before);
      expect((await readdir(directory)).sort()).toEqual(files);
    },
  );

  it("reads an OS-backed vector only using the exact absolute-path entry and does not create a marker", async () => {
    await save({ channel: OS_VECTOR });
    const load = vi.fn(async () => OS_KEY);
    const read = await readCredentials(installation, {}, load);
    expect(await read("missing")).toBe("");
    expect(load).not.toHaveBeenCalled();
    expect(await read("channel")).toBe("bigmodel");
    expect(load).toHaveBeenCalledWith(
      createHash("sha256").update(path.resolve(file)).digest("hex"),
    );
    expect(await readdir(directory)).toEqual(["credentials.json"]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ channel: OS_VECTOR });
  });

  it("resolves one source per snapshot and rejects an envelope naming another source", async () => {
    await save({ channel: OS_VECTOR, second: OS_VECTOR, managed: ENV_VECTOR });
    await writeFile(secretFile, SECRET, { mode: 0o600 });
    const load = vi.fn(async () => OS_KEY);
    const read = await readCredentials(installation, {}, load);
    await expect(read("managed")).rejects.toThrow(/original key is unavailable/);
    await expect(Promise.all([read("channel"), read("second")])).resolves.toEqual([
      "bigmodel",
      "bigmodel",
    ]);
    expect(load).toHaveBeenCalledOnce();
  });

  it("does not use an environment or private file key for an OS envelope", async () => {
    // Keep the payload/fingerprint for the managed key but request the OS source.
    await save({ token: ENV_VECTOR.replace(":env:", ":os:") });
    await writeFile(secretFile, SECRET, { mode: 0o600 });
    const noEntry = vi.fn(async () => undefined);
    await expect((await readCredentials(installation, {}, noEntry))("token")).rejects.toThrow(
      /original key is unavailable/,
    );
    await expect((await reader({ ZCODE_CREDENTIAL_SECRET: SECRET }))("token")).rejects.toThrow(
      /original key is unavailable/,
    );
  });

  it("rejects a mismatched OS key and redacts operating-system failures", async () => {
    await save({ channel: OS_VECTOR });
    for (const backend of [
      async () => Buffer.alloc(32, 42).toString("base64url"),
      async () => {
        throw new Error(OS_KEY);
      },
    ]) {
      const read = await readCredentials(installation, {}, backend);
      await expect(read("channel")).rejects.toThrow(
        "Cannot read ZCode enc:v2: credentials: the original key is unavailable or does not match. Check the ZCode credential storage in the Host user's session.",
      );
    }
  });

  it("rejects conflicting managed sources, a mismatched fingerprint and a wrong secret", async () => {
    await save({ token: ENV_VECTOR, wrongPrint: ENV_VECTOR.replace("37c4", "47c4") });
    for (const [key, environment] of [
      ["token", { ZCODE_CREDENTIAL_SECRET: SECRET, ZCODE_CREDENTIAL_SECRET_FILE: secretFile }],
      ["token", { ZCODE_CREDENTIAL_SECRET: SECRET.trim() }],
      ["wrongPrint", { ZCODE_CREDENTIAL_SECRET: SECRET }],
    ] as const) {
      await expect((await reader(environment))(key)).rejects.toThrow(
        /original key is unavailable or does not match/,
      );
    }
  });

  it("does not discover a default file when storage is pinned to OS", async () => {
    await save({ token: ENV_VECTOR });
    await writeFile(secretFile, SECRET, { mode: 0o600 });
    await writeFile(path.join(directory, "credential-source"), "os\n");
    await expect((await reader())("token")).rejects.toThrow(/original key is unavailable/);
  });

  it.skipIf(process.platform === "win32")("requires a private implicit file", async () => {
    await save({ token: ENV_VECTOR });
    await writeFile(secretFile, SECRET);
    await chmod(secretFile, 0o644);
    await expect((await reader())("token")).rejects.toThrow(/original key is unavailable/);
  });

  it.each([
    ENV_VECTOR.replace("tTJyx", "uTJyx"), // Authentic-looking envelope, invalid GCM tag.
    ENV_VECTOR.replace("tTJyxCBaftn4BqC0DZK3cw", "YWJjZA"),
    ENV_VECTOR.replace("ABEiM0RVZneImaq7", "YWJjZA"),
    ENV_VECTOR + "=",
    ENV_VECTOR + ".extra",
    ENV_VECTOR.replace(":env:", ":unknown:"),
  ])(
    "rejects malformed or unauthenticated v2 records before they can be used (%s)",
    async (bad) => {
      await save({ token: bad });
      await expect((await reader({ ZCODE_CREDENTIAL_SECRET: SECRET }))("token")).rejects.toThrow(
        /invalid or damaged encrypted record/,
      );
    },
  );

  it("reads mixed legacy, clear and v2 fields and rejects unknown encrypted values only when requested", async () => {
    await save({
      clear: "  clear  ",
      legacy: legacy("  legacy  ", SECRET),
      v2: ENV_VECTOR,
      unsupported: "enc:v3:synthetic-not-a-secret",
      nested: legacy("enc:v3:nested", SECRET),
      bearer: " Bearer Bearer enc:v3:wrapped",
    });
    const read = await reader({ ZCODE_CREDENTIAL_SECRET: SECRET });
    expect(await read("clear")).toBe("  clear  ");
    expect(await read("legacy")).toBe("legacy");
    expect(await read("v2")).toBe(PLAINTEXT);
    for (const key of ["unsupported", "nested", "bearer"])
      await expect(read(key)).rejects.toThrow("unsupported encrypted credential format (enc:)");
  });

  it("keeps the legacy derived-key path and separates a missing store from a damaged one", async () => {
    expect(await (await reader())("token")).toBe("");
    let user = "unknown";
    try {
      user = userInfo().username;
    } catch {
      /* A user record is not required for legacy format. */
    }
    await save({
      token: legacy(
        "legacy fallback",
        `zcode-credential-fallback:${platform()}:${homedir()}:${user}`,
      ),
    });
    expect(await (await reader())("token")).toBe("legacy fallback");
    await writeFile(file, "{broken");
    await expect(reader()).rejects.toThrow("Cannot read ZCode credentials.");
  });
});
