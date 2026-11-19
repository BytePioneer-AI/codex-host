import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { SharedThreadOwner } from "../src/shared-thread-owner.js";

function fixture() {
  const owner = new SharedThreadOwner();
  return {
    owner,
    dispose() {
      owner.close();
      owner.output.end();
    },
  };
}

describe("shared Thread owner lifetime", () => {
  it("closes every live peer on shutdown, including peers connected after shutdown", async () => {
    const { owner, dispose } = fixture();
    try {
      const first = owner.connect();
      const peers = [first, owner.connect(), owner.connect()];
      first.close();
      owner.close();
      owner.close();
      peers.push(owner.connect());
      await Promise.all(peers.map((peer) => peer.closed));
      for (const peer of peers) {
        await expect(peer.request("thread/list", {})).rejects.toThrow("closed");
      }
    } finally {
      dispose();
    }
  });

  it("closes viewers when the underlying Host output ends", async () => {
    const { owner, dispose } = fixture();
    try {
      const peer = owner.connect();
      owner.output.end();
      await peer.closed;
      await expect(peer.request("thread/list", {})).rejects.toThrow("closed");
    } finally {
      dispose();
    }
  });

  it("detaches one viewer without closing or notifying the others", async () => {
    const { owner, dispose } = fixture();
    try {
      const retired = owner.connect();
      const live = owner.connect();
      const retiredListener = vi.fn();
      const liveListener = vi.fn();
      retired.subscribe(retiredListener);
      live.subscribe(liveListener);
      retired.close();
      const message = { method: "thread/started", params: { thread: { id: "external" } } };
      owner.output.write(`${JSON.stringify(message)}\n`);
      await vi.waitFor(() => expect(liveListener).toHaveBeenCalledWith(message));
      expect(retiredListener).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("allows closed viewers to be collected while the owner remains alive", () => {
    // An isolated process exposes GC without changing the test runner's V8 flags.
    // Workspace tests build dist first; the child exercises that production module.
    const moduleUrl = new URL("../dist/shared-thread-owner.js", import.meta.url).href;
    const output = execFileSync(
      process.execPath,
      [
        "--expose-gc",
        "--input-type=module",
        "-e",
        `
          import { setImmediate } from 'node:timers/promises';
          import { SharedThreadOwner } from ${JSON.stringify(moduleUrl)};
          const owner = new SharedThreadOwner();
          function closedViewers() {
            return Array.from({ length: 1000 }, () => {
              const peer = owner.connect();
              peer.close();
              return new WeakRef(peer);
            });
          }
          const refs = closedViewers();
          for (let i = 0; i < 10; i++) {
            await setImmediate();
            global.gc();
          }
          const retained = refs.filter(ref => ref.deref() !== undefined).length;
          const live = owner.connect();
          const received = new Promise(resolve => live.subscribe(resolve));
          owner.output.write(JSON.stringify({ method: 'audit/alive', params: {} }) + '\\n');
          await received;
          owner.close();
          owner.output.end();
          console.log(JSON.stringify({ retained }));
        `,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(JSON.parse(output)).toEqual({ retained: 0 });
  });
});
