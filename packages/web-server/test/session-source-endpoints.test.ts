import assert from "node:assert/strict";
import { it } from "node:test";

import { mergeSessionControls, SourceEndpoints } from "../src/session-source-endpoints.ts";
import { RpcError, type StreamSink } from "../src/transport.ts";

function requiredSink(sink: StreamSink | undefined): StreamSink {
  assert.ok(sink);
  return sink;
}

function output() {
  const values: unknown[] = [];
  const errors: Array<{ code: string; message: string }> = [];
  const listeners: Array<() => void> = [];
  let closed = false;
  const sink: StreamSink = {
    id: "merged",
    get closed() {
      return closed;
    },
    push(value) {
      if (!closed) values.push(value);
    },
    end() {
      if (closed) return;
      closed = true;
      for (const listener of listeners.splice(0)) listener();
    },
    fail(code, message) {
      errors.push({ code, message });
      sink.end();
    },
    onClose(listener) {
      if (closed) listener();
      else listeners.push(listener);
    },
  };
  return { sink, values, errors };
}

const baseline = (projections: Record<string, unknown> = {}) => ({
  type: "baseline",
  value: { projections },
});
const projection = (sessionId: string, seq: number) => ({
  type: "projection",
  sessionId,
  key: "queue",
  value: [],
  seq,
});

it("captures endpoint names, preserves RPC context, and unwraps source errors", async () => {
  const endpoints = new SourceEndpoints();
  endpoints.rpc.register("session/get", (args, context) => ({ args, method: context.method }));
  endpoints.rpc.register("session/fail", () => {
    throw new RpcError("session/not-found", "Missing", { sessionId: "absent" });
  });
  assert.deepEqual(endpoints.rpc.names(), ["session/get", "session/fail"]);
  assert.deepEqual(await endpoints.rpc.invoke("session/get", { sessionId: "web" }), {
    args: { sessionId: "web" },
    method: "session/get",
  });
  await assert.rejects(endpoints.rpc.invoke("session/fail", {}), {
    code: "session/not-found",
    message: "Missing",
    details: { sessionId: "absent" },
  });
  await assert.rejects(endpoints.rpc.invoke("session/missing", {}), { code: "gateway/not-found" });

  endpoints.streams.register("session/control", (args, sink) => sink.push(args));
  const { sink, values } = output();
  assert.deepEqual(endpoints.streams.names(), ["session/control"]);
  await endpoints.streams.open("session/control", { source: "codex" }, sink);
  assert.deepEqual(values, [{ source: "codex" }]);
  await assert.rejects(endpoints.streams.open("session/missing", {}, sink), {
    code: "gateway/not-found",
  });
  sink.end();
  await endpoints.streams.open("session/control", { ignored: true }, sink);
  assert.equal(values.length, 1);
});

it("emits one baseline after all sources are ready, then replays buffered deltas in order", async () => {
  const { sink, values, errors } = output();
  const delayed = Promise.withResolvers<undefined>();
  let first: StreamSink | undefined;
  let second: StreamSink | undefined;
  const opening = mergeSessionControls(
    [
      {
        accepts: () => true,
        open(child) {
          first = child;
          child.push(baseline({ external: { seq: 1 } }));
          child.push(projection("external", 2));
        },
      },
      {
        accepts: () => true,
        async open(child) {
          second = child;
          await delayed.promise;
          child.push(baseline({ codex: { seq: 3 } }));
        },
      },
    ],
    sink,
  );
  assert.deepEqual(values, []);
  requiredSink(first).push(projection("external", 4));
  delayed.resolve(undefined);
  await opening;
  requiredSink(second).push(projection("codex", 5));
  assert.deepEqual(values, [
    baseline({ external: { seq: 1 }, codex: { seq: 3 } }),
    projection("external", 2),
    projection("external", 4),
    projection("codex", 5),
  ]);
  assert.deepEqual(errors, []);
  sink.end();
});

it("filters baseline and buffered/live deltas using current source ownership", async () => {
  const { sink, values } = output();
  let masked = true;
  let source: StreamSink | undefined;
  const delayed = Promise.withResolvers<undefined>();
  const opening = mergeSessionControls(
    [
      {
        accepts: (id) => id !== "draft" || !masked,
        open(child) {
          source = child;
          child.push(baseline({ draft: "canonical", other: "external" }));
          child.push(projection("draft", 1));
        },
      },
      {
        accepts: (id) => id !== "draft" || masked,
        async open(child) {
          await delayed.promise;
          child.push(baseline({ draft: "visible draft" }));
        },
      },
    ],
    sink,
  );
  delayed.resolve(undefined);
  await opening;
  requiredSink(source).push(projection("draft", 2));
  requiredSink(source).push(projection("other", 3));
  assert.deepEqual(values, [
    baseline({ other: "external", draft: "visible draft" }),
    projection("other", 3),
  ]);
  masked = false;
  requiredSink(source).push(projection("draft", 4));
  assert.deepEqual(values.at(-1), projection("draft", 4));
  sink.end();
});

