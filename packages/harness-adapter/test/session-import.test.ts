import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  HARNESS_SESSION_IMPORT_TITLE_MAX_LENGTH,
  harnessSessionImportCandidateSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  SessionImportChangedError,
  SessionImportScope,
  isMissingFileError,
  isStorageAccessError,
  optionalLstat,
  readStableFiles,
  sameFileFingerprint,
  sessionImportCandidate,
  sessionImportTitle,
} from "../src/session-import.js";

function scope(): SessionImportScope {
  return new SessionImportScope({
    closedMessage: "closed",
    unavailableMessage: "unavailable",
    notFoundMessage: "gone",
  });
}

describe("Session import title", () => {
  it("folds to one bounded line and never returns blank text", () => {
    expect(sessionImportTitle("  first\n\tline\0 two  ")).toBe("first line two");
    for (const value of ["", " \n\t", "\0", null, undefined, 7, {}]) {
      expect(sessionImportTitle(value)).toBeNull();
    }
  });

  it("truncates on whole characters with an ellipsis inside the limit", () => {
    expect(sessionImportTitle("abcdef", 6)).toBe("abcdef");
    expect(sessionImportTitle("abcdefg", 6)).toBe("abcde…");
    expect(sessionImportTitle("ab cdefg", 4)).toBe("ab…");
    // Six characters in twelve UTF-16 units: within the limit, and never split when cut.
    expect(sessionImportTitle("😀".repeat(6), 6)).toBe("😀".repeat(6));
    expect(sessionImportTitle("😀".repeat(7), 6)).toBe(`${"😀".repeat(5)}…`);
    const long = sessionImportTitle("x".repeat(HARNESS_SESSION_IMPORT_TITLE_MAX_LENGTH + 50));
    expect(long).toHaveLength(HARNESS_SESSION_IMPORT_TITLE_MAX_LENGTH);
  });
});

describe("Session import candidate", () => {
  const base = { nativeSessionId: "native", cwd: "/work", title: "Title", updatedAt: 1_000 };

  it("normalizes time and unknown activity into the shared contract", () => {
    expect(sessionImportCandidate(base)).toEqual({ ...base, running: null });
    expect(sessionImportCandidate({ ...base, updatedAt: 1_000.9, running: true })).toEqual({
      ...base,
      running: true,
    });
    expect(
      sessionImportCandidate({ ...base, updatedAt: "2026-01-02T03:04:05.000Z", title: "  " }),
    ).toEqual({
      ...base,
      title: null,
      updatedAt: Date.parse("2026-01-02T03:04:05.000Z"),
      running: null,
    });
    expect(sessionImportCandidate({ ...base, running: "yes" })?.running).toBeNull();
  });

  it.each([
    ["non-numeric time", { updatedAt: "not a date" }],
    ["missing time", { updatedAt: undefined }],
    ["negative time", { updatedAt: -1 }],
    ["infinite time", { updatedAt: Number.POSITIVE_INFINITY }],
    ["blank ID", { nativeSessionId: " " }],
    ["non-string ID", { nativeSessionId: 7 }],
    ["missing cwd", { cwd: undefined }],
    ["NUL in cwd", { cwd: "/a\0b" }],
    ["NUL in title", { title: "a\0b" }],
    ["oversized title", { title: "x".repeat(HARNESS_SESSION_IMPORT_TITLE_MAX_LENGTH + 1) }],
  ])("returns nothing for %s", (_name, change) => {
    expect(sessionImportCandidate({ ...base, ...change })).toBeNull();
  });

  it("only returns values the Host listing schema accepts", () => {
    const candidate = sessionImportCandidate({ ...base, title: sessionImportTitle("a\0b\nc") });
    expect(harnessSessionImportCandidateSchema.safeParse(candidate).success).toBe(true);
  });
});

