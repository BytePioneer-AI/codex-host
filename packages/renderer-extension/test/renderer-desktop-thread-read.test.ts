import { expect, it, vi } from "vitest";
import type {
  RendererHostRoute,
  RendererHostRouting,
} from "@codexhost/desktop-control/renderer-bindings";
import {
  DESKTOP_THREAD_READ_METHOD,
  DESKTOP_THREAD_READ_REPLY_METHOD,
  DELEGATION_READ_METHOD,
  REMOTE_THREAD_REPLY_MAX_BYTES,
} from "@codexhost/shared-contracts";
import { createRendererHostClients } from "../src/renderer-host-clients.js";
import type { RendererMessageTarget } from "../src/renderer-manual-compaction.js";

const snapshot = {
  threadId: "target",
  harnessId: "codex",
  status: "completed",
  turn: null,
  progress: [],
  result: { availability: "available", text: "local answer" },
  nextCursor: "page",
  messages: [],
  hasMore: true,
};
const requestId = "4f09746b-3342-4397-94c9-e546009bc3c3";
const input = { threadId: "target", view: "messages", limit: 2, cursor: "previous" };

function fixture() {
  const listeners = new Set<Parameters<RendererMessageTarget["addEventListener"]>[1]>();
  const messages: RendererMessageTarget = {
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  };
  const localRead = vi.fn().mockResolvedValue(snapshot);
  const sendReply = vi.fn().mockResolvedValue(null);
  const local = {
    hostId: "local",
    manager: { sendRequest: localRead },
  } as unknown as RendererHostRoute;
  let origin: RendererHostRoute | null = {
    hostId: "remote",
    manager: { sendRequest: sendReply },
  } as unknown as RendererHostRoute;
  const routing = {
    forHost: (hostId: string) => (hostId === "local" ? local : hostId === "remote" ? origin : null),
  } as RendererHostRouting;
  const clients = createRendererHostClients(() => routing, messages);
  const post = (
    data: unknown = {
      type: "mcp-notification",
      hostId: "remote",
      method: DESKTOP_THREAD_READ_METHOD,
      params: { requestId, input },
    },
    source: unknown = messages,
  ) => {
    for (const listener of listeners) listener({ data, source });
  };
  return {
    clients,
    listeners,
    localRead,
    sendReply,
    post,
    disconnect: () => {
      origin = null;
    },
  };
}

it("reads only Desktop-local history and replies on the requesting connection without caller mappings", async () => {
  const f = fixture();
  try {
    f.post();
    await vi.waitFor(() =>
      expect(f.sendReply).toHaveBeenCalledExactlyOnceWith(DESKTOP_THREAD_READ_REPLY_METHOD, {
        requestId,
        result: snapshot,
      }),
    );
    expect(f.localRead).toHaveBeenCalledExactlyOnceWith(DELEGATION_READ_METHOD, input);
  } finally {
    f.clients.dispose();
  }
  expect(f.listeners.size).toBe(0);
});

it.each([
  ["Official Thread read failed: thread not loaded: target", "THREAD_NOT_FOUND"],
  ["Thread was not found", "THREAD_NOT_FOUND"],
  ["Permission denied", "INTERNAL_ERROR"],
])("preserves %s as %s", async (message, code) => {
  const f = fixture();
  f.localRead.mockRejectedValue(new Error(message));
  try {
    f.post();
    await vi.waitFor(() =>
      expect(f.sendReply).toHaveBeenCalledWith(DESKTOP_THREAD_READ_REPLY_METHOD, {
        requestId,
        error: { code, message },
      }),
    );
  } finally {
    f.clients.dispose();
  }
});

it("ignores foreign windows, missing connections and arbitrary RPC requests", async () => {
  const f = fixture();
  try {
    f.post(undefined, {});
    f.post({
      type: "mcp-notification",
      hostId: "missing",
      method: DESKTOP_THREAD_READ_METHOD,
      params: { requestId, input },
    });
    f.post({
      type: "mcp-notification",
      hostId: "remote",
      method: DESKTOP_THREAD_READ_METHOD,
      params: { requestId, input: { ...input, method: "turn/start" } },
    });
    f.post({
      type: "mcp-notification",
      hostId: "remote",
      method: DESKTOP_THREAD_READ_METHOD,
      params: { requestId, input: { ...input, hostId: "other" } },
    });
    expect(f.localRead).not.toHaveBeenCalled();
    expect(f.sendReply).not.toHaveBeenCalled();
  } finally {
    f.clients.dispose();
  }
});

it("returns a bounded size error instead of sending a large snapshot", async () => {
  const f = fixture();
  f.localRead.mockResolvedValue({
    ...snapshot,
    result: { availability: "available", text: "x".repeat(REMOTE_THREAD_REPLY_MAX_BYTES) },
  });
  try {
    f.post();
    await vi.waitFor(() =>
      expect(f.sendReply).toHaveBeenCalledWith(DESKTOP_THREAD_READ_REPLY_METHOD, {
        requestId,
        error: { code: "RESPONSE_TOO_LARGE", message: expect.any(String) },
      }),
    );
    expect(JSON.stringify(f.sendReply.mock.calls).length).toBeLessThan(1024);
  } finally {
    f.clients.dispose();
  }
});

it.each(["disconnect", "dispose"])(
  "does not deliver an in-flight reply after %s",
  async (action) => {
    const f = fixture();
    const pending = Promise.withResolvers<unknown>();
    f.localRead.mockReturnValue(pending.promise);
    try {
      f.post();
      if (action === "disconnect") f.disconnect();
      else f.clients.dispose();
      pending.resolve(snapshot);
      await pending.promise;
      await Promise.resolve();
      expect(f.sendReply).not.toHaveBeenCalled();
    } finally {
      f.clients.dispose();
    }
  },
);
