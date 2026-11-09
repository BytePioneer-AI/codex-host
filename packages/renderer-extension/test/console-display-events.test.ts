import { afterEach, expect, it, vi } from "vitest";
import { hostRequestManager } from "../src/console/api.js";

afterEach(() => vi.unstubAllGlobals());

it("connects Console sorting subscriptions to EventSource and closes them", () => {
  const sources: Array<{ url: string; onmessage?: () => void; close(): void }> = [];
  vi.stubGlobal(
    "EventSource",
    class {
      onmessage?: () => void;
      close = vi.fn();
      constructor(readonly url: string) {
        sources.push(this);
      }
    },
  );
  const listener = vi.fn();
  const remove = hostRequestManager().addNotificationCallback?.(
    "codexhost/harness/display-settings/changed",
    listener,
  );
  expect(sources[0]?.url).toBe("/api/host/display-events");
  sources[0]?.onmessage?.();
  expect(listener).toHaveBeenCalledWith({
    method: "codexhost/harness/display-settings/changed",
    params: {},
  });
  remove?.();
  expect(sources[0]?.close).toHaveBeenCalledOnce();
});

it("negotiates Console transport before requesting Host sorting capability", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ events: true })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ result: { events: true } })));
  vi.stubGlobal("fetch", fetch);
  expect(
    await hostRequestManager().sendRequest("codexhost/harness/display-settings/capabilities", {}),
  ).toEqual({ events: true });
  expect(fetch.mock.calls.map((call) => call[0])).toEqual([
    "/api/host/display-capabilities",
    "/api/host/request",
  ]);
});

it("explicitly falls back for an older Console without an event transport", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 404 }));
  vi.stubGlobal("fetch", fetch);
  expect(
    await hostRequestManager().sendRequest("codexhost/harness/display-settings/capabilities", {}),
  ).toEqual({ events: false });
  expect(fetch).toHaveBeenCalledOnce();
});
