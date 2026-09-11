import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { spawn } from "node:child_process";
import { readNativeProcessIdentity } from "../src/native-process-identity.js";
import { OfficialProcessLifecycle } from "../src/official-process-lifecycle.js";
import { NativeProcessRelay } from "../src/native-process-relay.js";

import { describe, expect, it, vi } from "vitest";
import { once } from "node:events";

import {
  NativePrivateFiles,
  privateFileDigest,
  type NativePrivateFileError,
} from "../src/native-private-files.js";

const launcher = process.env.CODEXHOST_TEST_NATIVE_LAUNCHER;

async function countingLauncher(root: string, executable: string): Promise<string> {
  const wrapper = path.join(root, "counting-launcher");
  await writeFile(
    wrapper,
    `#!${process.execPath}
const {appendFileSync} = require("node:fs");
const {spawn} = require("node:child_process");
appendFileSync(${JSON.stringify(path.join(root, "launches"))}, "launch\\n");
const child = spawn(${JSON.stringify(executable)}, process.argv.slice(2), {stdio: "inherit"});
child.once("error", () => process.exit(1));
child.once("exit", (code, signal) => signal ? process.kill(process.pid, signal) : process.exit(code ?? 1));
`,
  );
  await chmod(wrapper, 0o700);
  return wrapper;
}

async function syntheticPersistentLauncher(root: string, operation: string): Promise<string> {
  const fakeLauncher = path.join(root, "persistent-launcher");
  await writeFile(
    fakeLauncher,
    `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(path.join(root, "launches"))}, "launch\\n");
let input = "";
process.stdin.on("data", chunk => {
  input += chunk;
  for (;;) {
    const newline = input.indexOf("\\n");
    if (newline < 0) break;
    const request = JSON.parse(input.slice(0, newline));
    input = input.slice(newline + 1);
    if (request.operation === "lock") process.stdout.write('{"ready":true}\\n');
    else { ${operation} }
  }
});
process.stdin.on("end", () => { fs.appendFileSync(${JSON.stringify(
      path.join(root, "events"),
    )}, "eof\\n"); process.exit(0); });
`,
  );
  await chmod(fakeLauncher, 0o700);
  return fakeLauncher;
}

describe.skipIf(process.platform === "win32")("native private-file scheduling", () => {
  it("serializes ordinary concurrent operations instead of rejecting them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codexhost-private-queue-"));
    const fakeLauncher = path.join(root, "launcher");
    await writeFile(
      fakeLauncher,
      `#!${process.execPath}
const fs = require("node:fs");
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const events = request.directory + "/events";
  fs.appendFileSync(events, "start:" + request.name + "\\n");
  setTimeout(() => {
    fs.appendFileSync(events, "end:" + request.name + "\\n");
    process.stdout.write(JSON.stringify({content: null}) + "\\n");
  }, 75);
});
`,
    );
    await chmod(fakeLauncher, 0o700);
    const files = new NativePrivateFiles({ launcher: fakeLauncher });
    try {
      await Promise.all([
        files.read(root, "one"),
        files.read(root, "two"),
        files.read(root, "three"),
      ]);
      expect((await readFile(path.join(root, "events"), "utf8")).trim().split("\n")).toEqual([
        "start:one",
        "end:one",
        "start:two",
        "end:two",
        "start:three",
        "end:three",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects content above the 20 MiB IPC budget before spawning", async () => {
    const files = new NativePrivateFiles({ launcher: path.resolve("synthetic-launcher") });
    await expect(
      files.replace("/synthetic", "vault", Buffer.alloc(20 * 1024 * 1024 + 1), null),
    ).rejects.toThrow("Native private storage failed");
  });
});

