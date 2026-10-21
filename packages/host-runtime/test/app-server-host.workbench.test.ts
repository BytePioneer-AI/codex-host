import { expect, it } from "vitest";
import type { JsonValue } from "@codexhost/protocol-core";
import { WORKBENCH_GET_METHOD, WORKBENCH_SET_METHOD } from "@codexhost/shared-contracts";
import { createFixture, stopFixture, writeRequest, requestId } from "./app-server-host-fixture.js";

it("routes validated workbench reads and writes locally without contacting the official service", async () => {
  const fixture = createFixture();
  try {
    const request = async (id: number, method: string, params: JsonValue) => {
      writeRequest(fixture.desktopInput, { id, method, params });
      return fixture.collector.waitFor((message) => requestId(message, id));
    };
    expect(await request(901, WORKBENCH_GET_METHOD, {})).toMatchObject({
      result: { version: 1, entries: [] },
    });
    const config = {
      version: 1,
      entries: [
        {
          id: "tasks",
          category: "projects",
          name: "Tasks",
          icon: "✅",
          url: "https://example.com/tasks",
        },
      ],
    };
    expect(await request(902, WORKBENCH_SET_METHOD, config)).toMatchObject({ result: config });
    expect(await request(903, WORKBENCH_GET_METHOD, {})).toMatchObject({ result: config });
    expect(
      await request(904, WORKBENCH_SET_METHOD, {
        version: 1,
        entries: [{ ...config.entries[0], url: "file:///tmp/test" }],
      }),
    ).toMatchObject({ error: { code: -32602 } });
    expect(await request(905, WORKBENCH_GET_METHOD, { unexpected: true })).toMatchObject({
      error: { code: -32602 },
    });
    expect(await request(906, WORKBENCH_GET_METHOD, {})).toMatchObject({ result: config });
    expect(fixture.official.stdin.readableLength).toBe(0);
  } finally {
    await stopFixture(fixture);
  }
});
