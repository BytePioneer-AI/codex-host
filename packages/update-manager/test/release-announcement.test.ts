import { releaseAnnouncementSchema } from "@codexhost/shared-contracts";
import {
  fetchGitHubReleaseAnnouncement,
  parseReleaseAnnouncementMarkdown,
} from "@codexhost/update-manager";
import { expect, test, vi } from "vitest";

// Excerpts from the published v0.24.0 notes, retaining the section boundaries.
const zh = `本次更新带来 Desktop 与 Web 通用的插件平台和多 Agent 协作设置，适配 Codex Desktop 26.1117，并改进了 Antigravity、Windows、Thread 和手机端体验。

### 🧩 插件两端通用
Desktop 和 Web 共用一套插件，挂件和独立页面两端都能用；已装的 Desktop 插件升级后自动迁移，Windows 上保存插件设置不再冲突。
— @BytePioneer-AI · @mouzhi · @MGHus4473

### 🖥 适配 Codex Desktop 26.1117
修好了配置 MCP 时启动超时、新对话里点 Harness 没反应、Codex 额度用完后外部 Harness 发不了消息等问题；Harness 切换改为自动识别，以后 Desktop 更新也不容易再失效。
— @BytePioneer-AI · @YanYunCY · @lpmasser

## 🚀 新功能
- 模型选择器：可以只刷新当前 Harness 的模型列表 (#940)`;
const en = `This release brings plugins shared by Desktop and Web, Multi-Agent settings and support for Codex Desktop 26.1117, with improvements to Antigravity, Windows, Threads and mobile.

### 🧩 Plugins on both Desktop and Web
Desktop and Web share one set of plugins, and Widgets and Pages work on both; installed Desktop plugins migrate automatically, and saving plugin settings on Windows no longer conflicts.
— @BytePioneer-AI · @mouzhi · @MGHus4473

## 🚀 Features
- Model picker: refresh only the current Harness's models (#940)`;
const markdown = `${zh}\n\n---\n\n${en}`;
const version = "0.24.0";
const publishedAt = "2026-11-22T00:00:00Z";
const url = `https://github.com/BytePioneer-AI/codex-host/releases/tag/v${version}`;

test.each([
  {
    name: "published bilingual notes with CRLF",
    body: markdown.replaceAll("\n", "\r\n"),
    languages: [true, true],
    themeCount: 2,
  },
  {
    name: "old v0.23.0 format",
    body: "## What's New\n\n### Features\n- **Native Codex Usage metering on the shared channel**",
    languages: [false, false],
    themeCount: 0,
  },
  { name: "Chinese only", body: zh, languages: [true, false], themeCount: 2 },
  {
    name: "no contributor lines",
    body: markdown.replace(/^— .*\n/gmu, ""),
    languages: [true, true],
    themeCount: 2,
  },
  {
    name: "joined icon and optional icon",
    body: "### 👩🏽‍💻 编程\n说明\n### 没有图标\n说明",
    languages: [true, false],
    themeCount: 2,
  },
  {
    name: "oversized fields",
    body: `${"字".repeat(601)}\n\n${`### 👩🏻‍❤️‍💋‍👩🏿${"\u0301".repeat(6)} ${"题".repeat(121)}\n${"文".repeat(1201)}\n— @${"x".repeat(40)}${" · @author".repeat(31)}\n\n`.repeat(13)}`,
    languages: [true, false],
    themeCount: 12,
  },
])("parses $name", ({ name, body, languages, themeCount }) => {
  const content = parseReleaseAnnouncementMarkdown(body);
  expect([Boolean(content.zh), Boolean(content.en)]).toEqual(languages);
  expect(content.zh?.themes.length ?? 0).toBe(themeCount);
  if (!themeCount) return;
  expect(
    releaseAnnouncementSchema.safeParse({ version, publishedAt, url, ...content }).success,
  ).toBe(true);
  switch (name) {
    case "published bilingual notes with CRLF":
      expect(content.zh?.summary).toBe(zh.split("\n")[0]);
      expect(content.zh?.themes[0]).toEqual({
        icon: "🧩",
        title: "插件两端通用",
        body: zh.split("\n")[3],
        contributors: ["BytePioneer-AI", "mouzhi", "MGHus4473"],
      });
      expect(content.zh?.themes[1]).toMatchObject({
        icon: "🖥",
        title: "适配 Codex Desktop 26.1117",
      });
      expect(content.en?.themes.map((theme) => theme.title)).toEqual([
        "Plugins on both Desktop and Web",
      ]);
      break;
    case "no contributor lines":
      expect(content.zh?.themes[0]?.contributors).toEqual([]);
      expect(content.en?.themes[0]?.contributors).toEqual([]);
      break;
    case "joined icon and optional icon":
      expect(content.zh?.themes[0]).toMatchObject({ icon: "👩🏽‍💻", title: "编程" });
      expect(content.zh?.themes[1]).not.toHaveProperty("icon");
      break;
    case "oversized fields":
      expect(content.zh?.summary).toHaveLength(600);
      expect(content.zh?.themes[0]).toEqual({
        title: "题".repeat(120),
        body: "文".repeat(1200),
        contributors: Array(30).fill("author"),
      });
      break;
  }
});

test.each([
  { name: "formal", overrides: {}, status: 200, available: true },
  { name: "draft", overrides: { draft: true }, status: 200, available: false },
  { name: "prerelease", overrides: { prerelease: true }, status: 200, available: false },
  { name: "wrong tag", overrides: { tag_name: "v0.25.0" }, status: 200, available: false },
  {
    name: "wrong link",
    overrides: { html_url: url.replace(version, "0.25.0") },
    status: 200,
    available: false,
  },
  { name: "missing", overrides: {}, status: 404, available: false },
])("reads the exact tag's $name response", async ({ overrides, status, available }) => {
  const fetch = vi.fn(async () =>
    Response.json(
      {
        tag_name: `v${version}`,
        html_url: url,
        published_at: publishedAt,
        draft: false,
        prerelease: false,
        body: markdown,
        ...overrides,
      },
      { status },
    ),
  );
  const announcement = await fetchGitHubReleaseAnnouncement(version, { fetch });
  expect(fetch).toHaveBeenCalledWith(
    `https://api.github.com/repos/BytePioneer-AI/codex-host/releases/tags/v${version}`,
    expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
  );
  if (available) expect(announcement).toMatchObject({ version, publishedAt, url });
  else expect(announcement).toBeNull();
});
