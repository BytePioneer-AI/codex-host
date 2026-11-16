import { harnessInspectionSchema, type HarnessInspection } from "@codexhost/shared-contracts";
import assert from "node:assert/strict";
import { it } from "node:test";
import type { ChHostClient } from "../src/ch-host-client.ts";
import { ChHarnessCatalog } from "../src/ch-harness-catalog.ts";

const ready = harnessInspectionSchema.parse({
  status: "ready",
  catalog: {
    models: [{ ref: { id: "model-a" }, label: "Model A" }],
    defaultModel: { id: "model-a" },
    thinkingOptions: [],
  },
  capabilities: {
    configuration: {
      selectModel: true,
      selectThinkingOption: false,
      selectPermissionMode: false,
      permissionModeScope: "live",
    },
    history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  },
});

const failed = harnessInspectionSchema.parse({
  status: "error",
  error: {
    code: "unavailable",
    message: "transient inspection failure",
    retryable: true,
  },
});

function hostWith(request: ChHostClient["request"]): ChHostClient {
  return { request } as unknown as ChHostClient;
}

it("reuses a ready Harness inspection", async () => {
  let requests = 0;
  const catalog = new ChHarnessCatalog(
    hostWith(async <T>() => {
      requests += 1;
      return ready as T;
    }),
  );

  assert.deepEqual(await catalog.inspect("antigravity"), ready);
  assert.deepEqual(await catalog.inspect("antigravity"), ready);
  assert.equal(requests, 1);
});

it("re-probes a failed Harness inspection", async () => {
  const responses: HarnessInspection[] = [failed, ready];
  let requests = 0;
  const catalog = new ChHarnessCatalog(
    hostWith(async <T>() => {
      requests += 1;
      return responses.shift() as T;
    }),
  );

  assert.deepEqual(await catalog.inspect("antigravity"), failed);
  assert.deepEqual(await catalog.inspect("antigravity"), ready);
  assert.equal(requests, 2);
});

it("shares an in-flight Harness inspection", async () => {
  let requests = 0;
  let resolve!: (value: HarnessInspection) => void;
  const pending = new Promise<HarnessInspection>((done) => {
    resolve = done;
  });
  const catalog = new ChHarnessCatalog(
    hostWith(async <T>() => {
      requests += 1;
      return (await pending) as T;
    }),
  );

  const first = catalog.inspect("antigravity", "/workspace");
  const second = catalog.inspect("antigravity", "/workspace");
  assert.equal(requests, 1);

  resolve(ready);
  assert.deepEqual(await Promise.all([first, second]), [ready, ready]);
});
