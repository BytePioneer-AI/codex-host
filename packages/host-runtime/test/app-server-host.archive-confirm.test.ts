import type { JsonObject } from "@codexhost/protocol-core";
import {
  THREAD_ARCHIVE_CONFIRM_METHOD,
  threadArchiveConfirmResultSchema,
} from "@codexhost/shared-contracts";
import { afterEach, expect, it, vi } from "vitest";
import { OfficialRuntimeClient } from "../src/codex-runtime/official-runtime-scope.js";
import {
  createFixture,
  startPiThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) await close();
});

it("routes public client and Desktop/CDP confirmation through the same native-only read", async () => {
  const fixture = createFixture();
  cleanup.push(() => stopFixture(fixture));
  await fixture.ready;
  const request = vi
    .spyOn(OfficialRuntimeClient.prototype, "request")
    .mockResolvedValue({ result: { data: [{ id: "native" }], nextCursor: null } });
  const reply = await fixture.host.handleClientRequest(THREAD_ARCHIVE_CONFIRM_METHOD, {
    threadId: "native",
  });
  expect(reply).toEqual({ result: { confirmed: true } });
  if (!("result" in reply)) throw new Error("Expected confirmation result");
  expect(threadArchiveConfirmResultSchema.parse(reply.result)).toEqual({ confirmed: true });
  expect(request).toHaveBeenCalledExactlyOnceWith("thread/list", {
    archived: true,
    limit: 100,
    cursor: null,
  });
  writeRequest(fixture.desktopInput, {
    id: 900,
    method: THREAD_ARCHIVE_CONFIRM_METHOD,
    params: { threadId: "native" },
  });
  expect(await fixture.collector.waitFor((message) => message.id === 900)).toMatchObject({
    result: { confirmed: true },
  });
  expect(request).toHaveBeenCalledTimes(2);
});

it("rejects malformed client and Desktop params without native requests", async () => {
  const fixture = createFixture();
  cleanup.push(() => stopFixture(fixture));
  await fixture.ready;
  const request = vi.spyOn(OfficialRuntimeClient.prototype, "request");
  let id = 910;
  for (const params of [
    {},
    { threadId: 1 },
    { threadId: "" },
    { threadId: "native", extra: true },
  ]) {
    expect(
      await fixture.host.handleClientRequest(THREAD_ARCHIVE_CONFIRM_METHOD, params),
    ).toMatchObject({ error: { code: -32602 } });
    const requestId = id++;
    writeRequest(fixture.desktopInput, {
      id: requestId,
      method: THREAD_ARCHIVE_CONFIRM_METHOD,
      params,
    });
    expect(await fixture.collector.waitFor((message) => message.id === requestId)).toMatchObject({
      error: { code: -32602 },
    });
  }
  expect(request).not.toHaveBeenCalled();
});

it("does not read native Codex for an external owner on either route", async () => {
  const fixture = createFixture();
  cleanup.push(() => stopFixture(fixture));
  const threadId = await startPiThread(fixture);
  const request = vi.spyOn(OfficialRuntimeClient.prototype, "request");
  expect(
    await fixture.host.handleClientRequest(THREAD_ARCHIVE_CONFIRM_METHOD, { threadId }),
  ).toEqual({ result: { confirmed: false } });
  writeRequest(fixture.desktopInput, {
    id: 902,
    method: THREAD_ARCHIVE_CONFIRM_METHOD,
    params: { threadId },
  });
  expect(await fixture.collector.waitFor((message) => message.id === 902)).toMatchObject({
    result: { confirmed: false },
  });
  expect(request).not.toHaveBeenCalled();
});

it("keeps official errors and invalid reads unconfirmed rather than confirming absence", async () => {
  const fixture = createFixture();
  cleanup.push(() => stopFixture(fixture));
  await fixture.ready;
  const request = vi.spyOn(OfficialRuntimeClient.prototype, "request");
  for (const response of [
    { error: { code: -32000, message: "official error" } },
    { result: { invalid: true } },
    { result: { data: [], nextCursor: null } },
  ]) {
    request.mockResolvedValueOnce(response);
    expect(
      await fixture.host.handleClientRequest(THREAD_ARCHIVE_CONFIRM_METHOD, { threadId: "native" }),
    ).toEqual({ result: { confirmed: false } });
  }
});

it("does not confirm a delayed archived page after Host observes a newer native unarchive", async () => {
  const fixture = createFixture();
  cleanup.push(() => stopFixture(fixture));
  await fixture.ready;
  const started = Promise.withResolvers<undefined>();
  const page = Promise.withResolvers<JsonObject>();
  vi.spyOn(OfficialRuntimeClient.prototype, "request").mockImplementation(() => {
    started.resolve(undefined);
    return page.promise;
  });
  const reply = fixture.host.handleClientRequest(THREAD_ARCHIVE_CONFIRM_METHOD, {
    threadId: "native",
  });
  await started.promise;
  fixture.official.stdout.write(
    `${JSON.stringify({
      method: "thread/unarchived",
      params: { threadId: "native" },
    })}\n`,
  );
  await fixture.collector.waitFor((message) => message.method === "thread/unarchived");
  page.resolve({ result: { data: [{ id: "native" }], nextCursor: null } });
  expect(await reply).toEqual({ result: { confirmed: false } });
});
