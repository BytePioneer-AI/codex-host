import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  filterRetainedPromptWindows,
  promptWindowsPath,
  readPromptWindows,
  removePromptWindows,
  savePromptWindows,
} from "../src/prompt-windows.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    appendFile: vi.fn(actual.appendFile),
    readFile: vi.fn(actual.readFile),
    rm: vi.fn(actual.rm),
  };
});

const dirs: string[] = [];

afterEach(async () => {
  vi.mocked(fsPromises.appendFile).mockRestore();
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

describe("prompt-windows append-only JSONL persistence", () => {
  it("appends, deduplicates, sorts, and removes .jsonl prompt windows safely", async () => {
    const { env } = await setupEnv();
    const sessionId = "session-jsonl";
    const file = promptWindowsPath(sessionId, env);
    expect(path.basename(file)).toBe(`${sessionId}.jsonl`);

    await savePromptWindows(
      sessionId,
      [
        { submittedAtMs: 2_000, returnedAtMs: 2_500 },
        { submittedAtMs: 1_000, returnedAtMs: Number.POSITIVE_INFINITY },
        { submittedAtMs: 3_000, returnedAtMs: 2_900 },
      ],
      env,
    );
    await savePromptWindows(
      sessionId,
      [
        { submittedAtMs: 1_000, returnedAtMs: 1_500 },
        { submittedAtMs: 2_000, returnedAtMs: 2_500 },
      ],
      env,
    );

    expect(await readPromptWindows(sessionId, env)).toEqual([
      { submittedAtMs: 1_000, returnedAtMs: 1_500 },
      { submittedAtMs: 2_000, returnedAtMs: 2_500 },
    ]);
    expect(await readdir(path.dirname(file))).toEqual([`${sessionId}.jsonl`]);

    await removePromptWindows(sessionId, env);
    expect(await readPromptWindows(sessionId, env)).toEqual([]);
    expect(await readdir(path.dirname(file))).toEqual([]);
    await expect(removePromptWindows(sessionId, env)).resolves.toBeUndefined();
  });

  it("ignores malformed, truncated, and non-window lines while preserving valid JSONL entries", async () => {
    const { env } = await setupEnv();
    const sessionId = "corrupt-lines";
    const file = promptWindowsPath(sessionId, env);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      [
        "",
        '{"submittedAtMs":2000,"returnedAtMs":2500}\r',
        '{"submittedAtMs":1500,"returnedAtMs":',
        '{"submittedAtMs":-1,"returnedAtMs":100}',
        '{"submittedAtMs":3000,"returnedAtMs":2000}',
        '{"version":1,"windows":[{"submittedAtMs":1,"returnedAtMs":2}]}',
        '{"submittedAtMs":1000,"returnedAtMs":1200}',
        '{"submittedAtMs":2000,"returnedAtMs":2500}',
      ].join("\n"),
      "utf8",
    );

    expect(await readPromptWindows(sessionId, env)).toEqual([
      { submittedAtMs: 1_000, returnedAtMs: 1_200 },
      { submittedAtMs: 2_000, returnedAtMs: 2_500 },
    ]);
  });

  it("rejects invalid session IDs in promptWindowsPath and no-ops in persistence helpers", async () => {
    const { env } = await setupEnv();
    expect(() => promptWindowsPath("../escape", env)).toThrow("Invalid native Session ID");
    expect(await readPromptWindows("../escape", env)).toEqual([]);
    await expect(
      savePromptWindows("../escape", [{ submittedAtMs: 1, returnedAtMs: 2 }], env),
    ).resolves.toBeUndefined();
    await expect(removePromptWindows("../escape", env)).resolves.toBeUndefined();
  });

  it("preserves every window across concurrent multi-process appends with no lock artifacts", async () => {
    const { env } = await setupEnv();
    const sessionId = "concurrent-jsonl";
    const file = promptWindowsPath(sessionId, env);
    const moduleUrl = pathToFileURL(
      path.resolve(import.meta.dirname, "../src/prompt-windows.ts"),
    ).href;
    const expected = Array.from({ length: 6 }, (_, index) => ({
      submittedAtMs: 1_000 + index * 100,
      returnedAtMs: 1_050 + index * 100,
    }));

    await Promise.all(
      expected.map(
        (entry) =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              [
                "--import",
                "tsx",
                "--input-type=module",
                "-e",
                `import { savePromptWindows } from ${JSON.stringify(moduleUrl)};
                 await savePromptWindows(${JSON.stringify(sessionId)}, [${JSON.stringify(entry)}], process.env);`,
              ],
              { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
            );
            let stderr = "";
            child.stderr.on("data", (chunk: Buffer) => {
              stderr += chunk.toString("utf8");
            });
            child.once("error", reject);
            child.once("exit", (code) => {
              if (code === 0) resolve();
              else reject(new Error(`child exited (${String(code)}): ${stderr}`));
            });
          }),
      ),
    );

    expect(await readPromptWindows(sessionId, env)).toEqual(expected);
    expect(await readdir(path.dirname(file))).toEqual([`${sessionId}.jsonl`]);
  });

  it("filters retained windows strictly when cutoff has no step metadata timestamps", () => {
    const windows = [
      { submittedAtMs: 1_000, returnedAtMs: 1_500 },
      { submittedAtMs: 2_000, returnedAtMs: 2_500 },
      { submittedAtMs: 3_000, returnedAtMs: Number.POSITIVE_INFINITY },
    ];
    expect(filterRetainedPromptWindows(windows, undefined, undefined)).toEqual([
      { submittedAtMs: 1_000, returnedAtMs: 1_500 },
      { submittedAtMs: 2_000, returnedAtMs: 2_500 },
    ]);
    expect(filterRetainedPromptWindows(windows, 0, 5_000)).toEqual([]);
    expect(filterRetainedPromptWindows(windows, 4, undefined)).toEqual([]);
    expect(filterRetainedPromptWindows(windows, 4, 1_999)).toEqual([
      { submittedAtMs: 1_000, returnedAtMs: 1_500 },
    ]);
    expect(filterRetainedPromptWindows(windows, 4, 2_000)).toEqual([
      { submittedAtMs: 1_000, returnedAtMs: 1_500 },
      { submittedAtMs: 2_000, returnedAtMs: 2_500 },
    ]);
  });

  it("retries transient Windows read, append, and remove errors and surfaces persistent failures", async () => {
    const { env } = await setupEnv();
    const sessionId = "win-retry";
    const file = promptWindowsPath(sessionId, env);

    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const actualAppendFile = vi.mocked(fsPromises.appendFile).getMockImplementation();
    const actualReadFile = vi.mocked(fsPromises.readFile).getMockImplementation();
    const actualRm = vi.mocked(fsPromises.rm).getMockImplementation();
    assert(actualAppendFile && actualReadFile && actualRm);
    try {
      let appendFailedOnce = false;
      vi.mocked(fsPromises.appendFile).mockImplementation(((
        ...args: Parameters<typeof fsPromises.appendFile>
      ) => {
        if (!appendFailedOnce && args[0] === file) {
          appendFailedOnce = true;
          return Promise.reject(Object.assign(new Error("file busy"), { code: "EBUSY" }));
        }
        return actualAppendFile(...args);
      }) as typeof fsPromises.appendFile);
      await savePromptWindows(sessionId, [{ submittedAtMs: 1_000, returnedAtMs: 2_000 }], env);

      let readFailedOnce = false;
      vi.mocked(fsPromises.readFile).mockImplementation(((
        ...args: Parameters<typeof fsPromises.readFile>
      ) => {
        if (!readFailedOnce && args[0] === file) {
          readFailedOnce = true;
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

      let rmFailedOnce = false;
      vi.mocked(fsPromises.rm).mockImplementation(((...args: Parameters<typeof fsPromises.rm>) => {
        if (!rmFailedOnce && args[0] === file) {
          rmFailedOnce = true;
          return Promise.reject(Object.assign(new Error("permission denied"), { code: "EPERM" }));
        }
        return actualRm(...args);
      }) as typeof fsPromises.rm);
      await removePromptWindows(sessionId, env);
      vi.mocked(fsPromises.readFile).mockImplementation(actualReadFile);
      expect(await readPromptWindows(sessionId, env)).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
});
