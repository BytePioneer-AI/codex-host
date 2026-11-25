import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { promptWindowsPath, readPromptWindows, savePromptWindows } from "../src/prompt-windows.js";

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

    // 2. Inject EACCES while releasing `.lock`; savePromptWindows must reject instead of resolving.
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
    await rm(lockFile, { force: true });
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

    // 2. Dead lock aged > STALE_LOCK_MS currently pinned by a fresh live concurrent reclaimer's
    // .claim-<livePid>-t<now> link must not be unlinked despite the old shared inode mtime.
    const racingSessionId = "dead-with-live-claim";
    const racingFile = promptWindowsPath(racingSessionId, env);
    const racingLock = `${racingFile}.lock`;
    const activeClaim = `${racingLock}.claim-${process.pid}-t${Date.now()}-active`;
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

    // 3. Aged .claim-<livePid>-t<stale> link (e.g. PID reuse) IS reclaimed past STALE_LOCK_MS.
    const reusedSessionId = "dead-with-aged-reused-pid-claim";
    const reusedFile = promptWindowsPath(reusedSessionId, env);
    const reusedLock = `${reusedFile}.lock`;
    await writeFile(
      reusedLock,
      JSON.stringify({ pid: 999_999_999, token: "dead-owner", createdAtMs: 1 }),
    );
    await link(reusedLock, `${reusedLock}.claim-${process.pid}-t${Date.now() - 60_000}-stale`);
    await utimes(reusedLock, oldDate, oldDate);

    await savePromptWindows(reusedSessionId, [{ submittedAtMs: 30, returnedAtMs: 40 }], env, {
      lockTimeoutMs: 500,
    });
    expect(await readPromptWindows(reusedSessionId, env)).toEqual([
      { submittedAtMs: 30, returnedAtMs: 40 },
    ]);
    expect(await readdir(path.dirname(reusedFile))).toEqual([`${reusedSessionId}.json`]);
  });
});
