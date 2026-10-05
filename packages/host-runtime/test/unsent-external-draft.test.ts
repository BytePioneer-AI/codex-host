import { describe, expect, it } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import { CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID } from "@codexhost/protocol-core";
import {
  createFixture,
  startExternalThread,
  stopFixture,
  writeRequest,
  requestId,
  method,
  readJsonLine,
} from "./app-server-host-fixture.js";

function delayedIdentityAdapter() {
  const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
  const open = adapter.open.bind(adapter);
  adapter.open = async (input) => {
    const result = await open(input);
    if (result.ok && input.kind === "create") delete result.value.initialState.nativeRef;
    return result;
  };
  return adapter;
}

describe("unsent external drafts", () => {
  it("keeps a delayed-identity draft out of the catalog and reads its empty history", async () => {
    const adapter = delayedIdentityAdapter();
    const fixture = createFixture({ externalAdapters: new Map([["claude-code", adapter]]) });
    try {
      const threadId = await startExternalThread(
        fixture,
        CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
        1,
        {
          historyMode: "paginated",
          codexhostPrewarm: true,
        },
      );
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "thread/turns/list",
        params: { threadId, limit: 1 },
      });
      const history = await fixture.collector.waitFor((m) => requestId(m, 2));
      expect(history).not.toHaveProperty("error");
      expect(history).toMatchObject({ result: { data: [], nextCursor: null } });
      expect(fixture.collector.messages.filter((m) => method(m, "thread/started"))).toEqual([]);
      writeRequest(fixture.desktopInput, { id: 3, method: "thread/list", params: {} });
      const list = await readJsonLine(fixture.official.stdin);
      fixture.official.stdout.write(
        `${JSON.stringify({ id: list.id, result: { data: [], nextCursor: null } })}\n`,
      );
      expect(await fixture.collector.waitFor((m) => requestId(m, 3))).toMatchObject({
        result: { data: [] },
      });
      writeRequest(fixture.desktopInput, { id: 4, method: "thread/delete", params: { threadId } });
      expect(await fixture.collector.waitFor((m) => requestId(m, 4))).not.toHaveProperty("error");
      expect(
        await fixture.mappingStore.getThread(
          threadId as Parameters<typeof fixture.mappingStore.getThread>[0],
        ),
      ).toBeNull();
    } finally {
      await stopFixture(fixture);
    }
  });
});
