import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  LocalMediaMarkdownStream,
  resolveLocalMediaPath,
  rewriteLocalMediaMarkdown,
} from "../src/local-media-markdown.js";

const workspace = path.resolve("test-fixtures/media-workspace");
const files = new Set(
  [
    "shot.png",
    "a.png",
    "x.png",
    "sub/b.png",
    "dir with space/c.png",
    ".codex/d.png",
    "截图/e.png",
  ].map((file) => path.join(workspace, file)),
);
const exists = (absolutePath: string) => files.has(absolutePath);
const roots = [workspace];
const md = (absolutePath: string) => absolutePath.replaceAll("\\", "/");
const at = (file: string) => md(path.join(workspace, file));
const rewrite = (text: string, holdIncomplete = false) =>
  rewriteLocalMediaMarkdown(text, roots, { exists, holdIncomplete });

const containerCode = [
  "> ```md\n> [x](a.png) `a.png`\n> ```\nafter ![a](a.png)",
  "- ```md\n  ![a](a.png)\n  ```\nafter `a.png`",
  "1. ~~~~\n   `a.png`\n   ~~~~\n![a](a.png)",
  "> - ~~~\n>   ![a](a.png)\n>   ~~~",
  "    ```\n    ![a](a.png)\n    ```",
  "\t~~~\n\t`a.png`\n\t~~~",
  "- item\n  ```\n  ![a](a.png)\n```\n![a](a.png)\n```",
];

