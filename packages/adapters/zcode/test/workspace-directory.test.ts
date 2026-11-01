import { beforeEach, describe, expect, it, vi } from "vitest";
import { sameWorkspaceDirectory } from "../src/workspace-directory.js";

const entries = vi.hoisted(
  () =>
    new Map<
      string,
      {
        canonical?: string;
        dev: bigint;
        ino: bigint;
        directory?: boolean;
      }
    >(),
);
vi.mock("node:fs", () => ({
  realpathSync: (file: string) => {
    const entry = entries.get(file);
    if (!entry) throw new Error("ENOENT");
    return entry.canonical ?? file;
  },
  statSync: (file: string) => {
    const entry = entries.get(file);
    if (!entry) throw new Error("ENOENT");
    return { ...entry, isDirectory: () => entry.directory !== false };
  },
}));
beforeEach(() => entries.clear());

describe("ZCode workspace directory identity", () => {
  it.each([
    ["C:\\Work\\项目", "c:/Work/项目/"],
    ["C:\\Work\\项目", "C:\\WORK\\项目"],
    ["\\\\server\\share\\项目", "\\\\?\\UNC\\server\\share\\项目"],
    ["C:\\Junction", "D:\\Actual Directory"],
  ])("accepts %s and %s only when the filesystem identifies the same directory", (left, right) => {
    entries.set(left, { dev: 1n, ino: 9007199254740993n });
    entries.set(right, { dev: 1n, ino: 9007199254740993n });
    expect(sameWorkspaceDirectory(left, right)).toBe(true);
  });

  it("does not lowercase paths on a case-sensitive Windows directory", () => {
    entries.set("C:\\Work\\Foo", { dev: 1n, ino: 10n });
    entries.set("C:\\Work\\foo", { dev: 1n, ino: 11n });
    expect(sameWorkspaceDirectory("C:\\Work\\Foo", "C:\\Work\\foo")).toBe(false);
  });

  it("does not equate matching file IDs on different volumes", () => {
    entries.set("C:\\Work", { dev: 1n, ino: 10n });
    entries.set("D:\\Work", { dev: 2n, ino: 10n });
    expect(sameWorkspaceDirectory("C:\\Work", "D:\\Work")).toBe(false);
  });

  it("does not accept unknown zero file IDs", () => {
    entries.set("C:\\One", { dev: 0n, ino: 0n });
    entries.set("C:\\Two", { dev: 0n, ino: 0n });
    expect(sameWorkspaceDirectory("C:\\One", "C:\\Two")).toBe(false);
    expect(sameWorkspaceDirectory("C:\\One", "C:\\One")).toBe(true);
  });

  it("accepts canonical aliases even on filesystems without file IDs", () => {
    entries.set("C:/Work/", { canonical: "C:\\Work", dev: 0n, ino: 0n });
    entries.set("C:\\Work", { dev: 0n, ino: 0n });
    expect(sameWorkspaceDirectory("C:/Work/", "C:\\Work")).toBe(true);
  });

  it("rejects missing paths and regular files", () => {
    entries.set("C:\\file", { dev: 1n, ino: 10n, directory: false });
    expect(sameWorkspaceDirectory("C:\\missing", "C:\\missing")).toBe(false);
    expect(sameWorkspaceDirectory("C:\\file", "C:\\file")).toBe(false);
  });
});
