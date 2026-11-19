import assert from "node:assert/strict";
import { it } from "node:test";
import { fileUploadWorker } from "../src/client/runtime.ts";

function fixture() {
  type Scope = NonNullable<Parameters<typeof fileUploadWorker>[0]>;
  type Xhr = ReturnType<NonNullable<Parameters<typeof fileUploadWorker>[1]>>;
  const messages: Parameters<Scope["postMessage"]>[0][] = [];
  let aborted = 0;
  const xhr: Xhr & { abort(): void } = {
    upload: { onprogress: null },
    status: 200,
    responseText: "receipt",
    withCredentials: false,
    onload: null,
    onerror: null,
    open() {},
    setRequestHeader() {},
    send() {},
    abort() {
      aborted++;
      xhr.onerror?.({} as ProgressEvent);
    },
  };
  const scope: Scope = { onmessage: null, postMessage: (value) => messages.push(value) };
  fileUploadWorker(scope, () => xhr);
  const start = () => {
    scope.onmessage?.({
      data: { url: "https://upload.test/", headers: {}, body: new Blob(["bytes"]) },
    } as MessageEvent);
  };
  const progress = (loaded: number) =>
    xhr.upload.onprogress?.({ loaded, total: 5, lengthComputable: true } as ProgressEvent);
  return { xhr, scope, messages, start, progress, aborted: () => aborted };
}

it("fails and aborts an XHR after 60 seconds without any byte progress", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  f.start();
  t.mock.timers.tick(59_999);
  assert.deepEqual(f.messages, []);
  t.mock.timers.tick(1);
  assert.deepEqual(f.messages, [
    { kind: "error", message: "Upload made no progress for 60 seconds." },
  ]);
  assert.equal(f.aborted(), 1);
  t.mock.timers.tick(600_000);
  f.xhr.onload?.({} as ProgressEvent);
  assert.equal(f.messages.length, 1, "late transport events cannot settle twice");
});

it("allows a long upload while bytes keep advancing and clears its deadline on success", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  f.start();
  for (const loaded of [1, 2, 3]) {
    t.mock.timers.tick(50_000);
    f.progress(loaded);
    assert.equal(f.aborted(), 0);
  }
  f.xhr.onload?.({} as ProgressEvent);
  t.mock.timers.tick(600_000);
  assert.deepEqual(f.messages.at(-1), { kind: "complete", status: 200, body: "receipt" });
  assert.equal(f.aborted(), 0);
});

it("does not renew the deadline for duplicate progress or wait forever for a receipt at 100%", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  f.start();
  f.progress(5);
  t.mock.timers.tick(50_000);
  f.progress(5);
  t.mock.timers.tick(10_000);
  assert.equal(f.aborted(), 1);
  assert.equal(f.messages.at(-1)?.kind, "error");
});

it("clears the deadline on a network failure", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  f.start();
  f.xhr.onerror?.({} as ProgressEvent);
  t.mock.timers.tick(600_000);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0]?.kind, "error");
  assert.equal(f.aborted(), 0);
});

it("aborts fetch and cancels a stalled stream on the same idle deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  let signal: AbortSignal | null | undefined;
  let cancelled = false;
  fileUploadWorker(
    f.scope,
    () => f.xhr,
    async (_url, init) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  );
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  f.scope.onmessage?.({ data: { url: "https://upload.test/", headers: {}, body } } as MessageEvent);
  t.mock.timers.tick(60_000);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(signal?.aborted, true);
  assert.equal(cancelled, true);
  assert.deepEqual(f.messages, [
    { kind: "error", message: "Upload made no progress for 60 seconds." },
  ]);
});
