import { describe, expect, it, vi } from "vitest";

import {
  createFixture,
  readJsonLine,
  requestId,
  requiredMessageId,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

describe("native MCP App thread startup", () => {
  it.each([{}, { model: null }])(
    "forwards internal default-Model Threads and their responses unchanged: %j",
    async (selection) => {
      const fixture = createFixture();
      try {
        await fixture.ready;
        writeRequest(fixture.desktopInput, {
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "mcp-app-test", version: "1" },
            capabilities: { experimentalApi: true },
          },
        });
        const initialize = await readJsonLine(fixture.official.stdin);
        writeRequest(fixture.official.stdout, {
          id: requiredMessageId(initialize),
          result: { userAgent: "official" },
        });
        await fixture.collector.waitFor((message) => requestId(message, 1));
        expect(await readJsonLine(fixture.official.stdin)).toMatchObject({
          method: "initialized",
        });

        const params = {
          ephemeral: true,
          permissions: ":read-only",
          threadSource: "mcp_extension_host",
          ...selection,
        };
        writeRequest(fixture.desktopInput, { id: 2, method: "thread/start", params });
        await vi.waitFor(() => expect(fixture.official.stdin.readableLength).toBeGreaterThan(0));
        const started = await readJsonLine(fixture.official.stdin);
        expect(started).toMatchObject({ method: "thread/start", params });
        expect(started.params).toEqual(params);
        const result = { thread: { id: "native-mcp-app-thread" }, model: "native-default" };
        writeRequest(fixture.official.stdout, { id: requiredMessageId(started), result });
        expect(await fixture.collector.waitFor((message) => requestId(message, 2))).toEqual({
          id: 2,
          result,
        });
        expect(fixture.adapter.sessions).toHaveLength(0);
      } finally {
        await stopFixture(fixture);
      }
    },
  );
});
