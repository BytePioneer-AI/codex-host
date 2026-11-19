import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { harnessModelSelectionStateSchema } from "@codexhost/shared-contracts";
import { ChSessions } from "../src/ch-sessions.ts";
import { DataDir } from "../src/store.ts";
import { Workspaces } from "../src/workspaces.ts";
import {
  EventHub,
  RpcError,
  RpcRegistry,
  StreamRegistry,
  type StreamHandler,
  type StreamSink,
} from "../src/transport.ts";
import { FakeChChannel } from "./support/ch-channel.ts";
import { nativeCodex } from "./support/native-codex.ts";

class Streams extends StreamRegistry {
  readonly endpoints = new Map<string, StreamHandler>();
  override register(name: string, handler: StreamHandler): void {
    super.register(name, handler);
    this.endpoints.set(name, handler);
  }
}

async function fixture(t: TestContext, native = false) {
  const root = mkdtempSync(join(tmpdir(), "ch-model-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = native ? nativeCodex(new FakeChChannel()) : new FakeChChannel();
  const source = host.add(native ? "native-source" : "source", root);
  let configuration = harnessModelSelectionStateSchema.parse({
    effectiveModel: { id: "native" },
    effectiveThinkingOptionId: "auto",
  });
  const behavior = { rejectModel: false, rejectThinking: false, modelId: "confirmed-model" };
  const request = host.request.bind(host);
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "codexhost/thread/model/select") {
      host.requests.push({ method, params });
      if (behavior.rejectModel) throw new RpcError("model/rejected", "Model rejected");
      if (native && (params.model as { id: string }).id === configuration.effectiveModel?.id)
        throw new RpcError("host/rejected", "Codex settings confirmation timed out");
      configuration = harnessModelSelectionStateSchema.parse({
        ...configuration,
        effectiveModel: { id: behavior.modelId },
      });
      return structuredClone(configuration) as T;
    }
    if (method === "codexhost/thread/thinking/select") {
      host.requests.push({ method, params });
      if (behavior.rejectThinking) throw new RpcError("thinking/rejected", "Thinking rejected");
      configuration = harnessModelSelectionStateSchema.parse({
        ...configuration,
        effectiveThinkingOptionId: "high",
      });
      return structuredClone(configuration) as T;
    }
    const result = await request<T>(method, params);
    return method === "codexhost/thread/inspect"
      ? ({ ...result, ...structuredClone(configuration) } as T)
      : result;
  };
  const snapshot = host.snapshot.bind(host);
  host.snapshot = async (...args) => {
    const captured = structuredClone(configuration);
    return { ...(await snapshot(...args)), configuration: captured };
  };
  const sessions = new ChSessions(
    host,
    new Workspaces(new DataDir(root), root),
    new EventHub(root),
  );
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  const streams = new Streams();
  sessions.register(rpc, streams);
  const read = () =>
    rpc.dispatch("session/projections", { args: { request: { sessionId: source.id } } });
  assert.ok((await read()).ok);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const frames: Array<Record<string, unknown>> = [];
  const cleanups: Array<() => void> = [];
  const sink: StreamSink = {
    id: "control",
    closed: false,
    push: (value) => frames.push(value as Record<string, unknown>),
    onClose: (cleanup) => cleanups.push(cleanup),
    end: () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
    fail: (code, message) => {
      throw new Error(`${code}: ${message}`);
    },
  };
  await streams.endpoints.get("session/control")?.({}, sink);
  t.after(() => sink.end());
  const select = (reasoningEffort?: string, model = "requested-model") =>
    rpc.dispatch("session/selectModel", {
      args: {
        request: {
          sessionId: source.id,
          provider: native ? "codex" : "fake",
          model,
          ...(reasoningEffort ? { reasoningEffort } : {}),
        },
      },
    });
  const selections = () =>
    frames.filter((frame) => frame.type === "projection" && frame.key === "modelSelection");
  return { host, sessions, read, select, selections, behavior };
}

function expectedSelection(model: string, reasoningEffort = "auto", provider = "fake") {
  const selection = { provider, model, reasoningEffort };
  return { lastUsed: selection, next: selection };
}

it(
  "publishes confirmed Model and Thinking without history or Harness discovery",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    // Neither dependency may turn a confirmed configuration write into a failure.
    f.host.historyError = "History unavailable";
    f.sessions.catalog.inspect = async () => {
      throw new Error("Discovery unavailable");
    };
    const before = f.host.requests.length;
    const snapshots = f.host.snapshots;
    assert.ok((await f.select("high")).ok);
    assert.equal(f.host.snapshots, snapshots);
    assert.deepEqual(
      f.host.requests.slice(before).map(({ method }) => method),
      [
        "codexhost/thread/inspect",
        "codexhost/thread/model/select",
        "codexhost/thread/thinking/select",
      ],
    );
    assert.deepEqual(
      f.selections().map((frame) => frame.value),
      [expectedSelection("confirmed-model"), expectedSelection("confirmed-model", "high")],
    );
  },
);

