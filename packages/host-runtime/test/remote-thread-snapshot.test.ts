import { requestDesktopRemoteConnections } from "@codexhost/desktop-control";
import { expect, it, vi } from "vitest";

import { readRemoteDelegationThread } from "../src/remote-delegation-read.js";

vi.mock("@codexhost/desktop-control", () => ({ requestDesktopRemoteConnections: vi.fn() }));

const snapshot = {
  threadId: "thread",
  harnessId: "pi",
  status: "completed",
  turn: { turnId: "t3", status: "completed" },
  progress: [],
  result: { availability: "available", text: "Latest result" },
  totalTurns: 3,
  from: 2,
  to: 2,
  turns: [
    {
      turnId: "t2",
      turnNumber: 2,
      status: "failed",
      messages: [{ id: "u2", role: "user", text: "Task" }],
    },
  ],
};

it("preserves Turn numbers, range metadata and historical statuses through remote reads", async () => {
  vi.mocked(requestDesktopRemoteConnections).mockResolvedValue({ result: snapshot });
  const result = await readRemoteDelegationThread(
    {},
    {
      threadId: "thread",
      hostId: "mac",
      view: "messages",
      from: 2,
      to: 2,
    },
  );
  expect(requestDesktopRemoteConnections).toHaveBeenLastCalledWith(
    {},
    {
      action: "read-thread",
      hostId: "mac",
      input: { threadId: "thread", view: "messages", from: 2, to: 2 },
    },
  );
  expect(result).toEqual({ ...snapshot, hostId: "mac" });
  expect(result).not.toHaveProperty("nextCursor");
  expect(result).not.toHaveProperty("hasMore");
});

it("rejects message snapshots with invalid Turn-range metadata", async () => {
  vi.mocked(requestDesktopRemoteConnections).mockResolvedValue({
    result: { ...snapshot, totalTurns: "invalid" },
  });
  await expect(
    readRemoteDelegationThread({}, { threadId: "thread", hostId: "mac", view: "messages" }),
  ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
});
