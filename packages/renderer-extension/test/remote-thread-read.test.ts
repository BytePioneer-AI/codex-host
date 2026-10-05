import { expect, it, vi } from "vitest";
import { handleRemoteConnectionsRequest } from "../src/remote-connections-request.js";
import { createRemoteConnectionsControl } from "../src/remote-connections-control.js";

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