it("changes native Thinking without resubmitting the unchanged Model", async (t) => {
  const f = await fixture(t, true);
  const before = f.host.requests.length;
  assert.ok((await f.select("high", "native")).ok);
  assert.deepEqual(
    f.host.requests.slice(before).map(({ method }) => method),
    ["codexhost/thread/inspect", "codexhost/thread/thinking/select"],
  );
  assert.deepEqual(f.selections().at(-1)?.value, expectedSelection("native", "high", "codex"));
  const confirmed = f.host.requests.length;
  assert.ok((await f.select("high", "native")).ok);
  assert.deepEqual(
    f.host.requests.slice(confirmed).map(({ method }) => method),
    ["codexhost/thread/inspect"],
  );
});

it("does not submit settings when native Model and Thinking are already selected", async (t) => {
  const f = await fixture(t, true);
  const before = f.host.requests.length;
  assert.ok((await f.select("auto", "native")).ok);
  assert.deepEqual(
    f.host.requests.slice(before).map(({ method }) => method),
    ["codexhost/thread/inspect"],
  );
  assert.deepEqual(f.selections(), []);
});

it("still submits a changed native Model before changing Thinking", async (t) => {
  const f = await fixture(t, true);
  const before = f.host.requests.length;
  assert.ok((await f.select("high")).ok);
  assert.deepEqual(
    f.host.requests.slice(before).map(({ method }) => method),
    [
      "codexhost/thread/inspect",
      "codexhost/thread/model/select",
      "codexhost/thread/thinking/select",
    ],
  );
  assert.deepEqual(
    f.selections().at(-1)?.value,
    expectedSelection("confirmed-model", "high", "codex"),
  );
});

it("does not reapply Thinking already confirmed by the Model switch", async (t) => {
  const f = await fixture(t);
  const before = f.host.requests.length;
  assert.ok((await f.select("auto")).ok);
  assert.deepEqual(
    f.host.requests.slice(before).map(({ method }) => method),
    ["codexhost/thread/inspect", "codexhost/thread/model/select"],
  );
  assert.deepEqual(f.selections().at(-1)?.value, expectedSelection("confirmed-model"));
});

it("does not wait for slow Harness discovery to publish a Model", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const gate = Promise.withResolvers<undefined>();
  t.after(() => gate.resolve(undefined));
  const started = Promise.withResolvers<undefined>();
  const inspect = f.sessions.catalog.inspect.bind(f.sessions.catalog);
  f.sessions.catalog.inspect = async (...args) => {
    started.resolve(undefined);
    await gate.promise;
    return inspect(...args);
  };
  assert.ok((await f.read()).ok);
  await started.promise;
  assert.ok((await f.select()).ok);
  assert.deepEqual(f.selections().at(-1)?.value, expectedSelection("confirmed-model"));
  const count = f.selections().length;
  gate.resolve(undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.selections().length, count, "an older controls load cannot restore the old Model");
});

it(
  "a snapshot started before selection cannot overwrite its acknowledgement",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const gate = Promise.withResolvers<undefined>();
    t.after(() => gate.resolve(undefined));
    const started = Promise.withResolvers<undefined>();
    f.host.delaySnapshot = () => {
      started.resolve(undefined);
      return gate.promise;
    };
    const reading = f.read();
    await started.promise;
    assert.ok((await f.select()).ok);
    assert.deepEqual(f.selections().at(-1)?.value, expectedSelection("confirmed-model"));
    const count = f.selections().length;
    gate.resolve(undefined);
    assert.ok((await reading).ok);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      f.selections().length,
      count,
      "late history cannot initiate a stale controls load",
    );
    f.host.delaySnapshot = undefined;
    assert.ok((await f.read()).ok);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(f.selections().at(-1)?.value, expectedSelection("confirmed-model"));
  },
);

it("preserves the old Model when native selection is rejected", async (t) => {
  const f = await fixture(t);
  f.behavior.rejectModel = true;
  const result = await f.select();
  assert.equal(result.ok, false);
  assert.deepEqual(f.selections(), []);
});

it("retains the confirmed Model when the subsequent Thinking selection fails", async (t) => {
  const f = await fixture(t);
  f.behavior.rejectThinking = true;
  const result = await f.select("high");
  assert.equal(result.ok, false);
  assert.deepEqual(
    f.selections().map((frame) => frame.value),
    [expectedSelection("confirmed-model")],
  );
});
