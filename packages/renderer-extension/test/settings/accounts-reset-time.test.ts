import { describe, expect, it } from "vitest";
import { formatAccountResetCountdown } from "../../src/settings/accounts-reset-time.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";

const messages = rendererSettingsMessages("zh-CN");
const now = Date.UTC(2026, 8, 10, 8, 20);

function after(minutes: number): string {
  return new Date(now + minutes * 60_000).toISOString();
}

describe("Account reset countdown", () => {
  it.each([
    [6 * 1440 + 17 * 60 + 45, "6d17h"],
    [1440 + 59, "1d"],
    [1440, "1d"],
    [1439, "23h59m"],
    [294, "4h54m"],
    [69, "1h9m"],
    [60, "1h"],
    [59, "59m"],
    [14, "14m"],
    [1, "1m"],
    [0.01, "1m"],
  ])("formats %i minutes with at most two relevant units", (minutes, expected) => {
    expect(formatAccountResetCountdown(after(minutes), messages, now)?.text).toBe(expected);
  });

  it("explains compact units and reset semantics in the current language", () => {
    expect(formatAccountResetCountdown(after(69), messages, now)?.description).toBe(
      "距重置还有 1小时9分钟",
    );
    expect(
      formatAccountResetCountdown(after(69), rendererSettingsMessages("en"), now)?.description,
    ).toBe("Quota resets in 1 hour 9 minutes");
  });

  it.each([0, -1, -1440])("does not assume that elapsed quota has reset (%i)", (minutes) => {
    expect(formatAccountResetCountdown(after(minutes), messages, now)).toEqual({
      text: "待刷新",
      description: messages.accountCreditsResetPendingHint,
    });
  });

  it.each(["", "not-a-date", "2026-99-99T00:00:00Z"])("omits invalid reset time %s", (value) => {
    expect(formatAccountResetCountdown(value, messages, now)).toBeNull();
  });

  it("compares instants rather than subtracting local calendar fields", () => {
    expect(formatAccountResetCountdown("2026-09-10T18:00:00+09:00", messages, now)?.text).toBe(
      "40m",
    );
    expect(formatAccountResetCountdown("2026-09-10T02:00:00-07:00", messages, now)?.text).toBe(
      "40m",
    );
  });
});
