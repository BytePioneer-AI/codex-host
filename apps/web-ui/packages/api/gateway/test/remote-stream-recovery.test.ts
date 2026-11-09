import assert from "node:assert/strict";
import { it } from "node:test";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import { RemoteStream } from "../src/client/remote-stream.ts";
import { RemoteStreamCarrierError } from "../src/client/stream-client.ts";

// The event connection still reports a healthy generation while the separate
// stream carrier fails. Reconnection must not require an event-channel reset.
const online = {
  generation: {
    getSnapshot: () => ({ id: 1 }),
    subscribe: () => () => {},
  },
} as unknown as ConstructorParameters<typeof RemoteStream>[0];

it("keeps retrying carrier failures until an authoritative stream can reopen", async () => {
  let attempts = 0;
  const stream = new RemoteStream<string>(online, {
    name: "queue and usage",
    open: async function* () {
      if (++attempts <= 3) throw new RemoteStreamCarrierError("temporary loss");
      yield "latest baseline";
      yield "next update";
    },
    ended: () => new Error("unexpected end"),
  });
  const reader = stream[Symbol.asyncIterator]();
  const baseline = await reader.next();
  assert.equal(baseline.value.value, "latest baseline");
  baseline.value.accept();
  assert.equal((await reader.next()).value.value, "next update");
  assert.equal(attempts, 4);
  await stream.dispose();
});

it("cancels retry backoff without reopening a disposed consumer", async () => {
  const failed = Promise.withResolvers<undefined>();
  let attempts = 0;
  const stream = new RemoteStream<never>(online, {
    name: "disposed control",
    open: async function* () {
      attempts++;
      throw new RemoteStreamCarrierError("temporary loss");
    },
    ended: () => new Error("unexpected end"),
    carrierFailed: () => failed.resolve(undefined),
  });
  const next = stream[Symbol.asyncIterator]().next();
  await failed.promise;
  await stream.dispose();
  assert.equal((await next).done, true);
  assert.equal(attempts, 1);
});

it("does not retry a business failure as a network failure", async () => {
  let attempts = 0;
  const failure = new RemoteError("gateway/internal", "invalid baseline", {});
  const stream = new RemoteStream<never>(online, {
    name: "invalid control",
    open: async function* () {
      attempts++;
      throw failure;
    },
    ended: () => new Error("unexpected end"),
  });
  await assert.rejects(stream[Symbol.asyncIterator]().next(), (error) => error === failure);
  assert.equal(attempts, 1);
  await stream.dispose();
});