it("rejects colliding accepted session IDs and cleans up all opened sources", async () => {
  const { sink, values, errors } = output();
  const cleanups: number[] = [];
  await mergeSessionControls(
    [0, 1].map((index) => ({
      accepts: () => true,
      open(child: StreamSink) {
        child.onClose(() => cleanups.push(index));
        child.push(baseline({ shared: index }));
      },
    })),
    sink,
  );
  assert.equal(sink.closed, true);
  assert.deepEqual(values, []);
  assert.equal(errors[0]?.code, "session/source-collision");
  assert.deepEqual(cleanups, [0, 1]);
});

it("cancels all children on parent close and ignores an asynchronous late baseline", async () => {
  const { sink, values, errors } = output();
  const delayed = Promise.withResolvers<undefined>();
  let child: StreamSink | undefined;
  let cleaned = 0;
  const opening = mergeSessionControls(
    [
      {
        accepts: () => true,
        async open(value) {
          child = value;
          value.onClose(() => cleaned++);
          await delayed.promise;
          value.push(baseline({ late: true }));
          value.onClose(() => cleaned++);
        },
      },
    ],
    sink,
  );
  sink.end();
  await opening;
  assert.equal(requiredSink(child).closed, true);
  assert.equal(cleaned, 1);
  delayed.resolve(undefined);
  await delayed.promise;
  assert.equal(cleaned, 2);
  assert.deepEqual(values, []);
  assert.deepEqual(errors, []);
});

it("fails the entire stream when one source fails and closes every child exactly once", async () => {
  const { sink, values, errors } = output();
  const children: StreamSink[] = [];
  let cleaned = 0;
  await mergeSessionControls(
    [0, 1].map(() => ({
      accepts: () => true,
      open(child: StreamSink) {
        children.push(child);
        child.onClose(() => cleaned++);
        child.push(baseline());
      },
    })),
    sink,
  );
  requiredSink(children[1]).fail("source/disconnected", "Disconnected");
  requiredSink(children[0]).push(projection("stale", 1));
  requiredSink(children[0]).fail("source/again", "Again");
  assert.deepEqual(values, [baseline()]);
  assert.deepEqual(errors, [{ code: "source/disconnected", message: "Disconnected" }]);
  assert.equal(cleaned, 2);
});

it("fails if a source returns without a baseline or sends a duplicate baseline", async () => {
  for (const mode of ["missing", "duplicate"]) {
    const { sink, errors } = output();
    await mergeSessionControls(
      [
        {
          accepts: () => true,
          open(child) {
            if (mode === "duplicate") {
              child.push(baseline());
              child.push(baseline());
            }
          },
        },
      ],
      sink,
    );
    assert.equal(sink.closed, true);
    assert.equal(errors[0]?.code, "session/control-invalid");
  }
});

it("converts asynchronous open errors into terminal stream errors", async () => {
  const { sink, errors } = output();
  await mergeSessionControls(
    [
      {
        accepts: () => true,
        async open() {
          throw new RpcError("source/unavailable", "Unavailable");
        },
      },
    ],
    sink,
  );
  assert.deepEqual(errors, [{ code: "source/unavailable", message: "Unavailable" }]);
});

it("does not keep a partial combined stream alive after a source ends", async () => {
  const { sink, errors } = output();
  await mergeSessionControls(
    [
      {
        accepts: () => true,
        open(child) {
          child.push(baseline());
          child.end();
        },
      },
    ],
    sink,
  );
  assert.equal(sink.closed, true);
  assert.equal(errors[0]?.code, "session/source-ended");
});

it("publishes an empty baseline for no sources and does not open sources for a closed sink", async () => {
  const { sink, values } = output();
  await mergeSessionControls([], sink);
  assert.deepEqual(values, [baseline()]);
  sink.end();
  await mergeSessionControls(
    [
      {
        accepts: () => true,
        open() {
          assert.fail("closed source must not open");
        },
      },
    ],
    sink,
  );
});
