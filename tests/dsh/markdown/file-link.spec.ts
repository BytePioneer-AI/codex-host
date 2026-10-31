import { describe, expect, it } from "vitest";
import { parseFileLink } from "@deepseek-ai/dsh-client-ui-primitives/src/markdown/file-link.ts";

describe("local Markdown file locations", () => {
  it.each([
    ["src/index.ts:24", "src/index.ts", 24],
    ["./README:24", "./README", 24],
    ["./Makefile:12", "./Makefile", 12],
    ["src/index.ts:24:5", "src/index.ts", 24],
    ["src/index.ts:24:0", "src/index.ts", 24],
    ["src/index.ts:0:5", "src/index.ts", undefined],
    ["src/index.ts:0", "src/index.ts", undefined],
    ["src/index.ts:30-24", "src/index.ts", undefined],
    ["src/index.ts:9007199254740992", "src/index.ts", undefined],
    ["src/index.ts:1-9007199254740992", "src/index.ts", undefined],
    ["../docs/My%20Notes.md:24-30", "../docs/My Notes.md", 24],
    ["src/index.ts:024", "src/index.ts", 24],
    ["file.ts#heading", "file.ts", undefined],
    ["file.ts#L0", "file.ts", undefined],
    ["file.ts#L3-L2", "file.ts", undefined],
    ["file.ts#L024", "file.ts", 24],
    ["docs/notes%3A24", "docs/notes:24", undefined],
    ["docs/notes%3A24:30", "docs/notes:24", 30],
    ["docs/notes:24#L3", "docs/notes:24", 3],
    ["docs/notes:review", "docs/notes:review", undefined],
    ["C:/work/file.ts:2", "C:/work/file.ts", 2],
    ["C:%5Cwork%5Cfile.ts:2-3", "C:\\work\\file.ts", 2],
    ["file:///C:/My%20Files/a.ts:24", "C:/My Files/a.ts", 24],
    ["file://localhost/tmp/a.ts:24:3", "/tmp/a.ts", 24],
    ["file:///tmp/a.ts#L24-L30", "/tmp/a.ts", 24],
    ["file:///tmp/notes%3A24", "/tmp/notes:24", undefined],
    ["docs/%E4%B8%AD%E6%96%87.md:12", "docs/中文.md", 12],
    ["file%23name%3F.txt", "file#name?.txt", undefined],
  ])("parses %s", (value, path, line) => {
    expect(parseFileLink(value)).toEqual(line === undefined ? { path } : { path, line });
  });

  it.each([
    "javascript:123",
    "%6Aavascript:123",
    "data:123",
    "blob:123",
    "vbscript:123",
    "https://example.com:8080",
    "https:123",
    "mailto:123",
    "thread://id?hostId=local",
    "localhost:3000",
    "index.ts:24",
    "C:123",
    ":24",
    "#L2",
    "",
    "file.ts?raw=1",
    "file%ZZ.ts",
    "file%00.ts",
    "file://remote/tmp/a.ts:24",
    "file:/tmp/a.ts",
    "file:///tmp/a.ts?raw=1",
    "//server/file:24",
    "%5C%5Cserver%5Cfile:24",
  ])(
    "does not reinterpret a URL, network path or malformed destination as a local file: %s",
    (value) => {
      expect(parseFileLink(value)).toBeUndefined();
    },
  );
});
