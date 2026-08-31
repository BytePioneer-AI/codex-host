import path from "node:path";

import { describe, expect, it } from "vitest";

import { grokMediaResolveRoots, rewriteLocalMediaMarkdown } from "../src/local-media-markdown.js";

const session = "/Users/chris/.grok/sessions/workspace/session-1";
const files = new Set([
  `${session}/videos/usegrokbot-templates-promo-10s.mp4`,
  "/Users/chris/Downloads/usegrokbot-templates-promo-10s.mp4",
  "/workspace/readme.png",
]);
const roots = grokMediaResolveRoots("/workspace", session);
const exists = (absolutePath: string) => files.has(path.resolve(absolutePath));

describe("Grok local media Markdown", () => {
  it("rewrites session-relative video images to absolute paths Codex can play", () => {
    expect(
      rewriteLocalMediaMarkdown(
        [
          "10 秒宣傳片做好了。",
          "",
          "`/Users/chris/Downloads/usegrokbot-templates-promo-10s.mp4`",
          "",
          "![UseGrokBot Templates 10s promo](videos/usegrokbot-templates-promo-10s.mp4)",
        ].join("\n"),
        roots,
        { exists },
      ),
    ).toBe(
      [
        "10 秒宣傳片做好了。",
        "",
        "`/Users/chris/Downloads/usegrokbot-templates-promo-10s.mp4`",
        "",
        `![UseGrokBot Templates 10s promo](${session}/videos/usegrokbot-templates-promo-10s.mp4)`,
      ].join("\n"),
    );
  });

  it("holds an unfinished image destination so streamed deltas stay prefix-stable", () => {
    const rootsForStream = grokMediaResolveRoots("/workspace", session);
    let emitted = "";
    const chunks = ["影片：\n\n![clip](", "videos/usegrokbot-templates-promo-10s.mp4", ")\n完成"];
    let raw = "";
    for (const chunk of chunks) {
      raw += chunk;
      const projected = rewriteLocalMediaMarkdown(raw, rootsForStream, {
        exists,
        holdIncomplete: true,
      });
      expect(projected.startsWith(emitted)).toBe(true);
      emitted = projected;
    }
    expect(emitted).toBe(
      `影片：\n\n![clip](${session}/videos/usegrokbot-templates-promo-10s.mp4)\n完成`,
    );
  });

  it("leaves remote images and missing files unchanged", () => {
    expect(
      rewriteLocalMediaMarkdown(
        "![remote](https://example.com/a.png) ![missing](videos/missing.mp4)",
        roots,
        { exists },
      ),
    ).toBe("![remote](https://example.com/a.png) ![missing](videos/missing.mp4)");
  });

  it("does not rewrite images inside fenced code", () => {
    expect(
      rewriteLocalMediaMarkdown(
        "```md\n![clip](videos/usegrokbot-templates-promo-10s.mp4)\n```",
        roots,
        { exists },
      ),
    ).toBe("```md\n![clip](videos/usegrokbot-templates-promo-10s.mp4)\n```");
  });
});
