import { describe, expect, it } from "vitest";

import { piCustomNotice, piHistoryNotices, piStatusText } from "../src/pi-progress.js";

describe("Pi visible progress", () => {
  const message = {
    role: "custom",
    customType: "ad-process:notification",
    display: true,
    content: "Process completed with exit code 0",
    timestamp: 100,
  };

  it("keeps live/history identity across different persistence timestamps and a resumed branch", () => {
    const hidden = { ...message, display: false };
    const first = { ...message, type: "custom_message", id: "first", timestamp: "different" };
    const prior = piHistoryNotices("session", [first, { ...hidden, id: "hidden" }]);
    const live = piCustomNotice({ ...message, timestamp: 300 }, "session", prior.occurrences);
    const history = piHistoryNotices("session", [
      first,
      { ...hidden, id: "hidden" },
      { ...first, id: "second", timestamp: "later" },
    ]);
    expect(live).toEqual(history.notices.get("second"));
    expect(live?.itemId).not.toBe(history.notices.get("first")?.itemId);
    expect(history.notices.size).toBe(2);
    expect(live?.text).toBe(
      "Pi notification (ad-process:notification)\n\nProcess completed with exit code 0",
    );
  });

  it("never exposes hidden control messages or arbitrary custom metadata", () => {
    const counts = new Map<string, number>();
    expect(piCustomNotice({ ...message, display: false }, "s", counts)).toBeNull();
    expect(piCustomNotice({ ...message, display: undefined }, "s", counts)).toBeNull();
    expect(
      piCustomNotice({ type: "custom", content: "secret", display: true }, "s", counts),
    ).toBeNull();
    expect(counts.size).toBe(0);
  });

  it("labels real retry and extension status without fabricating Assistant text", () => {
    expect(
      piStatusText({
        type: "auto_retry_start",
        attempt: 2,
        maxAttempts: 3,
        delayMs: 5000,
        errorMessage: "503",
      }),
    ).toBe("Pi retry 2/3. Waiting 5 s before retrying.\n\n503");
    expect(piStatusText({ type: "auto_retry_end", success: true })).toBe("Pi retry succeeded.");
    expect(piStatusText({ type: "auto_retry_end", success: false, finalError: "503" })).toBe(
      "Pi retry ended without success.\n\n503",
    );
    expect(
      piStatusText({
        type: "extension_ui_request",
        method: "notify",
        message: "Working",
        notifyType: "info",
      }),
    ).toBe("Pi notification (info)\n\nWorking");
    expect(
      piStatusText({
        type: "extension_ui_request",
        method: "setStatus",
        statusKey: "job",
        statusText: "Running",
      }),
    ).toBe("Pi status (job)\n\nRunning");
    expect(
      piStatusText({ type: "extension_ui_request", method: "setStatus", statusKey: "job" }),
    ).toBe("Pi status (job) cleared.");
  });

  it("renders native process summaries and outcomes instead of hiding XML as Markdown HTML", () => {
    const raw = {
      ...message,
      content: "<process_event><summary>finished</summary></process_event>",
    };
    const complete = piCustomNotice(
      {
        ...raw,
        details: {
          summary: 'Process "release" succeeded after 328s.',
          exitCode: 0,
          command: "release --production",
        },
      },
      "s",
      new Map(),
    );
    expect(complete?.text).toContain('Process "release" succeeded after 328s.');
    expect(complete?.text).toContain("Exit code: 0");
    expect(complete?.text).toContain("Command: release --production");
    expect(complete?.text).not.toContain("<process_event>");
    const failed = piCustomNotice(
      {
        ...raw,
        details: {
          summary: "Process failed.",
          exitCode: 1,
          error: "<connection refused>",
          logMatch: { line: "ERROR: unavailable" },
        },
      },
      "s",
      new Map(),
    );
    expect(failed?.text).toContain("Exit code: 1");
    expect(failed?.text).toContain("error: &lt;connection refused&gt;");
    expect(failed?.text).toContain("Log: ERROR: unavailable");
    const generic = piCustomNotice(raw, "s", new Map());
    expect(generic?.text).toContain("&lt;process_event&gt;");
    expect(generic?.itemId).toBe(complete?.itemId);
  });
});
