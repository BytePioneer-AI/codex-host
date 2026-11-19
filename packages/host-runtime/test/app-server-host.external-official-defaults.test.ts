import { describe, expect, it } from "vitest";

import {
  JsonLineCollector,
  createFixture,
  requestId,
  startPiThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

describe("External Thread official per-Thread defaults", () => {
  it("answers official list and settings requests with empty results instead of errors", async () => {
    const fixture = createFixture();
    const official = new JsonLineCollector(fixture.official.stdin);
    const threadId = await startPiThread(fixture);

    const requests = [
      { id: 40, method: "thread/attachment/list", params: { threadId, limit: 100 } },
      { id: 41, method: "thread/queue/list", params: { threadId, limit: 100 } },
      {
        id: 42,
        method: "thread/settings/update",
        params: {
          threadId,
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
        },
      },
      { id: 43, method: "thread/future/manage", params: { threadId } },
    ];
    for (const request of requests) writeRequest(fixture.desktopInput, request);

    await expect(
      fixture.collector.waitFor((message) => requestId(message, 40)),
    ).resolves.toMatchObject({ result: { data: [], nextCursor: null } });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 41)),
    ).resolves.toMatchObject({ result: { data: [], nextCursor: null } });
    const settings = await fixture.collector.waitFor((message) => requestId(message, 42));
    expect(settings.result).toEqual({});
    expect(settings.error).toBeUndefined();
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 43)),
    ).resolves.toMatchObject({
      error: { code: -32076, message: "External Thread does not support thread/future/manage" },
    });

    const handled = new Set(requests.map((request) => request.method));
    expect(official.messages.some((message) => handled.has(String(message.method)))).toBe(false);
    await stopFixture(fixture);
  });
});