describe.skipIf(!launcher)("native private-file IPC (explicit compiled launcher)", () => {
  it.skipIf(process.platform === "win32")(
    "fails closed when the leased lock pathname is replaced",
    async () => {
      if (!launcher) throw new Error("Compiled test launcher is required");
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "codexhost-lock-inode-")));
      const directory = path.join(root, "private");
      const files = new NativePrivateFiles({ launcher });
      const shared = files.withReadOnlyDirectoryAccess();
      let lease: Awaited<ReturnType<NativePrivateFiles["lock"]>> | undefined;
      try {
        await files.ensureDirectory(directory);
        lease = await files.lock(directory, "writer.lock");
        await unlink(path.join(directory, "writer.lock"));
        await writeFile(path.join(directory, "writer.lock"), "replacement", { mode: 0o600 });

        await expect(
          files.replace(directory, "value", Buffer.from("blocked"), null),
        ).rejects.toThrow("Native private storage failed");
        await expect(shared.read(directory, "value")).rejects.toThrow(
          "Native private storage unavailable",
        );
        expect(await readdir(directory)).toEqual(["writer.lock"]);
      } finally {
        await lease?.release().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not write into a replacement of the leased root",
    async () => {
      if (!launcher) throw new Error("Compiled test launcher is required");
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "codexhost-lock-root-")));
      const directory = path.join(root, "private");
      const moved = path.join(root, "moved-private");
      const files = new NativePrivateFiles({ launcher });
      const shared = files.withReadOnlyDirectoryAccess();
      let lease: Awaited<ReturnType<NativePrivateFiles["lock"]>> | undefined;
      try {
        await files.ensureDirectory(directory);
        lease = await files.lock(directory, "writer.lock");
        await rename(directory, moved);
        await mkdir(directory, { mode: 0o700 });

        await expect(
          files.replace(directory, "value", Buffer.from("blocked"), null),
        ).rejects.toThrow("Native private storage failed");
        await expect(shared.read(directory, "value")).rejects.toThrow(
          "Native private storage unavailable",
        );
        expect(await readdir(directory)).toEqual([]);
      } finally {
        await lease?.release().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("keeps all leased facade I/O in one helper and excludes another driver", async () => {
    if (!launcher) throw new Error("Compiled test launcher is required");
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "codexhost-native-lease-")));
    const wrappedLauncher = await countingLauncher(root, launcher);
    const files = new NativePrivateFiles({ launcher: wrappedLauncher });
    const homeFiles = files.withReadOnlyDirectoryAccess();
    const contender = new NativePrivateFiles({ launcher: wrappedLauncher, timeoutMs: 2_000 });
    const home = path.join(root, "home");
    const privateDirectory = path.join(root, "private");
    const readableDirectory = path.join(root, "readable");
    let lease: Awaited<ReturnType<NativePrivateFiles["lock"]>> | undefined;
    let contenderLease: Awaited<ReturnType<NativePrivateFiles["lock"]>> | undefined;
    try {
      await files.ensureDirectory(home);
      await files.ensureDirectory(privateDirectory);
      await files.ensureDirectory(readableDirectory);
      await chmod(readableDirectory, 0o755);
      await writeFile(path.join(root, "launches"), "");

      lease = await files.lock(home, ".codexhost-writer.lock");
      await Promise.all([
        files.replace(privateDirectory, "default", Buffer.from("one"), null),
        homeFiles.replace(readableDirectory, "read-only-facade", Buffer.from("two"), null),
        files.read(privateDirectory, "missing"),
        homeFiles.read(readableDirectory, "missing"),
      ]);
      expect(await files.read(privateDirectory, "default")).toEqual(Buffer.from("one"));
      expect(await homeFiles.read(readableDirectory, "read-only-facade")).toEqual(
        Buffer.from("two"),
      );
      expect((await readFile(path.join(root, "launches"), "utf8")).trim().split("\n")).toEqual([
        "launch",
      ]);

      await expect(contender.lock(home, ".codexhost-writer.lock")).rejects.toThrow(
        "Native private storage failed",
      );
      expect((await readFile(path.join(root, "launches"), "utf8")).trim().split("\n")).toHaveLength(
        2,
      );
      await lease.release();
      lease = undefined;
      contenderLease = await contender.lock(home, ".codexhost-writer.lock");
    } finally {
      await lease?.release().catch(() => undefined);
      await contenderLease?.release().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("protects snapshots and native installations and releases the writer lease", async () => {
    if (!launcher) throw new Error("Compiled test launcher is required");
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "codexhost-native-file-")));
    const files = new NativePrivateFiles({ launcher });
    const home = path.join(root, "home");
    const directory = path.join(root, "credentials");
    await files.ensureDirectory(home);
    await files.ensureDirectory(directory);
    const lease = await files.lock(home, ".codexhost-writer.lock");
    try {
      await expect(files.lock(home, ".codexhost-writer.lock")).rejects.toThrow(
        "Native private storage failed",
      );
      const first = Buffer.from('{"synthetic":"one"}');
      const next = Buffer.from('{"synthetic":"two"}');
      await files.replace(directory, "vault.json", first, null);
      const stored = await files.read(directory, "vault.json");
      expect(stored).not.toBeNull();
      await files.replace(home, "auth.json", stored ?? Buffer.alloc(0), null);
      expect(await files.read(home, "auth.json")).toEqual(first);
      await files.replace(home, "auth.json", next, privateFileDigest(first));
      await expect(
        files.replace(home, "auth.json", first, privateFileDigest(first)),
      ).rejects.toThrow("Native private storage failed");
      await files.remove(home, "auth.json", privateFileDigest(next));
      await files.remove(directory, "vault.json", privateFileDigest(first));
      expect(await files.read(home, "auth.json")).toBeNull();
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
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "codexhost-process-relay-")));
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
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "codexhost-relay-client-")));
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
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "codexhost-native-error-")));
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

