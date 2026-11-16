import assert from "node:assert/strict";
import { it } from "node:test";
import { ChHarnessCatalog } from "../src/ch-harness-catalog.ts";

type InspectCall = { harnessId: string; cwd?: string };

function stubHost(responses: Array<unknown>) {
  const calls: InspectCall[] = [];
  let index = 0;
  const host = {
    request(method: string, params: InspectCall) {
      assert.equal(method, "codexhost/harness/inspect");
      calls.push(params);
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (response instanceof Error) return Promise.reject(response);
      if (
        response &&
        typeof response === "object" &&
        "throw" in (response as Record<string, unknown>)
      )
        return Promise.reject(new Error("inspection failed"));
      return Promise.resolve(response);
    },
  };
  return { host: host as unknown as ConstructorParameters<typeof ChHarnessCatalog>[0], calls };
}

const ready = {
  status: "ready",
  catalog: {
    models: [{ ref: { id: "m1" }, label: "Model 1" }],
    defaultModel: { id: "m1" },
    thinkingOptions: [],
  },
  capabilities: {
    configuration: { selectModel: false, selectThinkingOption: false, selectPermissionMode: false },
    history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  },
};

const failed = {
  status: "unavailable",
  error: {
    code: "unavailable",
    message: "Antigravity CLI returned no usable Models",
    retryable: true,
  },
};

it("reuses a settled ready inspection without re-probing the Host", async () => {
  const { host, calls } = stubHost([ready]);
  const catalog = new ChHarnessCatalog(host);
  const [first, second] = await Promise.all([
    catalog.inspect("antigravity"),
    catalog.inspect("antigravity"),
  ]);
  assert.equal(first.status, "ready");
  assert.equal((await catalog.inspect("antigravity")).status, "ready");
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
});

it("retries after a settled failed inspection instead of caching it", async () => {
  const { host, calls } = stubHost([failed, ready]);
  const catalog = new ChHarnessCatalog(host);
  const first = await catalog.inspect("antigravity");
  assert.equal(first.status, "unavailable");
  const second = await catalog.inspect("antigravity");
  assert.equal(second.status, "ready");
  assert.equal(calls.length, 2);
});

it("coalesces concurrent inspections of the same failing harness", async () => {
  const { host, calls } = stubHost([{ throw: true }, ready]);
  const catalog = new ChHarnessCatalog(host);
  const [a, b] = await Promise.all([
    catalog.inspect("antigravity").then(
      () => "ok",
      () => "error",
    ),
    catalog.inspect("antigravity").then(
      () => "ok",
      () => "error",
    ),
  ]);
  assert.equal(a, "error");
  assert.equal(b, "error");
  assert.equal(calls.length, 1);
  assert.equal((await catalog.inspect("antigravity")).status, "ready");
  assert.equal(calls.length, 2);
});

it("does not cache a failed non-codex inspection (regression for issue 871)", async () => {
  const { host, calls } = stubHost([failed, failed, ready]);
  const catalog = new ChHarnessCatalog(host);
  await catalog.inspect("antigravity");
  await catalog.inspect("antigravity");
  assert.equal(calls.length, 2);
  assert.equal((await catalog.inspect("antigravity")).status, "ready");
  assert.equal(calls.length, 3);
});
