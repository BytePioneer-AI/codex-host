import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  LocalMediaMarkdownStream,
  linkableLocalMediaPath,
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
const exists = (absolutePath: string) => files.has(path.resolve(absolutePath));
const roots = [workspace];
/** Markdown spelling of an absolute path: Windows drive paths use forward slashes. */
const md = (absolutePath: string) => absolutePath.replaceAll("\\", "/");
const at = (file: string) => md(path.join(workspace, file));
const rewrite = (text: string, holdIncomplete = false) =>
  rewriteLocalMediaMarkdown(text, roots, { exists, holdIncomplete });

describe("rewriteLocalMediaMarkdown", () => {
  it("makes relative image destinations absolute", () => {
    expect(rewrite("![shot](shot.png)\n![b](./sub/b.png)")).toBe(
      `![shot](${at("shot.png")})\n![b](${at("sub/b.png")})`,
    );
  });

  it("keeps non-ASCII paths and brackets paths with spaces", () => {
    expect(rewrite('![e](截图/e.png) ![c](<dir with space/c.png> "title")')).toBe(
      `![e](${at("截图/e.png")}) ![c](<${at("dir with space/c.png")}> "title")`,
    );
  });

  it("writes Windows paths so Markdown escapes cannot drop a separator", () => {
    const rewritten = rewrite("![d](.codex/d.png)");
    expect(rewritten).toBe(`![d](${at(".codex/d.png")})`);
    expect(rewritten).not.toMatch(/\\[!-/:-@[-`{-~]/u);
  });

  it("resolves file URLs and absolute paths", () => {
    const absolute = path.join(workspace, "a.png");
    expect(rewrite(`![a](${pathToFileURL(absolute).href}) and \`${absolute}\``)).toBe(
      `![a](${at("a.png")}) and\n\n![a.png](${at("a.png")})`,
    );
  });

  it("leaves remote, missing, and unparsed references byte-for-byte unchanged", () => {
    const text = [
      "![remote](https://example.com/a.png)",
      "![missing](missing.png)",
      "![escaped](missing\\(1\\).png)",
      "`npm test` and `a.txt`",
      "```md\n![a](a.png)\n`a.png`\n```",
    ].join("\n");
    expect(rewrite(text)).toBe(text);
  });

  it("does not let a malformed image or stray backtick stop later rewrites", () => {
    expect(rewrite("![a](a.png bad) then `\nand ![x](x.png)")).toBe(
      `![a](a.png bad) then \`\nand ![x](${at("x.png")})`,
    );
  });

  it("puts a media path written as inline code on its own line, punctuation first", () => {
    const a = at("a.png");
    // Grok's usual reply: the image follows the sentence instead of splitting it.
    expect(rewrite("画好了，是一只大肥鱼：`a.png`。")).toBe(
      `画好了，是一只大肥鱼。\n\n![a.png](${a})`,
    );
    expect(rewrite("看图：`a.png`\n然后继续")).toBe(`看图：\n\n![a.png](${a})\n\n然后继续`);
    expect(rewrite("see `a.png`. Next")).toBe(`see.\n\n![a.png](${a})\n\nNext`);
    expect(rewrite("前文\n\n`a.png`")).toBe(`前文\n\n![a.png](${a})`);
    // Nothing on the line to move punctuation onto.
    expect(rewrite("`a.png`。")).toBe(`![a.png](${a})。`);
    // A table row or heading cannot hold a block.
    expect(rewrite("| 图 | `a.png` |")).toBe(`| 图 | ![a.png](${a}) |`);
    expect(rewrite("# `a.png`")).toBe(`# ![a.png](${a})`);
  });

  it("shows a link to local media as an image and leaves other links alone", () => {
    const a = at("a.png");
    // Grok sometimes links the generated file instead of embedding it.
    expect(rewrite("画好了：\n\n[Claude 御姐](a.png)\n\n想改再说。")).toBe(
      `画好了：\n\n![Claude 御姐](${a})\n\n想改再说。`,
    );
    expect(rewrite("见 [图](sub/b.png)。")).toBe(`见。\n\n![图](${at("sub/b.png")})`);
    const unchanged = [
      "[site](https://example.com/a.png)",
      "[notes](notes.txt) and [gone](missing.png)",
      "- [ ] task\n- [x] done [1]",
      `[![badge](${a})](a.png)`,
    ].join("\n");
    expect(rewrite(unchanged)).toBe(unchanged);
  });

  it("follows CommonMark fences: line-start openers and matching closers only", () => {
    const a = at("a.png");
    const fenced = [
      "````md\n```\n![a](a.png)\n```\n`a.png`\n````",
      "~~~\n[x](a.png) `a.png`\n~~~",
      "  ```\n`a.png`\n  ``` \t",
      // Not closed: a shorter run, the other marker, or text after the run.
      "```\n`a.png`\n``\n~~~\n``` x\n`a.png`",
    ];
    for (const text of fenced) expect(rewrite(text), text).toBe(text);
    // A fence ends at a matching line, and media after it is rewritten again.
    expect(rewrite("~~~~\n`a.png`\n~~~~~\nafter `a.png`")).toBe(
      `~~~~\n\`a.png\`\n~~~~~\nafter\n\n![a.png](${a})`,
    );
    // A CRLF line ending closes a fence too.
    expect(rewrite("```\r\n`a.png`\r\n``` \r\nafter `a.png`")).toBe(
      `\`\`\`\r\n\`a.png\`\r\n\`\`\` \r\nafter\n\n![a.png](${a})`,
    );
    // Backtick runs inside a line are not fences, so later media still resolves.
    expect(rewrite("use ``` here, then ![a](a.png)")).toBe(`use \`\`\` here, then ![a](${a})`);
    expect(rewrite("    ```\n`a.png`")).toBe(`    \`\`\`\n\n![a.png](${a})`);
  });

  it("holds only a trailing construct that later text could still change", () => {
    expect(rewrite("见 [图](sub/b", true)).toBe("见");
    expect(rewrite("大肥鱼：`a.png`", true)).toBe("大肥鱼");
    expect(rewrite("大肥鱼：", true)).toBe("大肥鱼");
    expect(rewrite("see ![a](a.p", true)).toBe("see ![a](");
    expect(rewrite("see `a.p", true)).toBe("see");
    expect(rewrite("see ![a", true)).toBe("see ![");
    expect(rewrite("![a](a.png bad) then ` stray\nmore", true)).toBe(
      "![a](a.png bad) then ` stray\nmore",
    );
  });

  it("resolves relative paths against roots in order", () => {
    const first = path.join(workspace, "sub");
    expect(resolveLocalMediaPath("b.png", [first, workspace], exists)).toBe(
      path.join(first, "b.png"),
    );
    expect(resolveLocalMediaPath("notes.txt", roots, () => true)).toBeNull();
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
    "![e](截图/e.png)。",
    "画好了，是一只大肥鱼：`a.png`。后面",
    "see `a.png`. Next `x.png`",
    "| 图 | `a.png` |\n`sub/b.png`：",
    "前文\n\n`a.png`",
    "画好了：\n\n[Claude 御姐](a.png)\n\n后面",
    "[x](a.png) and [y](notes.txt) - [ ] t [z](https://e/a.png)",
    "````\n```\n`a.png`\n```\n````\nthen `a.png`",
    "~~~\n![a](a.png)\n~~\n~~~ \nafter ![a](a.png)",
    "use ``` here `a.png`",
    "```\r\n`a.png`\r\n```\r\nthen `a.png`",
  ];

  function streamed(text: string, cuts: readonly number[]): { deltas: string[]; text: string } {
    const stream = new LocalMediaMarkdownStream(roots, exists);
    const deltas: string[] = [];
    let start = 0;
    for (const end of [...cuts, text.length]) {
      deltas.push(stream.append(text.slice(start, end)));
      start = end;
    }
    deltas.push(stream.flush());
    expect(stream.text).toBe(deltas.join(""));
    return { deltas, text: stream.text };
  }

  it("publishes the same text as a one-shot rewrite for every split", () => {
    for (const sample of samples) {
      const expected = rewrite(sample);
      for (let first = 0; first <= sample.length; first += 1) {
        for (let second = first; second <= sample.length; second += 1) {
          expect(streamed(sample, [first, second]).text, `${sample} @${first},${second}`).toBe(
            expected,
          );
        }
      }
      const characters = Array.from({ length: sample.length }, (_, index) => index);
      expect(streamed(sample, characters).text).toBe(expected);
    }
  });

  it("does not hold settled text while the stream is open", () => {
    const stream = new LocalMediaMarkdownStream(roots, exists);
    expect(stream.append("x ` stray\nthen ![a](a.png) and ![b](sub/")).toBe(
      `x \` stray\nthen ![a](${at("a.png")}) and ![b](`,
    );
    expect(stream.append("b.png)")).toBe(`${at("sub/b.png")})`);
    expect(stream.flush()).toBe("");
  });

  it("checks each path once for the lifetime of a stream", () => {
    const check = vi.fn(exists);
    const stream = new LocalMediaMarkdownStream(roots, check);
    stream.append("![a](a.png) ");
    stream.append("more ");
    stream.append("text");
    stream.flush();
    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe("links to media whose path holds a literal %", () => {
  // Codex Desktop decodes a local media destination twice before it reads the file.
  const desktopPath = (destination: string) => decodeURI(decodeURI(destination));

  it("links a %-free hard link or copy of the file", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "media-percent-"));
    try {
      // Grok names a session directory after its cwd, encoded with encodeURIComponent.
      const session = path.join(temp, "sessions", "C%3A%5CUsers%5Cme%5C%E6%96%87");
      await mkdir(path.join(session, "images"), { recursive: true });
      const image = path.join(session, "images", "1%25.jpg");
      await writeFile(image, "jpeg bytes");
      const aliasRoot = path.join(temp, "media-links");
      const linkPath = (absolutePath: string) => linkableLocalMediaPath(absolutePath, aliasRoot);

      const output = rewriteLocalMediaMarkdown("![fish](images/1%25.jpg)", [session], {
        linkPath,
      });
      expect(output).toMatch(/^!\[fish\]\([^%<>]+\)$/);
      const destination = output.slice("![fish](".length, -1);
      const alias = desktopPath(destination);
      expect(alias.startsWith(md(aliasRoot) + "/")).toBe(true);
      expect(path.basename(alias)).toBe("1_25.jpg");
      expect(await readFile(alias, "utf8")).toBe("jpeg bytes");
      // The same file keeps the same alias.
      expect(rewriteLocalMediaMarkdown("`images/1%25.jpg`", [session], { linkPath })).toBe(
        `![1%25.jpg](${destination})`,
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("escapes % for both decodes when no alias can be made", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "media-percent-"));
    try {
      const image = path.join(temp, "C%3A%5Cdir", "1.png");
      await mkdir(path.dirname(image));
      await writeFile(image, "png");
      // A file where the alias directory should be makes every alias fail.
      const blocked = path.join(temp, "blocked");
      await writeFile(blocked, "");
      const destination = md(linkableLocalMediaPath(image, blocked));
      expect(destination).toContain("%2525");
      expect(path.resolve(desktopPath(destination))).toBe(image);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("leaves paths without % alone and creates no alias", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "media-percent-"));
    try {
      const aliasRoot = path.join(temp, "media-links");
      const image = path.join(workspace, "shot.png");
      expect(linkableLocalMediaPath(image, aliasRoot)).toBe(image);
      await expect(stat(aliasRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("asks the stream's link path once per file so published text stays stable", () => {
    const linkPath = vi.fn((absolutePath: string) => absolutePath + ".alias");
    const stream = new LocalMediaMarkdownStream(roots, exists, linkPath);
    let text = "";
    for (const piece of ["![a](sho", "t.png) and `shot.p", "ng` again ![b](shot.png)"])
      text += stream.append(piece);
    text += stream.flush();
    expect(text).toBe(
      `![a](${at("shot.png")}.alias) and\n\n![shot.png](${at("shot.png")}.alias)\n\nagain ![b](${at("shot.png")}.alias)`,
    );
    expect(linkPath).toHaveBeenCalledTimes(1);
  });
});