describe("rewriteLocalMediaMarkdown", () => {
  it("resolves images and single media code spans without changing surrounding text", () => {
    expect(rewrite("![shot](shot.png)\n![b](./sub/b.png)")).toBe(
      `![shot](${at("shot.png")})\n![b](${at("sub/b.png")})`,
    );
    expect(rewrite("鱼：`a.png`。 后文\n# `a.png`\n| `a.png` |")).toBe(
      `鱼：![a.png](${at("a.png")})。 后文\n# ![a.png](${at("a.png")})\n| ![a.png](${at("a.png")}) |`,
    );
    expect(rewrite("[图](a.png) and [site](https://example.com/a.png)")).toBe(
      "[图](a.png) and [site](https://example.com/a.png)",
    );
  });

  it("keeps non-ASCII paths and brackets paths with spaces", () => {
    expect(rewrite('![e](截图/e.png) ![c](<dir with space/c.png> "title")')).toBe(
      `![e](${at("截图/e.png")}) ![c](<${at("dir with space/c.png")}> "title")`,
    );
  });

  it("writes Windows drive separators without Markdown punctuation escapes", () => {
    expect(rewrite("![d](.codex/d.png)")).toBe(`![d](${at(".codex/d.png")})`);
    expect(rewrite("![d](.codex/d.png)")).not.toMatch(/\\[!-/:-@[-`{-~]/u);
  });

  it("normalizes file URLs before formatting the absolute path", () => {
    const absolute = path.join(workspace, "a.png");
    expect(rewrite(`![a](${pathToFileURL(absolute).href}) and \`${absolute}\``)).toBe(
      `![a](${at("a.png")}) and ![a.png](${at("a.png")})`,
    );
    expect(resolveLocalMediaPath("file:///%ZZ.png", roots, exists)).toBeNull();
  });

  it("leaves missing, remote and malformed references byte-for-byte unchanged", () => {
    const text = [
      "![remote](https://example.com/a.png)",
      "![missing](missing.png)",
      "![escaped](missing\\(1\\).png)",
      "`npm test` and `a.txt`",
    ].join("\n");
    expect(rewrite(text)).toBe(text);
    expect(rewrite("![a](a.png bad) then `\nand ![x](x.png)")).toBe(
      `![a](a.png bad) then \`\nand ![x](${at("x.png")})`,
    );
  });

  it("supports flat fences with matching markers, lengths and CRLF closers", () => {
    for (const text of [
      "````md\n```\n![a](a.png)\n```\n`a.png`\n````",
      "~~~\n[x](a.png) `a.png`\n~~~",
      "  ```\n`a.png`\n  ``` \t",
      "```\n`a.png`\n``\n~~~\n``` x\n`a.png`",
    ])
      expect(rewrite(text)).toBe(text);
    expect(rewrite("```\r\n`a.png`\r\n``` \r\nafter `a.png`")).toBe(
      `\`\`\`\r\n\`a.png\`\r\n\`\`\` \r\nafter ![a.png](${at("a.png")})`,
    );
    expect(rewrite("use ``` here, then ![a](a.png)")).toBe(
      `use \`\`\` here, then ![a](${at("a.png")})`,
    );
  });

  it("leaves the suffix from a container or indented fence-like opener untouched", () => {
    for (const text of containerCode) {
      expect(rewrite(text)).toBe(text);
      expect(rewrite(`![a](a.png)\n${text}`)).toBe(`![a](${at("a.png")})\n${text}`);
    }
  });

  it("holds only undecided constructs, not punctuation, spacing or complete media", () => {
    expect(rewrite("鱼：`a.png`。 ", true)).toBe(`鱼：![a.png](${at("a.png")})。 `);
    expect(rewrite("鱼： ", true)).toBe("鱼： ");
    expect(rewrite("see ![a](a.p", true)).toBe("see ![a](");
    expect(rewrite("see `a.p", true)).toBe("see ");
    expect(rewrite("see ![a", true)).toBe("see ![");
  });

  it("checks the resolved target's extension, not a fake prefix before ? or #", () => {
    const check = vi.fn(() => true);
    for (const marker of ["?", "#"]) {
      expect(
        resolveLocalMediaPath(`../outside/fake.png${marker}/../secret.txt`, roots, check),
      ).toBeNull();
      expect(resolveLocalMediaPath(`a.png${marker}L12`, roots, check)).toBeNull();
    }
    expect(check).not.toHaveBeenCalled();
    expect(resolveLocalMediaPath("not-media.txt/../a.png", roots, exists)).toBe(
      path.join(workspace, "a.png"),
    );
  });

  it("uses roots as search order, not as a sandbox", () => {
    const first = path.join(workspace, "sub");
    expect(resolveLocalMediaPath("b.png", [first, workspace], exists)).toBe(
      path.join(first, "b.png"),
    );
    expect(resolveLocalMediaPath("../a.png", [first], exists)).toBe(path.join(workspace, "a.png"));
    expect(resolveLocalMediaPath(path.join(workspace, "a.png"), [], exists)).toBe(
      path.join(workspace, "a.png"),
    );
  });
});

describe("LocalMediaMarkdownStream", () => {
  const samples = [
    'see `a.png` and ![b](sub/b.png "t") then ![c](missing.png)',
    "![a`x.png`](a.png) and `x.png`",
    "```md\n![a](a.png)\n```\nafter `a.png`",
    "x ` y\n![a](a.png)",
    "![a](a.png bad) then ![b](sub/b.png)",
    "![a]\n![c](<dir with space/c.png>)",
    "a!![b](sub/b.png)!",
    "``a.png`` and `a.png`` and ```",
    "鱼：`a.png`。后文 [图](a.png)",
    "| `a.png` |\n# `sub/b.png`：",
    "````\n```\n`a.png`\n```\n````\nthen `a.png`",
    "~~~\n![a](a.png)\n~~\n~~~ \nafter ![a](a.png)",
    "```\r\n`a.png`\r\n```\r\nthen `a.png`",
    ...containerCode,
  ];

  function streamed(text: string, cuts: readonly number[]): string {
    const stream = new LocalMediaMarkdownStream(roots, exists);
    let start = 0;
    let result = "";
    for (const end of [...cuts, text.length]) {
      result += stream.append(text.slice(start, end));
      start = end;
    }
    result += stream.flush();
    expect(stream.text).toBe(result);
    return result;
  }

  it("matches one-shot output at every pair of cuts and for character-sized chunks", () => {
    for (const sample of samples) {
      const expected = rewrite(sample);
      for (let first = 0; first <= sample.length; first += 1) {
        for (let second = first; second <= sample.length; second += 1) {
          expect(streamed(sample, [first, second]), `${sample} @${first},${second}`).toBe(expected);
        }
      }
      expect(
        streamed(
          sample,
          Array.from({ length: sample.length }, (_, i) => i),
        ),
      ).toBe(expected);
    }
  });

  it("emits settled text immediately and flushes incomplete text without losing bytes", () => {
    const stream = new LocalMediaMarkdownStream(roots, exists);
    expect(stream.append("text and `")).toBe("text and ");
    expect(stream.append("a.png`。 ")).toBe(`![a.png](${at("a.png")})。 `);
    expect(stream.append("![open](sub/")).toBe("![open](");
    expect(stream.flush()).toBe("sub/");
  });

  it("remembers negative and positive checks when files appear", () => {
    let present = false;
    const check = vi.fn((absolute: string) => present || exists(absolute));
    const stream = new LocalMediaMarkdownStream(roots, check);
    const a = at("a.png");
    let text = stream.append("![missing](later.png) and ![a](a.png) `");
    present = true;
    text += stream.append("later.png` and ![a](a.png)") + stream.flush();
    expect(text).toBe(`![missing](later.png) and ![a](${a}) \`later.png\` and ![a](${a})`);
    expect(check.mock.calls.map(([p]) => p)).toEqual([
      path.join(workspace, "later.png"),
      path.join(workspace, "a.png"),
    ]);
  });
});

describe("root selection during streaming", () => {
  it("does not change an earlier root decision when a higher-priority file appears", () => {
    const higher = path.join(workspace, "higher");
    let appeared = false;
    const check = (p: string) =>
      p === path.join(workspace, "a.png") || (appeared && p === path.join(higher, "a.png"));
    const stream = new LocalMediaMarkdownStream([higher, workspace], check);
    let text = stream.append("![a](a.png) ");
    appeared = true;
    text += stream.append("again ![a](a.png)") + stream.flush();
    expect(text).toBe(`![a](${at("a.png")}) again ![a](${at("a.png")})`);
    const fresh = new LocalMediaMarkdownStream([higher, workspace], check);
    expect(fresh.append("![a](a.png)") + fresh.flush()).toBe(`![a](${at("higher/a.png")})`);
  });
});

describe("literal percent paths", () => {
  it("protects every literal percent through two decodes without creating aliases", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "media-percent-"));
    try {
      const session = path.join(temp, "C%3A%5C%E6%96%87");
      await mkdir(session);
      const names = [
        "1%.png",
        "%25.png",
        "%2F.png",
        "%5C.png",
        "%E4%B8%AD.png",
        "%23%3F.png",
        "中文.png",
        "with space.png",
      ];
      if (process.platform !== "win32") names.push("a#b.png", "a?b.png");
      for (const name of names) {
        const file = path.join(session, name);
        await writeFile(file, "synthetic image");
        const expected = md(file).replaceAll("%", "%2525");
        for (const input of [pathToFileURL(file).href, name]) {
          expect(rewriteLocalMediaMarkdown(`![x](<${input}>)`, [session])).toBe(
            `![x](<${expected}>)`,
          );
        }
        expect(decodeURI(decodeURI(expected))).toBe(md(file));
        const native = `![x](<${name}>)`;
        const stream = new LocalMediaMarkdownStream([session]);
        const output = [...native].map((c) => stream.append(c)).join("") + stream.flush();
        expect(output).toBe(`![x](<${expected}>)`);
      }
      expect(await readdir(temp)).toEqual([path.basename(session)]);
      expect((await readdir(session)).sort()).toEqual([...names].sort());
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
