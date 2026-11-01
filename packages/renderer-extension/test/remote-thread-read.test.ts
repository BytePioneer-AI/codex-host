import { expect, it, vi } from "vitest";
import { handleRemoteConnectionsRequest } from "../src/remote-connections-request.js";
import { createRemoteConnectionsControl } from "../src/remote-connections-control.js";

it("allows a history read to finish after eight seconds without retrying", async () => {
  vi.useFakeTimers();
  try {
    const read = vi.fn(
      () => new Promise((resolve) => setTimeout(() => resolve({ threadId: "t" }), 31_000)),
    );
    const control = createRemoteConnectionsControl(
      { setTimeout, clearTimeout } as unknown as Window,
      () => ({ readDelegationThread: read }),
    );
    const result = handleRemoteConnectionsRequest(control, {
      action: "read-thread",
      hostId: "mac",
      input: { threadId: "t", view: "result" },
    });
    const assertion = expect(result).resolves.toEqual({ threadId: "t" });
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
    expect(read).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("uses exactly the selected renderer Host client", async () => {
  const read = vi.fn().mockResolvedValue({ threadId: "t" });
  const getClient = vi.fn((hostId: string) =>
    hostId === "mac" ? { readDelegationThread: read } : null,
  );
  const window = { setTimeout, clearTimeout } as unknown as Window;
  const control = createRemoteConnectionsControl(window, getClient);
  const input = { threadId: "t", view: "messages", limit: 2 };
  await expect(
    handleRemoteConnectionsRequest(control, { action: "read-thread", hostId: "mac", input }),
  ).resolves.toEqual({ threadId: "t" });
  expect(getClient).toHaveBeenCalledExactlyOnceWith("mac");
  expect(read).toHaveBeenCalledExactlyOnceWith(input);
  await expect(
    handleRemoteConnectionsRequest(control, { action: "read-thread", hostId: "missing", input }),
  ).rejects.toThrow("unavailable");
  expect(read).toHaveBeenCalledTimes(1);
});
