import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { link, mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { promptWindowsPath, readPromptWindows, savePromptWindows } from "../src/prompt-windows.js";

function currentProcessStartToken(): string {
  if (process.platform === "linux") {
    const statText = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const fields = statText
      .slice(statText.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/u);
    if (fields[19] && /^\d+$/u.test(fields[19])) return `ticks${fields[19]}`;
  }
  if (process.platform === "darwin") {
    const result = execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C" },
      timeout: 1_000,
    }).trim();
    const startedAt = Date.parse(result);
    if (Number.isFinite(startedAt)) return String(startedAt);
  }
  return String(Math.round(performance.timeOrigin));
}

function staleProcessStartToken(): string {
  if (process.platform === "linux") return "ticks1";
  const current = Number(currentProcessStartToken());
  return String((Number.isFinite(current) ? current : Math.round(performance.timeOrigin)) - 60_000);
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    readFile: vi.fn(actual.readFile),
    rm: vi.fn(actual.rm),
  };
});

const dirs: string[] = [];

afterEach(async () => {
  vi.mocked(fsPromises.open).mockRestore();
  vi.mocked(fsPromises.readFile).mockRestore();
  vi.mocked(fsPromises.rm).mockRestore();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setupEnv() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agy-prompt-windows-"));
  dirs.push(dir);
  const env = { HOME: dir, USERPROFILE: dir, CODEXHOST_DATA_DIR: dir };
  return { dir, env };
}

describe("prompt-windows cross-process lock safety", () => {
  it("never unlinks a newer live lock when a concurrent reclaimer inspects a dead lock", async () => {
    const { env } = await setupEnv();
    const sessionId = "reclaim-race";
    const file = promptWindowsPath(sessionId, env);
    const lockFile = `${file}.lock`;
    await savePromptWindows(sessionId, [{ submittedAtMs: 0, returnedAtMs: 1 }], env);
    // Seed a dead-PID lock file.
    await writeFile(
      lockFile,
      JSON.stringify({ pid: 999_999_999, token: "dead-owner", createdAtMs: 1 }),
    );

    const actualReadFile = vi.mocked(fsPromises.readFile).getMockImplementation();
    assert(actualReadFile);
    let releaseRead!: () => void;
    const paused = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let hitStaleRead!: () => void;
    const sawStaleRead = new Promise<void>((resolve) => {
      hitStaleRead = resolve;
    });

    // Pause caller A right after reading the dead lock so caller B reclaims it and holds a new live lock.
    let intercepted = false;
    vi.mocked(fsPromises.readFile).mockImplementation(((
      ...args: Parameters<typeof fsPromises.readFile>
    ) => {
      if (!intercepted && args[0] === lockFile) {
        intercepted = true;
        return (async () => {
          const content = await actualReadFile(...args);
          hitStaleRead();
          await paused;
          return content;
        })() as ReturnType<typeof fsPromises.readFile>;
      }
      return actualReadFile(...args);
    }) as typeof fsPromises.readFile);

    // Run caller A via a different session path? Same file would queue in-process via pendingWrites,
    // so simulate another process holding the live lock after B reclaims it while A is paused.
    const callerA = savePromptWindows(sessionId, [{ submittedAtMs: 10, returnedAtMs: 11 }], env);
    await sawStaleRead;

    // Simulate process B reclaiming the dead lock and acquiring its own live lock before A resumes.
    await rm(lockFile);
    const livePayload = JSON.stringify({
      pid: process.pid,
      token: "live-process-b",
      createdAtMs: Date.now(),
    });
    await writeFile(lockFile, livePayload);

    // Let A resume: A must NOT delete B's live lock (its claim snapshot sees livePayload !== dead-owner).
    releaseRead();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await actualReadFile(lockFile, "utf8")).toBe(livePayload);

    // Process B writes its window and releases its lock; A then acquires the lock and merges cleanly.
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        windows: [
          { submittedAtMs: 0, returnedAtMs: 1 },
          { submittedAtMs: 20, returnedAtMs: 21 },
        ],
      }),
    );
    await rm(lockFile);
    await callerA;

    expect(await readPromptWindows(sessionId, env)).toEqual([
      { submittedAtMs: 0, returnedAtMs: 1 },
      { submittedAtMs: 10, returnedAtMs: 11 },
      { submittedAtMs: 20, returnedAtMs: 21 },
    ]);
    expect(await readdir(path.dirname(file))).toEqual([`${sessionId}.json`]);
  });

  it("never evicts a live lock owner even when the lock file mtime exceeds the stale threshold", async () => {
    const { env } = await setupEnv();
    const sessionId = "live-owner-aged";
    const file = promptWindowsPath(sessionId, env);
    const lockFile = `${file}.lock`;
    await mkdir(path.dirname(file), { recursive: true });
    const livePayload = JSON.stringify({
      pid: process.pid,
      token: "live-holder",
      createdAtMs: Date.now() - 60_000,
    });
    await writeFile(lockFile, livePayload);
    const oldDate = new Date(Date.now() - 60_000);
    await utimes(lockFile, oldDate, oldDate);

    await expect(
      savePromptWindows(sessionId, [{ submittedAtMs: 10, returnedAtMs: 11 }], env, {
        lockTimeoutMs: 80,
      }),
    ).rejects.toThrow("Timed out acquiring prompt windows lock");
    expect(await fsPromises.readFile(lockFile, "utf8")).toBe(livePayload);
    await rm(lockFile);
  });

  it("leaves no lock file on lock-payload write failure and surfaces lock-release EACCES", async () => {
    const { env } = await setupEnv();
    const sessionId = "fault-cleanup";
    const file = promptWindowsPath(sessionId, env);
    const lockFile = `${file}.lock`;

    // 1. Inject EIO while writing the lock payload; no `.lock` or `.publish-*` file may remain.
    const actualOpen = vi.mocked(fsPromises.open).getMockImplementation();
    assert(actualOpen);
    vi.mocked(fsPromises.open).mockImplementationOnce(async (...args) => {
      const handle = await actualOpen(...args);
      return Object.assign(Object.create(Object.getPrototypeOf(handle)), handle, {
        writeFile: async () => {
          throw Object.assign(new Error("disk I/O error"), { code: "EIO" });
        },
        close: () => handle.close(),
      });
    });
    await expect(
      savePromptWindows(sessionId, [{ submittedAtMs: 1, returnedAtMs: 2 }], env),
    ).rejects.toMatchObject({ code: "EIO" });
    expect(await readdir(path.dirname(file))).toEqual([]);

    // 2. Inject EACCES while releasing `.lock`; savePromptWindows must reject instead of resolving,
    // and once EACCES clears the next save must automatically release the leftover own-process lock.
    const actualRm = vi.mocked(fsPromises.rm).getMockImplementation();
    assert(actualRm);
    vi.mocked(fsPromises.rm).mockImplementation(((...args: Parameters<typeof fsPromises.rm>) => {
      if (args[0] === lockFile) {
        return Promise.reject(Object.assign(new Error("permission denied"), { code: "EACCES" }));
      }
      return actualRm(...args);
    }) as typeof fsPromises.rm);
    await expect(
      savePromptWindows(sessionId, [{ submittedAtMs: 1, returnedAtMs: 2 }], env),
    ).rejects.toMatchObject({ code: "EACCES" });
    vi.mocked(fsPromises.rm).mockImplementation(actualRm);
    // Without manually removing lockFile, subsequent save must recover and merge both windows.
    await savePromptWindows(sessionId, [{ submittedAtMs: 3, returnedAtMs: 4 }], env, {
      lockTimeoutMs: 500,
    });
    expect(await readPromptWindows(sessionId, env)).toEqual([
      { submittedAtMs: 1, returnedAtMs: 2 },
      { submittedAtMs: 3, returnedAtMs: 4 },
    ]);
    expect(await readdir(path.dirname(file))).toEqual([`${sessionId}.json`]);
  });

  it.each(["publish", "claim"] as const)(
    "reclaims a dead lock that still has an orphan .%s-<deadPid> hard link",
    async (kind) => {
      const { env } = await setupEnv();
      const sessionId = `orphan-${kind}`;
      const file = promptWindowsPath(sessionId, env);
      const lockFile = `${file}.lock`;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        lockFile,
        JSON.stringify({ pid: 999_999_999, token: "dead-owner", createdAtMs: 1 }),
      );
      await link(lockFile, `${lockFile}.${kind}-999999999-orphan`);
      expect((await stat(lockFile)).nlink).toBe(2);

      await savePromptWindows(sessionId, [{ submittedAtMs: 10, returnedAtMs: 20 }], env, {
        lockTimeoutMs: 500,
      });

      expect(await readPromptWindows(sessionId, env)).toEqual([
        { submittedAtMs: 10, returnedAtMs: 20 },
      ]);
      expect(await readdir(path.dirname(file))).toEqual([`${sessionId}.json`]);
    },
  );

  it("never evicts a live lock or active live reclaimer when extra hard links exist", async () => {
    const { env } = await setupEnv();

    // 1. Live lock owner with an orphan sibling link must never be evicted.
    const liveSessionId = "live-with-orphan";
    const liveFile = promptWindowsPath(liveSessionId, env);
    const liveLock = `${liveFile}.lock`;
    await mkdir(path.dirname(liveFile), { recursive: true });
    const livePayload = JSON.stringify({
      pid: process.pid,
      token: "live-owner",
      createdAtMs: Date.now() - 60_000,
    });
    await writeFile(liveLock, livePayload);
    await link(liveLock, `${liveLock}.publish-999999999-orphan`);
    const oldDate = new Date(Date.now() - 60_000);
    await utimes(liveLock, oldDate, oldDate);

    await expect(
      savePromptWindows(liveSessionId, [{ submittedAtMs: 1, returnedAtMs: 2 }], env, {
        lockTimeoutMs: 80,
      }),
    ).rejects.toThrow("Timed out acquiring prompt windows lock");
    expect(await fsPromises.readFile(liveLock, "utf8")).toBe(livePayload);
    await rm(liveLock);
    await rm(`${liveLock}.publish-999999999-orphan`);

    // 2. Dead lock aged > STALE_LOCK_MS currently pinned by a live concurrent reclaimer's
    // .claim-<livePid>-<liveStart> link must NEVER be unlinked even when aged past STALE_LOCK_MS.
    const racingSessionId = "dead-with-live-claim";
    const racingFile = promptWindowsPath(racingSessionId, env);
    const racingLock = `${racingFile}.lock`;
    const activeClaim = `${racingLock}.claim-${process.pid}-${currentProcessStartToken()}-active`;
    await writeFile(
      racingLock,
      JSON.stringify({ pid: 999_999_999, token: "dead-owner", createdAtMs: 1 }),
    );
    await link(racingLock, activeClaim);
    await utimes(racingLock, oldDate, oldDate);

    await expect(
      savePromptWindows(racingSessionId, [{ submittedAtMs: 1, returnedAtMs: 2 }], env, {
        lockTimeoutMs: 80,
      }),
    ).rejects.toThrow("Timed out acquiring prompt windows lock");
    expect((await stat(racingLock)).nlink).toBe(2);
    expect((await stat(activeClaim)).ino).toBe((await stat(racingLock)).ino);
    await rm(activeClaim);
    await rm(racingLock);

    // 3. Reused-PID orphan .claim-<livePid>-<staleStart> link IS reclaimed cleanly without deadlock.
    const reusedSessionId = "dead-with-reused-pid-claim";
    const reusedFile = promptWindowsPath(reusedSessionId, env);
    const reusedLock = `${reusedFile}.lock`;
    await writeFile(
      reusedLock,
      JSON.stringify({ pid: 999_999_999, token: "dead-owner", createdAtMs: 1 }),
    );
    await link(reusedLock, `${reusedLock}.claim-${process.pid}-${staleProcessStartToken()}-stale`);
    await utimes(reusedLock, oldDate, oldDate);

    await savePromptWindows(reusedSessionId, [{ submittedAtMs: 30, returnedAtMs: 40 }], env, {
      lockTimeoutMs: 500,
    });
    expect(await readPromptWindows(reusedSessionId, env)).toEqual([
      { submittedAtMs: 30, returnedAtMs: 40 },
    ]);
    expect(await readdir(path.dirname(reusedFile))).toEqual([`${reusedSessionId}.json`]);
  });

  it("recovers after own-process claim cleanup fails with EACCES during concurrent reclaim", async () => {
    const { env } = await setupEnv();
    const sessionId = "orphan-own-claim";
    const file = promptWindowsPath(sessionId, env);
    const lockFile = `${file}.lock`;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      lockFile,
      JSON.stringify({ pid: 999_999_999, token: "dead-owner", createdAtMs: 1 }),
    );
    const externalClaim = `${lockFile}.claim-${process.pid}-${currentProcessStartToken()}-external`;
    await link(lockFile, externalClaim);

    const actualRm = vi.mocked(fsPromises.rm).getMockImplementation();
    assert(actualRm);
    vi.mocked(fsPromises.rm).mockImplementation(((...args: Parameters<typeof fsPromises.rm>) => {
      const target = String(args[0]);
      if (target.startsWith(`${lockFile}.claim-`) && target !== externalClaim) {
        return Promise.reject(Object.assign(new Error("permission denied"), { code: "EACCES" }));
      }
      return actualRm(...args);
    }) as typeof fsPromises.rm);

    await expect(
      savePromptWindows(sessionId, [{ submittedAtMs: 1, returnedAtMs: 2 }], env, {
        lockTimeoutMs: 60,
      }),
    ).rejects.toThrow("Timed out acquiring prompt windows lock");

    // Remove the external contender and clear EACCES; the previously orphaned own claim must be cleaned automatically.
    vi.mocked(fsPromises.rm).mockImplementation(actualRm);
    await rm(externalClaim);

    await savePromptWindows(sessionId, [{ submittedAtMs: 5, returnedAtMs: 6 }], env, {
      lockTimeoutMs: 500,
    });
    expect(await readPromptWindows(sessionId, env)).toEqual([
      { submittedAtMs: 5, returnedAtMs: 6 },
    ]);
    expect(await readdir(path.dirname(file))).toEqual([`${sessionId}.json`]);
  });

  it("retries transient Windows read errors and surfaces persistent read failures", async () => {
    const { env } = await setupEnv();
    const sessionId = "win-read-retry";
    const file = promptWindowsPath(sessionId, env);
    await savePromptWindows(sessionId, [{ submittedAtMs: 1_000, returnedAtMs: 2_000 }], env);

    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const actualReadFile = vi.mocked(fsPromises.readFile).getMockImplementation();
    assert(actualReadFile);
    try {
      let failedOnce = false;
      vi.mocked(fsPromises.readFile).mockImplementation(((
        ...args: Parameters<typeof fsPromises.readFile>
      ) => {
        if (!failedOnce && args[0] === file) {
          failedOnce = true;
          return Promise.reject(Object.assign(new Error("file busy"), { code: "EBUSY" }));
        }
        return actualReadFile(...args);
      }) as typeof fsPromises.readFile);

      expect(await readPromptWindows(sessionId, env)).toEqual([
        { submittedAtMs: 1_000, returnedAtMs: 2_000 },
      ]);

      vi.mocked(fsPromises.readFile).mockImplementation(((
        ...args: Parameters<typeof fsPromises.readFile>
      ) => {
        if (args[0] === file) {
          return Promise.reject(Object.assign(new Error("access denied"), { code: "EACCES" }));
        }
        return actualReadFile(...args);
      }) as typeof fsPromises.readFile);

      await expect(readPromptWindows(sessionId, env)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it.skipIf(process.platform !== "darwin")(
    "never evicts a live lock held by a process launched via shell exec after delay",
    async () => {
      const { env } = await setupEnv();
      const sessionId = "shell-exec-owner";
      const file = promptWindowsPath(sessionId, env);
      const lockFile = `${file}.lock`;
      const moduleUrl = pathToFileURL(
        path.resolve(import.meta.dirname, "../src/prompt-windows.ts"),
      ).href;

      // Hold the real `.lock` created by `savePromptWindows` by placing a POSIX FIFO at `file`
      // so the child blocks in `readFile(file)` after acquiring the lock with its own startId.
      await mkdir(path.dirname(file), { recursive: true });
      execFileSync("mkfifo", [file]);

      // Sleep 6s in sh before exec'ing node so OS process creation time predates performance.timeOrigin by >5s.
      const childScript = `
        import { savePromptWindows } from ${JSON.stringify(moduleUrl)};
        await savePromptWindows(${JSON.stringify(sessionId)}, [{ submittedAtMs: 1, returnedAtMs: 2 }], process.env);
      `;
      const child = spawn(
        "/bin/sh",
        [
          "-c",
          `sleep 6; exec "$0" --import tsx --input-type=module -e "$1"`,
          process.execPath,
          childScript,
        ],
        { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
      );
      try {
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        const deadline = Date.now() + 12_000;
        let lockBefore = "";
        while (Date.now() < deadline) {
          if (child.exitCode !== null) {
            throw new Error(`child exited early (${child.exitCode}): ${stderr}`);
          }
          try {
            lockBefore = await fsPromises.readFile(lockFile, "utf8");
            if (lockBefore) break;
          } catch {
            // Lock file not created yet.
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(lockBefore).not.toBe("");
        await expect(
          savePromptWindows(sessionId, [{ submittedAtMs: 10, returnedAtMs: 20 }], env, {
            lockTimeoutMs: 100,
          }),
        ).rejects.toThrow("Timed out acquiring prompt windows lock");
        expect(await fsPromises.readFile(lockFile, "utf8")).toBe(lockBefore);
      } finally {
        child.kill("SIGKILL");
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      }
    },
    15_000,
  );
});
