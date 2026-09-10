import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { spawn } from "node:child_process";
import { readNativeProcessIdentity } from "../src/native-process-identity.js";
import { OfficialProcessLifecycle } from "../src/official-process-lifecycle.js";
import { NativeProcessRelay } from "../src/native-process-relay.js";

import { describe, expect, it, vi } from "vitest";
import { once } from "node:events";

import { NativePrivateFiles, privateFileDigest } from "../src/native-private-files.js";
import { CodexCredentialFiles } from "../src/account/codex-credential-files.js";
import { NativeCodexCredentials } from "../src/account/native-codex-credentials.js";
import { syntheticNativeCredentials } from "./fixtures/codex-account-fixtures.js";

const launcher = process.env.CODEXHOST_TEST_NATIVE_LAUNCHER;

describe.skipIf(!launcher)("native private-file IPC (explicit compiled launcher)", () => {
  it("protects snapshots and native installations and releases the writer lease", async () => {
    if (!launcher) throw new Error("Compiled test launcher is required");
    const root = await mkdtemp(path.join(tmpdir(), "codexhost-native-file-"));
    const files = new NativePrivateFiles({ launcher });
    const home = path.join(root, "home");
    const directory = path.join(root, "credentials");
    await files.ensureDirectory(home);
    const store = new CodexCredentialFiles({ directory, sharedCodexHome: home, files });
    const lease = await store.initialize();
    try {
      const competing = new CodexCredentialFiles({
        directory: path.join(root, "another-host-slots"),
        sharedCodexHome: home,
        files,
      });
      await expect(competing.initialize()).rejects.toThrow("Native private storage failed");
      const a = NativeCodexCredentials.parse(syntheticNativeCredentials({ subject: "a" }));
      const account = { accountId: "11111111-1111-4111-8111-111111111111", identity: a.identity };
      await store.save(account, a);
      await store.install(await store.load(account), null);
      expect((await store.readCurrent())?.serializeForNativeStore()).toBe(
        a.serializeForNativeStore(),
      );
      const next = NativeCodexCredentials.parse(
        syntheticNativeCredentials({ subject: "a", generation: 2 }),
      );
      await store.install(next, a);
      await expect(store.install(a, a)).rejects.toThrow("Native private storage failed");
      await store.saveCurrent(account);
      expect((await store.load(account)).serializeForNativeStore()).toBe(
        next.serializeForNativeStore(),
      );
      await store.install(null, next);
      await store.remove(account);
      expect(await store.readCurrent()).toBeNull();
      expect(await readdir(directory)).toEqual([]);
      expect(await readdir(home)).toEqual([".codexhost-writer.lock"]);
    } finally {
      await lease.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("observes real process birth and confirmed absence through the native boundary", async () => {
    if (!launcher) throw new Error("Compiled test launcher is required");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const lifecycle = new OfficialProcessLifecycle(child);
    try {
      if (!child.pid) throw new Error("Missing test process");
      const first = await readNativeProcessIdentity(launcher, child.pid);
      expect(first).not.toBeNull();
      expect(await readNativeProcessIdentity(launcher, child.pid)).toBe(first);
      await lifecycle.stop();
      expect(await readNativeProcessIdentity(launcher, child.pid)).not.toBe(first);
    } finally {
      await lifecycle.stop();
    }
  });

  it.skipIf(process.platform !== "win32")(
    "frames native output and persists a receipt only after the supervised tree exits",
    async () => {
      if (!launcher) throw new Error("Compiled test launcher is required");
      const root = await mkdtemp(path.join(tmpdir(), "codexhost-process-relay-"));
      const directory = path.join(root, "private");
      const files = new NativePrivateFiles({ launcher });
      await files.ensureDirectory(directory);
      const child = spawn(launcher, ["supervise-process"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const pipesClosed = once(child, "close");
      const lifecycle = new OfficialProcessLifecycle(child, {
        timeoutMs: 10_000,
        endInput: () => child.stdin.end(),
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.resume();
      const program = `const {spawn}=require('node:child_process'); const leaf=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); console.log(JSON.stringify({event:'stopped',child:leaf.pid})); process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));`;
      try {
        child.stdin.write(
          JSON.stringify({
            program: process.execPath,
            arguments: ["-e", program],
            cwd: directory,
            receipt_directory: directory,
            receipt_name: "exit.json",
            tag: "synthetic-process-generation",
          }) + "\n",
        );
        await vi.waitFor(
          () => {
            expect(output).toContain('"channel":"stdout"');
            expect(output.endsWith("\n")).toBe(true);
          },
          { timeout: 5000 },
        );
        const frames = output
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                event: string;
                channel?: string;
                pid?: number;
                bytes?: number[];
              },
          );
        const started = frames.find((frame) => frame.event === "started");
        const payload = JSON.parse(
          Buffer.concat(
            frames
              .filter((frame) => frame.event === "output" && frame.channel === "stdout")
              .map((frame) => Buffer.from(frame.bytes ?? [])),
          ).toString(),
        ) as { child: number };
        if (!started?.pid) throw new Error("Missing supervised root identity");
        const rootIdentity = await readNativeProcessIdentity(launcher, started.pid);
        const leafIdentity = await readNativeProcessIdentity(launcher, payload.child);
        expect(rootIdentity).not.toBeNull();
        expect(leafIdentity).not.toBeNull();
        expect(await files.read(directory, "exit.json")).toBeNull();
        expect(frames.some((frame) => frame.event === "stopped")).toBe(false);
        expect((await lifecycle.stop()).code).toBe(0);
        await pipesClosed;
        expect(await readNativeProcessIdentity(launcher, started.pid)).not.toBe(rootIdentity);
        expect(await readNativeProcessIdentity(launcher, payload.child)).not.toBe(leafIdentity);
        expect(
          JSON.parse((await files.read(directory, "exit.json"))?.toString() ?? "null"),
        ).toMatchObject({
          tag: "synthetic-process-generation",
          pid: started.pid,
          treeExited: true,
        });
      } finally {
        await lifecycle.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.skipIf(process.platform !== "win32")(
    "decodes supervised channels and verifies the private exit receipt",
    async () => {
      if (!launcher) throw new Error("Compiled test launcher is required");
      const root = await mkdtemp(path.join(tmpdir(), "codexhost-relay-client-"));
      const directory = path.join(root, "private");
      const files = new NativePrivateFiles({ launcher });
      await files.ensureDirectory(directory);
      const relay = new NativeProcessRelay({
        launcher,
        files,
        environment: process.env,
        program: process.execPath,
        arguments: [
          "-e",
          "console.log('synthetic-output'); process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));",
        ],
        cwd: directory,
        receipt: { directory, name: "exit.json", tag: "synthetic-relay" },
      });
      let output = "";
      relay.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      relay.stderr.resume();
      try {
        await relay.start();
        expect(relay.nativeProcessId).toBeTypeOf("number");
        await vi.waitFor(() => expect(output).toBe("synthetic-output\n"));
        expect((await relay.stop()).code).toBe(0);
        const receipt = await files.read(directory, "exit.json");
        expect(receipt).not.toBeNull();
      } finally {
        await relay.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects path traversal and failed replacement without leaking input", async () => {
    if (!launcher) throw new Error("Compiled test launcher is required");
    const root = await mkdtemp(path.join(tmpdir(), "codexhost-native-error-"));
    const directory = path.join(root, "private");
    const files = new NativePrivateFiles({ launcher });
    try {
      await files.ensureDirectory(directory);
      await expect(
        files.replace(directory, "../escape", Buffer.from("synthetic-secret"), null),
      ).rejects.toThrow("Native private storage failed");
      await files.replace(directory, "value", Buffer.from("synthetic-secret"), null);
      try {
        await files.replace(
          directory,
          "value",
          Buffer.from("synthetic-new-secret"),
          privateFileDigest(Buffer.from("wrong")),
        );
        throw new Error("Expected conflict");
      } catch (error) {
        expect(inspect(error)).not.toContain("synthetic-secret");
        expect(inspect(error)).not.toContain("synthetic-new-secret");
        expect(inspect(error)).not.toContain(directory);
      }
      expect((await files.read(directory, "value"))?.toString()).toBe("synthetic-secret");
      expect(await readdir(directory)).toEqual(["value"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
