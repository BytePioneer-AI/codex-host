import path from "node:path";

import { describe, expect, it } from "vitest";

import { grokMediaResolveRoots, rewriteLocalMediaMarkdown } from "../src/local-media-markdown.js";

const workspace = path.resolve("test-fixtures/workspace");
const home = path.resolve("test-fixtures/home");
const session = path.join(home, ".grok/sessions/workspace/session-1");
const downloads = path.join(home, "Downloads");
const files = new Set([
  path.join(session, "videos/usegrokbot-templates-promo-10s.mp4"),
  path.join(downloads, "usegrokbot-templates-promo-10s.mp4"),
  path.join(workspace, "readme.png"),
]);
const roots = grokMediaResolveRoots(workspace, session);
const exists = (absolutePath: string) => files.has(path.resolve(absolutePath));

describe("Grok local media Markdown", () => {
  it("rewrites session-relative video images to absolute paths Codex can play", () => {
    expect(
      rewriteLocalMediaMarkdown(
        [
          "10 秒宣傳片做好了。",
          "",
          `\`${path.join(downloads, "usegrokbot-templates-promo-10s.mp4")}\``,
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
        `![usegrokbot-templates-promo-10s.mp4](${path.join(downloads, "usegrokbot-templates-promo-10s.mp4")})`,
        "",
        `![UseGrokBot Templates 10s promo](${path.join(session, "videos/usegrokbot-templates-promo-10s.mp4")})`,
      ].join("\n"),
    );
  });

  it("turns Grok backtick video paths into Markdown images", () => {
    const filesWithAura = new Set([
      ...files,
      path.join(session, "videos/aura-10s.mp4"),
      path.join(downloads, "aura-product-film-10s.mp4"),
    ]);
    expect(
      rewriteLocalMediaMarkdown(
        [
          "影片在這裡：",
          "",
          "`videos/aura-10s.mp4`",
          "",
          "打開這份：",
          "",
          `\`${path.join(downloads, "aura-product-film-10s.mp4")}\``,
        ].join("\n"),
        grokMediaResolveRoots(workspace, session),
        { exists: (absolutePath) => filesWithAura.has(path.resolve(absolutePath)) },
      ),
    ).toBe(
      [
        "影片在這裡：",
        "",
        `![aura-10s.mp4](${path.join(session, "videos/aura-10s.mp4")})`,
        "",
        "打開這份：",
        "",
        `![aura-product-film-10s.mp4](${path.join(downloads, "aura-product-film-10s.mp4")})`,
      ].join("\n"),
    );
  });

  it("holds an unfinished image destination so streamed deltas stay prefix-stable", () => {
    const rootsForStream = grokMediaResolveRoots(workspace, session);
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
      `影片：\n\n![clip](${path.join(session, "videos/usegrokbot-templates-promo-10s.mp4")})\n完成`,
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

  it("does not rewrite images or paths inside fenced code", () => {
    expect(
      rewriteLocalMediaMarkdown(
        "```md\n![clip](videos/usegrokbot-templates-promo-10s.mp4)\n`videos/usegrokbot-templates-promo-10s.mp4`\n```",
        roots,
        { exists },
      ),
    ).toBe(
      "```md\n![clip](videos/usegrokbot-templates-promo-10s.mp4)\n`videos/usegrokbot-templates-promo-10s.mp4`\n```",
    );
  });

  it("holds an unfinished backtick path so streamed deltas stay prefix-stable", () => {
    let emitted = "";
    const chunks = ["影片：\n\n`", "videos/usegrokbot-templates-promo-10s.mp4", "`\n完成"];
    let raw = "";
    for (const chunk of chunks) {
      raw += chunk;
      const projected = rewriteLocalMediaMarkdown(raw, roots, { exists, holdIncomplete: true });
      expect(projected.startsWith(emitted)).toBe(true);
      emitted = projected;
    }
    expect(emitted).toBe(
      `影片：\n\n![usegrokbot-templates-promo-10s.mp4](${path.join(session, "videos/usegrokbot-templates-promo-10s.mp4")})\n完成`,
    );
  });

  it("leaves ordinary inline code unchanged", () => {
    expect(rewriteLocalMediaMarkdown("run `npm test` then done", roots, { exists })).toBe(
      "run `npm test` then done",
    );
  });
});
