import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexSshClient, type CodexSshConnection } from "../src/codex-ssh-adapter.js";
import { loadCodexSshServices } from "../src/codex-ssh-services.js";

vi.mock("../src/codex-ssh-services.js", () => ({ loadCodexSshServices: vi.fn() }));
beforeEach(() => vi.mocked(loadCodexSshServices).mockResolvedValue(null));

const connection: CodexSshConnection = {
  hostId: "remote-ssh-codex-managed:a",
  displayName: "Office",
  source: "codex-managed",
  sshHost: "user@host",
  sshAlias: null,
  sshPort: 2222,
  identity: "~/.ssh/key",
  autoConnect: false,
  connectionAnalyticsId: "keep-me",
};
function fixture(initial: unknown[] = [connection], unsupported = false) {
  let current = initial;
  const events = new EventTarget();
  const sent: { url: string; body: string; requestId: string }[] = [];
  const window = {
    crypto: { randomUUID: () => crypto.randomUUID() },
    setTimeout,
    clearTimeout,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    electronBridge: {
      sendMessageFromView(request: (typeof sent)[number]) {
        sent.push(request);
        const result = request.url.endsWith("refresh-remote-connections")
          ? { remoteConnections: current }
          : {};
        queueMicrotask(() =>
          events.dispatchEvent(
            new MessageEvent("message", {
              data: {
                type: "fetch-response",
                requestId: request.requestId,
                responseType: unsupported ? "error" : "success",
                status: unsupported ? 432 : 200,
                error: unsupported
                  ? "refresh-remote-connections not implemented in the current Electron process"
                  : undefined,
                bodyJsonString: JSON.stringify(result),
              },
            }),
          ),
        );
      },
    },
  } as unknown as Window;
  return {
    client: createCodexSshClient(window),
    sent,
    set: (next: CodexSshConnection[]) => {
      current = next;
    },
  };
}
describe("native SSH configuration", () => {
  function services() {
    const native = {
      sshConnections: {
        refresh: vi.fn().mockResolvedValue({ remoteConnections: [connection] }),
        save: vi.fn().mockResolvedValue({}),
      },
      remoteConnections: {
        setAutoConnect: vi.fn().mockResolvedValue({}),
        getState: vi.fn().mockResolvedValue({ state: "connected", error: null }),
      },
    };
    vi.mocked(loadCodexSshServices).mockResolvedValue(native);
    return native;
  }

  it("reads through the native service when the legacy Electron handler is absent", async () => {
    const native = services();
    const f = fixture([], true);
    expect(await f.client.list()).toEqual([connection]);
    expect(native.sshConnections.refresh).toHaveBeenCalledWith();
    expect(f.sent).toHaveLength(0);
  });

  it("uses native save, removal, auto-connect and host state signatures", async () => {
    const native = services();
    const f = fixture([], true);
    await f.client.save(
      { displayName: "Updated", hostname: "host", sshPort: 22, identity: null },
      connection,
    );
    expect(native.sshConnections.save).toHaveBeenLastCalledWith({
      remoteConnections: [
        expect.objectContaining({
          displayName: "Updated",
          hostname: "host",
          connectionAnalyticsId: "keep-me",
        }),
      ],
    });
    await f.client.remove(connection);
    expect(native.sshConnections.save).toHaveBeenLastCalledWith({ remoteConnections: [] });
    await f.client.connect(connection.hostId, false);
    expect(native.remoteConnections.setAutoConnect).toHaveBeenCalledWith({
      hostId: connection.hostId,
      autoConnect: false,
    });
    expect(await f.client.state(connection.hostId)).toEqual({ state: "connected", error: null });
    expect(native.remoteConnections.getState).toHaveBeenCalledWith(connection.hostId);
    expect(f.sent).toHaveLength(0);
  });

  it("does not retry a failed native mutation through the legacy handler", async () => {
    const native = services();
    native.remoteConnections.setAutoConnect.mockRejectedValue(new Error("Connection refused"));
    const f = fixture();
    await expect(f.client.connect(connection.hostId, true)).rejects.toThrow("Connection refused");
    expect(native.remoteConnections.setAutoConnect).toHaveBeenCalledTimes(1);
    expect(f.sent).toHaveLength(0);
  });

  it("does not dispatch a mutation after cancellation during service discovery", async () => {
    const native = services();
    let ready!: (value: typeof native) => void;
    vi.mocked(loadCodexSshServices).mockReturnValue(
      new Promise((resolve) => {
        ready = resolve;
      }),
    );
    const f = fixture();
    const abort = new AbortController();
    const pending = expect(f.client.connect("host", true, abort.signal)).rejects.toThrow("Aborted");
    abort.abort();
    ready(native);
    await pending;
    expect(native.remoteConnections.setAutoConnect).not.toHaveBeenCalled();
    expect(f.sent).toHaveLength(0);
  });

  it("times out native mutations once and ignores their late completion", async () => {
    vi.useFakeTimers();
    try {
      const native = services();
      let complete!: (value: unknown) => void;
      native.remoteConnections.setAutoConnect.mockReturnValue(
        new Promise((resolve) => {
          complete = resolve;
        }),
      );
      const f = fixture();
      const pending = expect(f.client.connect("host", true)).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(15_000);
      await pending;
      complete({});
      await Promise.resolve();
      expect(native.remoteConnections.setAutoConnect).toHaveBeenCalledTimes(1);
      expect(f.sent).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not dispatch after a timeout while discovering services", async () => {
    vi.useFakeTimers();
    try {
      const native = services();
      let ready!: (value: typeof native) => void;
      vi.mocked(loadCodexSshServices).mockReturnValue(
        new Promise((resolve) => {
          ready = resolve;
        }),
      );
      const f = fixture();
      const pending = expect(f.client.connect("host", true)).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(15_000);
      await pending;
      ready(native);
      await Promise.resolve();
      await Promise.resolve();
      expect(native.remoteConnections.setAutoConnect).not.toHaveBeenCalled();
      expect(f.sent).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the native error detail when a legacy request fails", async () => {
    const f = fixture([], true);
    await expect(f.client.list()).rejects.toThrow(
      "not implemented in the current Electron process",
    );
  });

  it("keeps native WSL and Remote Control entries out of SSH configuration saves", async () => {
    const f = fixture([
      connection,
      { hostId: "wsl:Ubuntu", source: "wsl" },
      { hostId: "remote-control:mac", source: "remote-control" },
    ]);
    expect(await f.client.list()).toEqual([connection]);
    await f.client.save(
      { displayName: "Home", hostname: "home", sshPort: null, identity: null },
      null,
    );
    const last = f.sent.at(-1);
    assert(last);
    expect(
      JSON.parse(last.body).remoteConnections.map((item: CodexSshConnection) => item.source),
    ).toEqual(["codex-managed", "codex-managed"]);
  });

  it("rereads before saving and preserves new connections plus native metadata", async () => {
    const f = fixture();
    const [previous] = await f.client.list();
    f.set([
      connection,
      {
        ...connection,
        hostId: "new-other",
        displayName: "Other",
        source: "discovered",
        sshAlias: "linux",
      },
    ]);
    await f.client.save(
      { displayName: "Updated", hostname: "user@host", sshPort: 22, identity: null },
      previous ?? null,
    );
    const last = f.sent.at(-1);
    assert(last);
    const save = JSON.parse(last.body).remoteConnections;
    expect(save).toHaveLength(2);
    expect(save[0]).toMatchObject({
      hostId: "new-other",
      source: "discovered",
      alias: "linux",
      hostname: null,
    });
    expect(save[1]).toMatchObject({
      hostId: connection.hostId,
      displayName: "Updated",
      connectionAnalyticsId: "keep-me",
      hostname: "user@host",
    });
  });
  it("refuses to overwrite an edited or removed native connection", async () => {
    const f = fixture();
    f.set([{ ...connection, sshHost: "changed-host" }]);
    await expect(f.client.remove(connection)).rejects.toThrow("changed");
    expect(f.sent).toHaveLength(1);
  });
  it("uses native auto-connect and validates ports before saving", async () => {
    const f = fixture();
    await f.client.connect(connection.hostId, true);
    assert(f.sent[0]);
    expect(JSON.parse(f.sent[0].body)).toEqual({ hostId: connection.hostId, autoConnect: true });
    await expect(
      f.client.save({ displayName: "x", hostname: "host", sshPort: 65536, identity: null }, null),
    ).rejects.toThrow("65535");
    expect(f.sent.some((r) => r.url.includes("save-codex"))).toBe(false);
  });
  it("fails closed on unknown native schemas", async () => {
    const f = fixture([{ ...connection, source: "future" } as unknown as CodexSshConnection]);
    await expect(f.client.list()).rejects.toThrow("unsupported");
    await expect(createCodexSshClient({} as Window).list()).rejects.toThrow("unavailable");
  });
  it("does not send a cancelled operation", async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(f.client.list(abort.signal)).rejects.toThrow("Aborted");
    expect(f.sent).toHaveLength(0);
  });
  it("times out without repeating mutations", async () => {
    vi.useFakeTimers();
    try {
      const events = new EventTarget();
      const send = vi.fn();
      const owner = {
        crypto,
        setTimeout,
        clearTimeout,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        electronBridge: { sendMessageFromView: send },
      } as unknown as Window;
      const assertion = expect(createCodexSshClient(owner).connect("a", true)).rejects.toThrow(
        "timed out",
      );
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
