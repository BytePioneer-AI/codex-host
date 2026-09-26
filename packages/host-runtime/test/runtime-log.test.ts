import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installRuntimeLog, runtimeLogPath } from "../src/runtime-log.js";

function fakeProcess() {
  return Object.assign(new EventEmitter(), { pid: 4242 }) as unknown as NodeJS.Process;
}

function fakeStream() {
  const written: string[] = [];
  return {
    written,
    write: ((chunk: string | Uint8Array) => {
      written.push(chunk.toString());
      return true;
    }) as NodeJS.WriteStream["write"],
  };
}

describe("Host Runtime log", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-runtime-log-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("resolves the log below the data directory", () => {
    expect(runtimeLogPath({ CODEXHOST_DATA_DIR: directory }, 4242)).toBe(
      path.join(directory, "logs", "host-runtime-4242.log"),
    );
    expect(runtimeLogPath({}, 4242)).toBe(
      path.join(os.homedir(), ".codexhost", "logs", "host-runtime-4242.log"),
    );
  });

  it("keeps stderr diagnostics with timestamps and still forwards them", async () => {
    const filePath = path.join(directory, "logs", "host-runtime.log");
    const stream = fakeStream();
    const uninstall = installRuntimeLog({ filePath, stream, process: fakeProcess() });
    stream.write("codexhost Host Runtime: first\n");
    stream.write("partial ");
    stream.write(Buffer.from("line\n"));
    uninstall();
    stream.write("after uninstall\n");

    expect(stream.written).toEqual([
      "codexhost Host Runtime: first\n",
      "partial ",
      "line\n",
      "after uninstall\n",
    ]);
    const lines = (await readFile(filePath, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z \[4242\] Host Runtime started$/u);
    expect(lines[1]).toMatch(/ \[4242\] codexhost Host Runtime: first$/u);
    expect(lines[2]).toMatch(/ \[4242\] partial line$/u);
  });

  it("records a fatal stack and the exit code without handling the error", async () => {
    const filePath = path.join(directory, "host-runtime.log");
    // Emit through the plain emitter: Node's typed emit does not list the monitor event.
    const emitter = Object.assign(new EventEmitter(), { pid: 4242 });
    installRuntimeLog({
      filePath,
      stream: fakeStream(),
      process: emitter as unknown as NodeJS.Process,
    });
    emitter.emit(
      "uncaughtExceptionMonitor",
      new TypeError("synthetic crash"),
      "unhandledRejection",
    );
    emitter.emit("exit", 1);

    const text = await readFile(filePath, "utf8");
    expect(text).toContain("FATAL unhandledRejection: TypeError: synthetic crash");
    expect(text).toContain("runtime-log.test.ts");
    expect(text).toContain("Host Runtime exited with code 1");
    // Monitoring must not register a handler that would keep a crashed process alive.
    expect(emitter.listenerCount("uncaughtException")).toBe(0);
  });

  it("rotates once the size limit is reached and keeps one previous file", async () => {
    const filePath = path.join(directory, "host-runtime.log");
    const stream = fakeStream();
    installRuntimeLog({ filePath, stream, process: fakeProcess(), maxBytes: 400 });
    for (let index = 0; index < 20; index += 1) stream.write(`diagnostic line ${index}\n`);

    const current = await readFile(filePath, "utf8");
    const previous = await readFile(`${filePath}.1`, "utf8");
    expect(Buffer.byteLength(current)).toBeLessThanOrEqual(400);
    expect(Buffer.byteLength(previous)).toBeLessThanOrEqual(400);
    expect(current).toContain("diagnostic line 19");
    expect(previous).not.toContain("diagnostic line 19");
  });

  it("never lets a logging failure reach the Runtime", async () => {
    const blocker = path.join(directory, "not-a-directory");
    await writeFile(blocker, "");
    const stream = fakeStream();
    expect(() =>
      installRuntimeLog({
        filePath: path.join(blocker, "host-runtime.log"),
        stream,
        process: fakeProcess(),
      }),
    ).not.toThrow();
    expect(stream.write("still forwarded\n")).toBe(true);
    expect(stream.written).toEqual(["still forwarded\n"]);
  });

  it("keeps concurrent Runtime logs and their rotations independent", async () => {
    const first = fakeStream();
    const second = fakeStream();
    const firstPath = runtimeLogPath({ CODEXHOST_DATA_DIR: directory }, 4242);
    const secondPath = runtimeLogPath({ CODEXHOST_DATA_DIR: directory }, 4243);
    const firstStop = installRuntimeLog({
      filePath: firstPath,
      stream: first,
      process: fakeProcess(),
      maxBytes: 200,
    });
    const secondStop = installRuntimeLog({
      filePath: secondPath,
      stream: second,
      process: Object.assign(new EventEmitter(), { pid: 4243 }) as NodeJS.Process,
      maxBytes: 200,
    });
    for (let index = 0; index < 20; index += 1) {
      first.write(`first runtime ${index}\n`);
      second.write(`second runtime ${index}\n`);
    }
    firstStop();
    secondStop();
    for (const [index, filePath] of [firstPath, secondPath].entries()) {
      for (const suffix of ["", ".1"]) {
        const text = await readFile(`${filePath}${suffix}`, "utf8");
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(200);
        expect(text).toContain(index === 0 ? "first runtime" : "second runtime");
        expect(text).not.toContain(index === 0 ? "second runtime" : "first runtime");
      }
    }
  });

  it("bounds oversized writes and preserves a complete UTF-8 tail", async () => {
    const filePath = path.join(directory, "host-runtime.log");
    const stream = fakeStream();
    const stop = installRuntimeLog({ filePath, stream, process: fakeProcess(), maxBytes: 100 });
    const oversized = `${"中😀".repeat(100)}tail\n`;
    stream.write(oversized);
    stop();
    const current = await readFile(filePath, "utf8");
    expect(Buffer.byteLength(current)).toBeLessThanOrEqual(100);
    expect(current).toMatch(/tail\n$/u);
    expect(current).not.toContain("\uFFFD");
    expect((await stat(`${filePath}.1`)).size).toBeLessThanOrEqual(100);
    expect(stream.written).toEqual([oversized]);
  });

  it("bounds the first write to an empty file", async () => {
    const filePath = path.join(directory, "host-runtime.log");
    const stop = installRuntimeLog({
      filePath,
      stream: fakeStream(),
      process: fakeProcess(),
      maxBytes: 16,
    });
    stop();
    expect((await stat(filePath)).size).toBeLessThanOrEqual(16);
  });

  it.skipIf(process.platform === "win32")(
    "restricts existing and rotated log permissions",
    async () => {
      const logs = path.join(directory, "logs");
      const filePath = path.join(logs, "host-runtime.log");
      await mkdir(logs);
      await chmod(logs, 0o755);
      await writeFile(filePath, "old current\n");
      await writeFile(`${filePath}.1`, "old previous\n");
      await chmod(filePath, 0o666);
      await chmod(`${filePath}.1`, 0o666);
      const stream = fakeStream();
      const stop = installRuntimeLog({ filePath, stream, process: fakeProcess(), maxBytes: 100 });
      expect((await stat(logs)).mode & 0o777).toBe(0o700);
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      expect((await stat(`${filePath}.1`)).mode & 0o777).toBe(0o600);
      stream.write("x".repeat(150));
      stop();
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      expect((await stat(`${filePath}.1`)).mode & 0o777).toBe(0o600);
    },
  );
});
