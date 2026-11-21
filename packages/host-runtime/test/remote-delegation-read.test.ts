import { expect, it, vi } from "vitest";

const reply = vi.hoisted(() => ({ value: {} as unknown }));

vi.mock("@codexhost/desktop-control", () => ({
  requestDesktopRemoteConnections: vi.fn(async () => reply.value),
}));

const { readRemoteDelegationThread } = await import("../src/remote-delegation-read.js");

it("reads a Thread still waiting in a remote Host's delegation queue", async () => {
  reply.value = {
    result: {
      threadId: "remote-queued",
      harnessId: "codex",
      status: "queued",
      queue: { position: 2 },
      turn: null,
      progress: [],
      result: { availability: "pending" },
      nextCursor: null,
    },
  };
  await expect(
    readRemoteDelegationThread(
      {},
      { threadId: "remote-queued", hostId: "remote-ssh:mac", view: "result" },
    ),
  ).resolves.toMatchObject({
    threadId: "remote-queued",
    status: "queued",
    queue: { position: 2 },
    hostId: "remote-ssh:mac",
  });
});

it("still rejects a snapshot with an unknown status", async () => {
  reply.value = {
    result: {
      threadId: "remote-odd",
      harnessId: "codex",
      status: "paused",
      turn: null,
      progress: [],
      result: { availability: "pending" },
      nextCursor: null,
    },
  };
  await expect(
    readRemoteDelegationThread(
      {},
      { threadId: "remote-odd", hostId: "remote-ssh:mac", view: "result" },
    ),
  ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
});
