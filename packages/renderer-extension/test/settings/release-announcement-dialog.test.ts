import type { ReleaseAnnouncement } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  formatReleaseAnnouncementContributors,
  formatReleaseAnnouncementDate,
  selectReleaseAnnouncementContent,
} from "../../src/settings/release-announcement-dialog.js";

const SAMPLE_ANNOUNCEMENT: ReleaseAnnouncement = {
  version: "0.24.0",
  publishedAt: "2026-11-22T09:30:03Z",
  url: "https://github.com/BytePioneer-AI/codex-host/releases/tag/v0.24.0",
  zh: {
    summary: "中文总结",
    themes: [
      {
        icon: "🧩",
        title: "插件两端通用",
        body: "中文说明",
        contributors: ["BytePioneer-AI"],
      },
    ],
  },
  en: {
    summary: "English summary",
    themes: [
      {
        icon: "🧩",
        title: "Plugins on both Desktop and Web",
        body: "English body",
        contributors: ["BytePioneer-AI"],
      },
    ],
  },
};

describe("release announcement helpers", () => {
  it("selects content matching the UI locale and falls back to the other language", () => {
    expect(selectReleaseAnnouncementContent(SAMPLE_ANNOUNCEMENT, "zh-CN")).toEqual({
      language: "zh",
      content: SAMPLE_ANNOUNCEMENT.zh,
    });
    expect(selectReleaseAnnouncementContent(SAMPLE_ANNOUNCEMENT, "en")).toEqual({
      language: "en",
      content: SAMPLE_ANNOUNCEMENT.en,
    });

    const zhOnly: ReleaseAnnouncement = { ...SAMPLE_ANNOUNCEMENT, en: null };
    expect(selectReleaseAnnouncementContent(zhOnly, "en")).toEqual({
      language: "zh",
      content: SAMPLE_ANNOUNCEMENT.zh,
    });

    const enOnly: ReleaseAnnouncement = { ...SAMPLE_ANNOUNCEMENT, zh: null };
    expect(selectReleaseAnnouncementContent(enOnly, "zh-CN")).toEqual({
      language: "en",
      content: SAMPLE_ANNOUNCEMENT.en,
    });
  });

  it("formats publishedAt according to locale and handles invalid timestamps", () => {
    expect(formatReleaseAnnouncementDate("2026-11-22T09:30:03Z", "zh-CN", "UTC")).toBe(
      "2026年11月22日",
    );
    expect(formatReleaseAnnouncementDate("2026-11-22T09:30:03Z", "en", "UTC")).toBe(
      "November 22, 2026",
    );
    expect(formatReleaseAnnouncementDate("not-a-date", "en", "UTC")).toBe("");
  });

  it("strips leading @ from contributor handles and joins them with middle dots", () => {
    expect(
      formatReleaseAnnouncementContributors(["BytePioneer-AI", "@mouzhi", "  @@MGHus4473  ", ""]),
    ).toBe("BytePioneer-AI · mouzhi · MGHus4473");
    expect(formatReleaseAnnouncementContributors([])).toBe("");
  });
});
