import type { Paragraph } from "mdast";
import { describe, expect, it } from "vitest";
import {
  parseGfm,
  parseGfmWithMath,
} from "@deepseek-ai/dsh-client-ui-primitives/src/markdown/parse.ts";

describe.each([parseGfm, parseGfmWithMath])("bare URL boundaries in %o", (parse) => {
  function phrasing(source: string): unknown[] {
    return (parse(source).children[0] as Paragraph).children.map((node) =>
      node.type === "link" ? { link: node.url } : node.type === "text" ? node.value : node.type,
    );
  }

  it.each(["。", "，", "、", "）", "；", "　", "😀", "𝄞"])("ends a URL before %s", (boundary) => {
    expect(phrasing(`见 https://example.com/a${boundary}后文`)).toEqual([
      "见 ",
      { link: "https://example.com/a" },
      `${boundary}后文`,
    ]);
    // An unclosed bracket uses mdast's fallback transform rather than the tokenizer.
    expect(phrasing(`[x https://example.com/a${boundary}后文`)).toEqual([
      "[x ",
      { link: "https://example.com/a" },
      `${boundary}后文`,
    ]);
  });

  it("trims ASCII trailing punctuation before CJK and astral boundaries", () => {
    for (const boundary of ["。", "😀"]) {
      expect(phrasing(`见 www.example.com/a.${boundary}`)).toEqual([
        "见 ",
        { link: "http://www.example.com/a" },
        `.${boundary}`,
      ]);
    }
    expect(phrasing("https://a.com/x、https://b.com/y。")).toEqual([
      { link: "https://a.com/x" },
      "、",
      { link: "https://b.com/y" },
      "。",
    ]);
    expect(phrasing("https://example.com/a，**下一句**")).toEqual([
      { link: "https://example.com/a" },
      "，",
      "strong",
    ]);
  });

  it("keeps Unicode letters, ASCII path punctuation, explicit links and email", () => {
    expect(phrasing("https://example.com/中文𠀀_(消歧义)?q=a,b ok")).toEqual([
      { link: "https://example.com/中文𠀀_(消歧义)?q=a,b" },
      " ok",
    ]);
    for (const source of ["<https://example.com/。😀>", "[link](https://example.com/。😀)"]) {
      expect(phrasing(source)).toEqual([{ link: "https://example.com/。😀" }]);
    }
    expect(phrasing("user@example.com")).toEqual([{ link: "mailto:user@example.com" }]);
    expect(phrasing("`https://example.com/a，后文`")).toEqual(["inlineCode"]);
  });
});
