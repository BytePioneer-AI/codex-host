import { describe, expect, it } from "vitest";

import {
  THREAD_WATCH_NOTICE_HEADER,
  formatThreadWatchNotice,
  parseThreadWatchNotice,
  type ThreadWatchNoticeEntry,
} from "../src/index.js";

const entries: ThreadWatchNoticeEntry[] = [
  { threadId: "t-1", label: "审查最近PR · 委派", outcome: "completed" },
  {
    threadId: "t-2",
    label: "t-2",
    outcome: "timedOut",
    note: "Run 'codexhost thread watch' again to keep waiting.",
  },
];

describe("thread watch notice", () => {
  it("formats Markdown thread links under a fixed header", () => {
    expect(formatThreadWatchNotice(entries)).toBe(
      [
        THREAD_WATCH_NOTICE_HEADER,
        "",
        "- [审查最近PR · 委派](thread://t-1): completed",
        "- [t-2](thread://t-2): timedOut. Run 'codexhost thread watch' again to keep waiting.",
      ].join("\n"),
    );
  });

  it("round-trips formatted entries", () => {
    expect(parseThreadWatchNotice(formatThreadWatchNotice(entries))).toEqual(entries);
  });

  it("keeps labels and notes on one parseable line", () => {
    const text = formatThreadWatchNotice([
      {
        threadId: "t-3",
        label: "a [b]\nc",
        outcome: "interrupted",
        note: "first\nsecond",
      },
    ]);
    expect(parseThreadWatchNotice(text)).toEqual([
      {
        threadId: "t-3",
        label: "a b c",
        outcome: "interrupted",
        note: "first second",
      },
    ]);
  });

  it("rejects other text", () => {
    expect(parseThreadWatchNotice("hello")).toBeUndefined();
    expect(parseThreadWatchNotice(THREAD_WATCH_NOTICE_HEADER)).toBeUndefined();
    expect(
      parseThreadWatchNotice(`${THREAD_WATCH_NOTICE_HEADER}\n\n- [a](thread://t): done`),
    ).toBeUndefined();
    expect(
      parseThreadWatchNotice(
        `${THREAD_WATCH_NOTICE_HEADER}\n\n- [a](thread://t): completed\nextra text`,
      ),
    ).toBeUndefined();
  });
});
