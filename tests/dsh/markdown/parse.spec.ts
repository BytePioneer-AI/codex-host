import type { Nodes } from "mdast";
import { describe, expect, it } from "vitest";
import {
  parseGfm,
  parseGfmWithMath,
} from "@deepseek-ai/dsh-client-ui-primitives/src/markdown/parse.ts";
import { parseFileLink } from "@deepseek-ai/dsh-client-ui-primitives/src/markdown/file-link.ts";

function descendants(node: Nodes): Nodes[] {
  return [node, ...("children" in node ? node.children.flatMap(descendants) : [])];
}

describe.each([parseGfm, parseGfmWithMath])("Markdown grammar %o", (parse) => {
  it("keeps single tildes literal while retaining double-tilde deletion", () => {
    const tree = parse("约 10~20 分钟，或 30~40 分钟，~~删除~~");
    expect(tree.children).toMatchObject([
      {
        type: "paragraph",
        children: [
          { type: "text", value: "约 10~20 分钟，或 30~40 分钟，" },
          { type: "delete", children: [{ type: "text", value: "删除" }] },
        ],
      },
    ]);
  });

  it.each([
    [String.raw`D:\repo\.github\a.md`, String.raw`D:\repo\.github\a.md`, undefined],
    [String.raw`<D:\My Files\.config\a_b.md>`, String.raw`D:\My Files\.config\a_b.md`, undefined],
    [String.raw`D:\.deploy\notes.md#L4`, String.raw`D:\.deploy\notes.md`, 4],
    [String.raw`D:/repo\.github\ci.yml`, String.raw`D:/repo\.github\ci.yml`, undefined],
    [String.raw`D:\R&amp;D\a&#32;b.md`, String.raw`D:\R&D\a b.md`, undefined],
    [String.raw`D:\a\(b\).md`, String.raw`D:\a\(b\).md`, undefined],
    [String.raw`src\.github\ci.yml`, String.raw`src\.github\ci.yml`, undefined],
    [String.raw`.\.env`, String.raw`.\.env`, undefined],
    [String.raw`..\.gitignore`, String.raw`..\.gitignore`, undefined],
    [String.raw`docs\_draft.md`, String.raw`docs\_draft.md`, undefined],
    [String.raw`docs/\_draft.md`, "docs/_draft.md", undefined],
    [String.raw`C:/work/\_draft.md`, "C:/work/_draft.md", undefined],
  ])("preserves the intended file destination %s", (target, path, line) => {
    const tree = parse(`[source](${target})\n\n[ref][r]\n\n[r]: ${target}`);
    const destinations = descendants(tree).filter(
      (node) => node.type === "link" || node.type === "definition",
    );
    expect(destinations).toHaveLength(2);
    for (const node of destinations) {
      expect(parseFileLink(node.url)).toEqual(line === undefined ? { path } : { path, line });
    }
    expect(descendants(tree)).toContainEqual(
      expect.objectContaining({ type: "linkReference", identifier: "r" }),
    );
  });

  it("preserves Windows image paths and normal URL escapes", () => {
    const tree = parse(String.raw`![chart](D:\img\.cache\a.png)

[source](https://example.com/a\b\_c)`);
    expect(descendants(tree)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "image", url: String.raw`D:\img\.cache\a.png` }),
        expect.objectContaining({ type: "link", url: String.raw`https://example.com/a\b_c` }),
      ]),
    );
  });

  it("retains local file URLs and the bare-space image recovery", () => {
    const tree = parse("[source](file:///C:/My%20Files/a.md#L2)\n\n![local](/tmp/my image.png)");
    const link = descendants(tree).find((node) => node.type === "link");
    expect(link?.type).toBe("link");
    if (link?.type === "link") {
      expect(parseFileLink(link.url)).toEqual({ path: "C:/My Files/a.md", line: 2 });
    }
    expect(descendants(tree)).toContainEqual(
      expect.objectContaining({ type: "image", url: "/tmp/my image.png" }),
    );
  });
});

describe("settled Markdown math", () => {
  it.each([
    ["$$a+b\nc+d$$", "a+b\nc+d"],
    ["$$a+b\nc+d\n$$", "a+b\nc+d"],
    ["Prose line\n$$a+b\nc+d$$", "a+b\nc+d"],
    ["- item\n  $$a+b\n  c+d$$", "a+b\nc+d"],
    ["- item\n$$\na+b\n$$", "a+b"],
    [
      String.raw`\[a+b
c+d\]`,
      "a+b\nc+d",
    ],
  ])("keeps the complete formula and following prose: %s", (source, value) => {
    const tree = parseGfmWithMath(`${source}\n\nAfter`);
    expect(descendants(tree).filter((node) => node.type === "math")).toMatchObject([{ value }]);
    expect(tree.children.at(-1)).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", value: "After" }],
    });
    expect(descendants(parseGfm(source)).some((node) => node.type === "math")).toBe(false);
  });

  it("leaves trailing text to inline math without swallowing the next block", () => {
    expect(parseGfmWithMath("$$x$$ trailing\n\n$$y$$").children).toMatchObject([
      {
        type: "paragraph",
        children: [
          { type: "inlineMath", value: "x" },
          { type: "text", value: " trailing" },
        ],
      },
      { type: "math", value: "y" },
    ]);
  });

  it("keeps an unclosed backslash candidate inside one strong paragraph", () => {
    const tree = parseGfmWithMath("**before\n\\[literal]\nafter**");
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]).toMatchObject({
      type: "paragraph",
      children: [{ type: "strong" }],
    });
    expect(descendants(tree).some((node) => node.type === "math")).toBe(false);
  });

  it("bounds work for repeated unclosed dollar candidates", () => {
    const started = performance.now();
    const tree = parseGfmWithMath("$$a$b\n".repeat(1_600));
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(descendants(tree).some((node) => node.type === "math")).toBe(false);
  });
});
