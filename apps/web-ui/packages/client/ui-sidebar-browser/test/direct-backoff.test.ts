import { describe, expect, it } from "vitest";
import { DirectBackoff, directNetworkKey } from "../src/client/remote/DirectBackoff.ts";

const NOW = 1_000;
const MINUTE = 60_000;
const noStorage = () => {
  throw new Error("blocked");
};

function sharedStorage() {
  let value: string | null = null;
  return () => ({
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  });
}

describe("direct backoff", () => {
  it("escalates after expiry, caps at a day and clears on success even without storage", () => {
    const backoff = new DirectBackoff(noStorage);
    backoff.setBoot("computer", "boot");
    let now = NOW;
    for (const minutes of [10, 60, 360, 1440, 1440]) {
      backoff.failed("computer", "none", now);
      now += minutes * MINUTE;
      expect(backoff.cooling("computer", "none", now - 1)).toBe(true);
      expect(backoff.cooling("computer", "none", now)).toBe(false);
    }
    backoff.succeeded("computer", "none");
    backoff.failed("computer", "none", now);
    expect(backoff.cooling("computer", "none", now + 10 * MINUTE)).toBe(false);
  });

  it("persists across reloads, isolates networks and computers, and resets only the restarted computer", () => {
    const storage = sharedStorage();
    const wifi = directNetworkKey("192.0.2.1");
    const mobile = directNetworkKey("198.51.100.1");
    const first = new DirectBackoff(storage);
    first.setBoot("first", "boot-a");
    first.setBoot("second", "boot-b");
    first.failed("first", wifi, NOW);
    expect(first.cooling("second", wifi, NOW)).toBe(false);
    first.failed("second", wifi, NOW);

    const reloaded = new DirectBackoff(storage);
    reloaded.setBoot("first", "boot-a");
    expect(reloaded.cooling("first", mobile, NOW)).toBe(false);
    expect(reloaded.cooling("first", wifi, NOW)).toBe(true);
    reloaded.setBoot("first", "boot-c");
    expect(reloaded.cooling("first", wifi, NOW)).toBe(false);
    const afterRestart = new DirectBackoff(storage);
    expect(afterRestart.cooling("first", wifi, NOW)).toBe(false);
    expect(afterRestart.cooling("second", wifi, NOW)).toBe(true);
  });

  it("shares cooldowns and merges updates from two open pages", () => {
    const storage = sharedStorage();
    const first = new DirectBackoff(storage);
    const second = new DirectBackoff(storage);
    first.setBoot("computer", "boot");
    second.setBoot("computer", "boot");
    second.setBoot("other-computer", "other-boot");

    first.failed("computer", "wifi", NOW);
    expect(second.cooling("computer", "wifi", NOW)).toBe(true);
    const nextAttempt = NOW + 10 * MINUTE;
    second.failed("computer", "mobile", nextAttempt);
    second.failed("other-computer", "wifi", nextAttempt);
    second.failed("computer", "wifi", nextAttempt);
    expect(first.cooling("computer", "wifi", nextAttempt + 10 * MINUTE)).toBe(true);
    first.succeeded("computer", "wifi");
    expect(second.cooling("computer", "wifi", nextAttempt)).toBe(false);
    expect(second.cooling("computer", "mobile", nextAttempt)).toBe(true);
    expect(second.cooling("other-computer", "wifi", nextAttempt)).toBe(true);

    second.setBoot("computer", "new-boot");
    second.failed("computer", "mobile", nextAttempt);
    first.failed("computer", "wifi", nextAttempt);
    expect(second.cooling("computer", "wifi", nextAttempt)).toBe(false);
    expect(second.cooling("computer", "mobile", nextAttempt)).toBe(true);
  });

  it("keeps the latest 32 network records per computer", () => {
    const backoff = new DirectBackoff(noStorage);
    backoff.setBoot("computer", "boot");
    for (let i = 0; i < 33; i++) backoff.failed("computer", `network-${i}`, NOW);
    expect(backoff.cooling("computer", "network-0", NOW)).toBe(false);
    expect(backoff.cooling("computer", "network-1", NOW)).toBe(true);
  });
});

it("keys the first reflection by full IPv4 or IPv6 /64, with a fixed empty key", () => {
  expect(directNetworkKey("192.0.2.1")).not.toBe(directNetworkKey("192.0.2.2"));
  const key = directNetworkKey("2001:db8:0:4::1");
  expect(directNetworkKey("2001:0DB8:0000:0004:ffff::5")).toBe(key);
  expect(directNetworkKey("2001:db8:0:5::1")).not.toBe(key);
  expect(directNetworkKey(undefined)).toBe("none");
});
