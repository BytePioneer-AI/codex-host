import type { JsonObject } from "@codexhost/protocol-core";
import { describe, expect, it, vi } from "vitest";

import { OfficialRequestBroker } from "../src/official-request-broker.js";

describe("OfficialRequestBroker", () => {
  it("correlates only its isolated internal response", async () => {
    const sent: JsonObject[] = [];
    const broker = new OfficialRequestBroker({
      send(request) {
        sent.push(request);
        return Promise.resolve();
      },
      nextId: () => "codexhost:official:one",
    });
    const response = broker.request("thread/list", { limit: 2 });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(broker.handle({ id: 99, result: {} })).toBe(false);
    expect(broker.handle({ id: "codexhost:official:one", result: { data: [] } })).toBe(true);
    await expect(response).resolves.toEqual({
      id: "codexhost:official:one",
      result: { data: [] },
    });
    expect(broker.pendingCount).toBe(0);
  });

  it("rejects duplicate internal IDs and consumes a late retired response", async () => {
    const broker = new OfficialRequestBroker({
      send: () => Promise.resolve(),
      nextId: () => "codexhost:official:duplicate",
    });
    const first = broker.request("thread/list", {});
    await expect(broker.request("thread/list", {})).rejects.toThrow("duplicated");
    broker.handle({ id: "codexhost:official:duplicate", result: { data: [] } });
    await expect(first).resolves.toBeDefined();
    expect(broker.handle({ id: "codexhost:official:duplicate", result: { data: [] } })).toBe(true);
  });

  it("settles pending requests on timeout, send failure, and shutdown", async () => {
    const timedOut = new OfficialRequestBroker({
      send: () => Promise.resolve(),
      timeoutMs: 5,
      nextId: () => "codexhost:official:timeout",
    });
    await expect(timedOut.request("thread/list", {})).rejects.toThrow("timed out");

    const failedSend = new OfficialRequestBroker({
      send: () => Promise.reject(new Error("write failed")),
      nextId: () => "codexhost:official:write",
    });
    await expect(failedSend.request("thread/list", {})).rejects.toThrow("write failed");

    const closed = new OfficialRequestBroker({
      send: () => Promise.resolve(),
      nextId: () => "codexhost:official:close",
    });
    const pending = closed.request("thread/list", {});
    closed.failAll(new Error("official closed"));
    await expect(pending).rejects.toThrow("official closed");
    expect(closed.pendingCount).toBe(0);
  });
});
