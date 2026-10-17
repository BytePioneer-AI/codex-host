import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/shared-contracts";
import {
  completePiTurn,
  createFixture,
  requestId,
  startExternalThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

const externalSandbox = { type: "externalSandbox", networkAccess: "enabled" };

describe("external Thread sandbox ownership", () => {
  it.each(["read-only", "workspace-write", "danger-full-access"])(
    "does not claim Codex enforces the requested %s sandbox",
    async (sandbox) => {
      const fixture = createFixture();
      const open = vi.spyOn(fixture.adapter, "open");
      try {
        await startExternalThread(fixture, "codexhost/pi-native", 1, { sandbox });
        expect(await fixture.collector.waitFor((message) => requestId(message, 1))).toMatchObject({
          result: { sandbox: externalSandbox },
        });
        expect(open).toHaveBeenCalledOnce();
        expect(open.mock.calls[0]?.[0]).not.toHaveProperty("sandbox");
        expect(fixture.official.stdin.readableLength).toBe(0);
      } finally {
        await stopFixture(fixture);
      }
    },
  );

  it("keeps sandbox enforcement external after resume and fork", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startExternalThread(fixture, "codexhost/pi-native");
      await completePiTurn(fixture, threadId, 2);
      for (const [id, method] of [
        [3, "thread/resume"],
        [4, "thread/fork"],
      ] as const) {
        writeRequest(fixture.desktopInput, { id, method, params: { threadId } });
        expect(await fixture.collector.waitFor((message) => requestId(message, id))).toMatchObject({
          result: { sandbox: externalSandbox },
        });
      }
      expect(fixture.official.stdin.readableLength).toBe(0);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("accepts the reasoning-summary patch used by native voice startup", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startExternalThread(fixture, "codexhost/pi-native");
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Expected external session");
      const execute = vi.spyOn(session, "execute");
      const before = session.state.effectivePermissionModeId;
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "thread/settings/update",
        params: { threadId, summary: "detailed" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 2))).toMatchObject({
        result: {},
      });
      expect(execute).not.toHaveBeenCalled();
      expect(session.state.effectivePermissionModeId).toBe(before);
      expect(fixture.official.stdin.readableLength).toBe(0);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("acknowledges native permission patches without applying them", async () => {
    const fixture = createFixture();
    try {
      const threadId = await startExternalThread(fixture, "codexhost/pi-native");
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Expected external session");
      const execute = vi.spyOn(session, "execute");
      const before = session.state.effectivePermissionModeId;
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "thread/settings/update",
        params: { threadId, sandboxPolicy: { type: "dangerFullAccess" } },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 2))).toMatchObject({
        result: {},
      });
      expect(execute).not.toHaveBeenCalled();
      expect(session.state.effectivePermissionModeId).toBe(before);
      expect(fixture.official.stdin.readableLength).toBe(0);
    } finally {
      await stopFixture(fixture);
    }
  });
});