describe("Session import file fingerprint", () => {
  it("detects content changes and treats absence as its own state", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-session-import-"));
    try {
      const file = path.join(directory, "session.jsonl");
      await writeFile(file, "one");
      const before = await stat(file);
      expect(sameFileFingerprint(before, await stat(file))).toBe(true);
      await writeFile(file, "one two");
      expect(sameFileFingerprint(before, await stat(file))).toBe(false);
      expect(sameFileFingerprint(null, null)).toBe(true);
      expect(sameFileFingerprint(before, null)).toBe(false);
      expect(sameFileFingerprint(null, before)).toBe(false);

      const missing = await stat(path.join(directory, "missing")).catch((error: unknown) => error);
      expect(isMissingFileError(missing)).toBe(true);
      expect(isMissingFileError(new Error("other"))).toBe(false);
      expect(isMissingFileError(null)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Session import stable read", () => {
  it("returns the value for unchanged files and rejects a read that raced a writer", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-session-import-"));
    try {
      const file = path.join(directory, "session.json");
      const absent = path.join(directory, "absent.wal");
      await writeFile(file, "one");
      expect(
        await readStableFiles([file, absent], (before) =>
          Promise.resolve([before[0]?.isFile(), before[1]]),
        ),
      ).toEqual([true, null]);
      await expect(
        readStableFiles([file, absent], async () => {
          await writeFile(file, "one two");
        }),
      ).rejects.toBeInstanceOf(SessionImportChangedError);
      // A file appearing during the read is a change too.
      await expect(
        readStableFiles([file, absent], async () => {
          await writeFile(absent, "wal");
        }),
      ).rejects.toBeInstanceOf(SessionImportChangedError);
      // The reader's own failure is not masked.
      await expect(
        readStableFiles([file], () => Promise.reject(new Error("unreadable"))),
      ).rejects.toThrow("unreadable");
      expect(await optionalLstat(path.join(directory, "missing"))).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("separates storage access failures from malformed Sessions", () => {
    for (const code of ["EACCES", "EPERM", "EIO", "EMFILE", "ENFILE"]) {
      expect(isStorageAccessError(Object.assign(new Error(code), { code }))).toBe(true);
    }
    expect(isStorageAccessError(Object.assign(new Error("gone"), { code: "ENOENT" }))).toBe(false);
    expect(isStorageAccessError(new SyntaxError("bad json"))).toBe(false);
    expect(isStorageAccessError(null)).toBe(false);
  });
});

describe("Session import scope", () => {
  it("returns values and maps failures to a bounded retryable result", async () => {
    const reads = scope();
    expect(await reads.read(() => Promise.resolve(3))).toEqual({ ok: true, value: 3 });
    expect(await reads.read(() => Promise.reject(new Error("/secret/path")))).toEqual({
      ok: false,
      error: { code: "unavailable", message: "unavailable", retryable: true },
    });
    // A synchronous throw must not escape as a rejection either.
    expect(
      await reads.read(() => {
        throw new SessionImportChangedError();
      }),
    ).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });

  it("reports a missing selected Session as not found", async () => {
    const reads = scope();
    const source = {
      candidate: { nativeSessionId: "n", cwd: "/w", title: null, updatedAt: 1, running: null },
      nativeRef: { harnessId: "pi", nativeSessionId: "n", formatVersion: 1 },
    } as never;
    expect(await reads.resolve(() => Promise.resolve(source))).toEqual({ ok: true, value: source });
    expect(await reads.resolve(() => Promise.resolve(null))).toEqual({
      ok: false,
      error: { code: "sessionNotFound", message: "gone", retryable: false },
    });
    expect(await reads.resolve(() => Promise.reject(new Error("io")))).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });

  it("cancels running reads on close, waits for them and starts nothing afterwards", async () => {
    const reads = scope();
    let settled = false;
    const closed = {
      ok: false,
      error: { code: "invalidState", message: "closed", retryable: false },
    };
    const cancelled = reads.read(
      (signal) =>
        new Promise<number>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            setTimeout(() => {
              settled = true;
              reject(new Error("aborted"));
            }, 5);
          });
        }),
    );
    // A read that ignores cancellation and still returns must not be reported as a success.
    let finish: (value: number) => void = () => undefined;
    const ignored = reads.read(() => new Promise<number>((resolve) => (finish = resolve)));
    const closing = reads.close();
    finish(1);
    await closing;

    expect(settled).toBe(true);
    expect(await cancelled).toEqual(closed);
    expect(await ignored).toEqual(closed);

    let started = false;
    expect(
      await reads.read(() => {
        started = true;
        return Promise.resolve(1);
      }),
    ).toEqual(closed);
    expect(started).toBe(false);
    await reads.close();
  });
});