describe.skipIf(process.platform === "win32")(
  "native private-file persistent helper failures",
  () => {
    it("bounds one shared facade queue at 64 accepted operations", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "codexhost-private-bound-"));
      const fakeLauncher = await syntheticPersistentLauncher(
        root,
        `const respond = () => process.stdout.write('{"content":null}\\n');
if (!globalThis.delayed) { globalThis.delayed = true; setTimeout(respond, 50); } else respond();`,
      );
      const files = new NativePrivateFiles({ launcher: fakeLauncher, timeoutMs: 2_000 });
      const homeFiles = files.withReadOnlyDirectoryAccess();
      const lease = await files.lock(root, "writer.lock");
      try {
        const accepted = Array.from({ length: 64 }, (_, index) =>
          (index % 2 === 0 ? files : homeFiles).read(root, `value-${index}`),
        );
        await expect(homeFiles.read(root, "overflow")).rejects.toThrow(
          "Native private storage failed",
        );
        await expect(Promise.all(accepted)).resolves.toEqual(
          Array.from({ length: 64 }, () => null),
        );
      } finally {
        await lease.release().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    });

    it.skipIf(!launcher)("keeps the lease after a safe CAS failure", async () => {
      if (!launcher) throw new Error("Compiled test launcher is required");
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "codexhost-native-cas-")));
      const files = new NativePrivateFiles({ launcher });
      const directory = path.join(root, "private");
      let lease: Awaited<ReturnType<NativePrivateFiles["lock"]>> | undefined;
      try {
        await files.ensureDirectory(directory);
        lease = await files.lock(directory, "writer.lock");
        await files.replace(directory, "value", Buffer.from("first"), null);
        await expect(
          files.replace(
            directory,
            "value",
            Buffer.from("second"),
            privateFileDigest(Buffer.from("wrong")),
          ),
        ).rejects.toThrow("Native private storage failed");
        expect(await files.read(directory, "value")).toEqual(Buffer.from("first"));
      } finally {
        await lease?.release().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    });

    it("waits for an accepted operation before releasing the persistent helper", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "codexhost-private-release-"));
      const fakeLauncher = await syntheticPersistentLauncher(
        root,
        `fs.appendFileSync(${JSON.stringify(path.join(root, "events"))}, "start\\n");
setTimeout(() => {
  fs.appendFileSync(${JSON.stringify(path.join(root, "events"))}, "end\\n");
  process.stdout.write('{"content":[7]}\\n');
}, 100);`,
      );
      const files = new NativePrivateFiles({ launcher: fakeLauncher, timeoutMs: 2_000 });
      const lease = await files.lock(root, "writer.lock");
      try {
        const read = files.read(root, "value");
        const release = lease.release();
        await expect(read).resolves.toEqual(Buffer.from([7]));
        await release;
        expect((await readFile(path.join(root, "events"), "utf8")).trim().split("\n")).toEqual([
          "start",
          "end",
          "eof",
        ]);
      } finally {
        await lease.release().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    });

    it("marks every facade unavailable after helper death without spawning a replacement", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "codexhost-private-death-"));
      const fakeLauncher = await syntheticPersistentLauncher(root, "process.exit(7);");
      const files = new NativePrivateFiles({ launcher: fakeLauncher, timeoutMs: 2_000 });
      const homeFiles = files.withReadOnlyDirectoryAccess();
      const lease = await files.lock(root, "writer.lock");
      try {
        await expect(files.read(root, "first")).rejects.toThrow("Native private storage failed");
        await expect(homeFiles.read(root, "second")).rejects.toMatchObject({
          code: "unavailable",
        } satisfies Partial<NativePrivateFileError>);
        expect((await readFile(path.join(root, "launches"), "utf8")).trim().split("\n")).toEqual([
          "launch",
        ]);
      } finally {
        await lease.release().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);
