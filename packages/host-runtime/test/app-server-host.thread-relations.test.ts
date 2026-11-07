import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { harnessIdSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";

import {
  FailingOwnershipMappingStore,
  createFixture,
  requestId,
  startPiThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

describe("AppServerHost sidebar Thread relations", () => {
  it("lists persisted Delegation parents locally without official Codex traffic", async () => {
    const fixture = createFixture();
    const childThreadId = await startPiThread(fixture);
    await fixture.mappingStore.createDelegation({
      delegationId: hostThreadIdSchema.parse("relation-delegation"),
      parentHostThreadId: hostThreadIdSchema.parse("official-parent"),
      childHostThreadId: hostThreadIdSchema.parse(childThreadId),
      sourceHarnessId: harnessIdSchema.parse("codex"),
      targetHarnessId: harnessIdSchema.parse("pi"),
      status: "running",
      taskDigest: "a".repeat(64),
    });
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);

    writeRequest(fixture.desktopInput, {
      id: 51,
      method: "codexhost/thread/relation/list",
      params: { threadIds: ["official-parent", childThreadId] },
    });

    await expect(fixture.collector.waitFor((message) => requestId(message, 51))).resolves.toEqual({
      id: 51,
      result: {
        threads: [
          { threadId: "official-parent", owner: "codex", parent: null },
          {
            threadId: childThreadId,
            owner: "external",
            parent: { threadId: "official-parent", relation: "delegation" },
          },
        ],
      },
    });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("rejects invalid or unreadable relation-list metadata locally", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-test-"));
    const mappingStore = new FailingOwnershipMappingStore({ directory });
    const fixture = createFixture({ mappingStore, mappingStoreDirectory: directory });
    await fixture.ready;
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);

    writeRequest(fixture.desktopInput, {
      id: 52,
      method: "codexhost/thread/relation/list",
      params: { threadIds: ["duplicate", "duplicate"] },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 52)),
    ).resolves.toMatchObject({ error: { code: -32602 } });

    writeRequest(fixture.desktopInput, {
      id: 53,
      method: "codexhost/thread/relation/list",
      params: { threadIds: ["unreadable-thread"] },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 53)),
    ).resolves.toMatchObject({ error: { code: -32081 } });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });
});
