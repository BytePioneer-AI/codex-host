import { afterEach, expect, it, vi } from "vitest";
import { attachDesktopSessionPage } from "../src/client/desktop-shell.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(
  invoke: (command: string, args: { generation?: string; document: string }) => Promise<unknown>,
) {
  const window = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: { invoke } });
  vi.stubGlobal("window", window);
  const opened: string[] = [];
  return { window, opened, page: attachDesktopSessionPage((id) => opened.push(id)) };
}

type Grant = { status: "granted"; sessionId: string };

function granted(sessionId: string): Grant {
  return { status: "granted", sessionId };
}

it("confirms a repeated desktop wake without reopening the session", async () => {
  vi.useFakeTimers();
  const claim = Promise.withResolvers<Grant>();
  let acknowledged: string | undefined;
  let loseReceipt = true;
  const { page, opened } = setup(async (command, { generation }) => {
    if (command === "desktop_session_claim") return claim.promise;
    if (command !== "desktop_session_opened") throw new Error(`Unexpected ${command}`);
    if (loseReceipt) throw new Error("Receipt unavailable");
    acknowledged = generation;
    return "confirmed";
  });
  const first = page.wake("1");
  const concurrent = page.wake("1");
  claim.resolve(granted("target"));
  await vi.runAllTimersAsync();
  await Promise.all([first, concurrent]);
  expect(opened).toEqual(["target"]);
  expect(acknowledged).toBeUndefined();

  loseReceipt = false;
  await page.wake("1");
  expect(acknowledged).toBe("1");
  expect(opened).toEqual(["target"]);
});

it("ignores an early candidate without invalidating an older in-flight grant", async () => {
  const earlier = Promise.withResolvers<Grant>();
  let committed = false;
  const { page, opened } = setup(async (command, { generation }) => {
    if (command === "desktop_session_opened") return "confirmed";
    if (generation === "1") return earlier.promise;
    return committed ? granted("B") : { status: "unavailable" };
  });
  const first = page.wake("1");
  await page.wake("2");
  earlier.resolve(granted("A"));
  await first;
  expect(opened).toEqual(["A"]);

  committed = true;
  await page.wake("2");
  await page.wake("1");
  expect(opened).toEqual(["A", "B"]);
});

it("discovers a committed live activation when its wake preceded the page bridge", async () => {
  const { page, opened } = setup(async (command, { generation }) => {
    if (command === "desktop_session_opened") return "confirmed";
    return generation === undefined ? { status: "wake", generation: "1" } : granted("live");
  });
  await page.ready();
  await page.wake("1");
  expect(opened).toEqual(["live"]);
});

it("recovers the URL generation after a lost claim response without admitting a wake on an old page", async () => {
  vi.useFakeTimers();
  let owner: string | undefined;
  const { page, opened } = setup(async (command, { document }) => {
    if (command === "desktop_session_opened") return "confirmed";
    if (owner === undefined) {
      owner = document;
      throw new Error("The server granted the claim but its response was lost");
    }
    return owner === document ? granted("deep-linked") : { status: "unavailable" };
  });
  await page.wake("1", true);
  expect(owner).toBeUndefined();

  page.readUrlGeneration("1");
  const first = page.wake("1", true);
  const duplicate = page.wake("1", true);
  await vi.runAllTimersAsync();
  await Promise.all([first, duplicate]);
  expect(opened).toEqual(["deep-linked"]);
});

it("bounds a failed IPC flight and ignores a response that arrives after pagehide", async () => {
  vi.useFakeTimers();
  const late = Promise.withResolvers<Grant>();
  let requests = 0;
  const { page, opened, window } = setup(async () => {
    requests += 1;
    if (requests <= 3) return { status: "retry" };
    return late.promise;
  });
  const initial = page.wake("1");
  await vi.runAllTimersAsync();
  await initial;
  expect(requests).toBe(3);
  const second = page.wake("1");
  await vi.advanceTimersByTimeAsync(0);
  expect(requests).toBe(4);
  window.dispatchEvent(new Event("pagehide"));
  late.resolve(granted("stale"));
  await second;
  expect(opened).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it("applies discard before confirming it even when the grant is already in flight", async () => {
  const grantedInFlight = Promise.withResolvers<Grant>();
  const claimIssued = Promise.withResolvers<string>();
  let discardReceipt: { generation?: string; document: string } | undefined;
  const { page, opened } = setup(async (command, { generation, document }) => {
    if (command === "desktop_session_discarded") {
      discardReceipt = { generation, document };
      grantedInFlight.resolve(granted("A"));
      return "confirmed";
    }
    if (command === "desktop_session_opened") return "confirmed";
    if (command !== "desktop_session_claim") throw new Error(`Unexpected ${command}`);
    if (generation === undefined) return { status: "discard", generation: "1" };
    if (generation === "2") return granted("fresh click");
    claimIssued.resolve(document);
    return grantedInFlight.promise;
  });
  const opening = page.wake("1");
  await claimIssued.promise;
  await page.ready();
  await opening;
  expect(discardReceipt).toEqual({ generation: "1", document: await claimIssued.promise });
  await page.wake("1");
  expect(opened).toEqual([]);
  await page.wake("2");
  expect(opened).toEqual(["fresh click"]);
});

it("completes an opened receipt after BFCache restore without calling openSession again", async () => {
  vi.useFakeTimers();
  let live = false;
  const receipts: string[] = [];
  const { page, window, opened } = setup(async (command, { generation, document }) => {
    if (command === "desktop_session_opened") {
      receipts.push(document);
      return live ? "confirmed" : "retry";
    }
    return generation === undefined ? { status: "unavailable" } : granted("A");
  });
  const first = page.wake("1");
  await vi.runAllTimersAsync();
  await first;
  expect(opened).toEqual(["A"]);
  expect(receipts).toHaveLength(3);

  window.dispatchEvent(new Event("pagehide"));
  live = true;
  window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
  await vi.runAllTimersAsync();
  expect(opened).toEqual(["A"]);
  expect(receipts).toEqual(Array<string>(4).fill(receipts[0]!));
  await page.wake("1");
  expect(receipts).toHaveLength(4);
});
