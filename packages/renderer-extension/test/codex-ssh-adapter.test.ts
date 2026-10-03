import { assert, describe, expect, it, vi } from "vitest";
import { createCodexSshClient, type CodexSshConnection } from "../src/codex-ssh-adapter.js";

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
function fixture(initial: unknown[] = [connection]) {
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
                responseType: "success",
                status: 200,
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
