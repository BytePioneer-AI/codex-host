import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { installRendererRpcSteeringDirect } from "../src/renderer-rpc-steering.js";

function fixture(options: { foreign?: boolean; ambiguous?: boolean } = {}) {
  const objects = new Map<string, object>();
  const ids = new WeakMap<object, string>();
  const closures = new WeakSet<object>();
  const scopes = new WeakMap<object, object>();
  let sequence = 0;
  const remote = (value: unknown): Record<string, unknown> => {
    if ((typeof value !== "object" && typeof value !== "function") || value === null)
      return { type: typeof value, value };
    let objectId = ids.get(value);
    if (!objectId) {
      objectId = String(++sequence);
      ids.set(value, objectId);
      objects.set(objectId, value);
    }
    return {
      objectId,
      type: typeof value,
      description: closures.has(value)
        ? "Closure (native fixture)"
        : typeof value === "function"
          ? String(value)
          : "Object",
    };
  };
  const store = { familyBindings: new Map() };
  const scope = { node: store, chain: [], scope: {}, get() {}, set() {}, watch() {} };
  const root = {
    __reactContainer$test: { memoizedState: { memoizedState: { current: scope }, next: null } },
  };
  const document = { getElementById: () => root };
  const makeController = (foreign = false) => {
    const controller = {
      forHost() {},
      async collectAppStateSnapshot() {
        return "collectSnapshot";
      },
      getReviewPaneSnapshotMetrics() {},
      dispose() {},
    };
    const bindings = {
      controller,
      scope: foreign ? { ...scope, node: { familyBindings: new Map() } } : scope,
    };
    closures.add(bindings);
    scopes.set(controller.collectAppStateSnapshot, [bindings]);
    return controller;
  };
  const controller = makeController(options.foreign);
  const snapshots = [controller.collectAppStateSnapshot];
  if (options.ambiguous) snapshots.push(makeController().collectAppStateSnapshot);
  const install = vi.fn(() => true);
  const window: Record<string, unknown> = {
    __codexhostHostRoutingV1: { forHost: () => ({ manager: { kind: "main-process-rpc" } }) },
    __codexhostInstallRpcSteeringV1: install,
  };
  const globals = { window, document };
  const command = vi.fn(
    async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      if (method === "Runtime.evaluate") return { result: remote({}) };
      if (method === "Runtime.queryObjects") return { objects: remote(snapshots) };
      if (method === "Runtime.getProperties") {
        const object = objects.get(String(params.objectId));
        if (!object) throw new Error("Unknown remote object");
        return {
          result: Object.entries(Object.getOwnPropertyDescriptors(object)).flatMap(
            ([name, descriptor]) =>
              "value" in descriptor ? [{ name, value: remote(descriptor.value) }] : [],
          ),
          ...(scopes.has(object)
            ? { internalProperties: [{ name: "[[Scopes]]", value: remote(scopes.get(object)) }] }
            : {}),
        };
      }
      if (method === "Runtime.callFunctionOn") {
        const fn = vm.runInNewContext(`(${String(params.functionDeclaration)})`, globals) as (
          ...args: unknown[]
        ) => unknown;
        const args = ((params.arguments ?? []) as { objectId?: string }[]).map((arg) =>
          objects.get(String(arg.objectId)),
        );
        const result = Reflect.apply(fn, objects.get(String(params.objectId)), args);
        return { result: params.returnByValue ? { value: result } : remote(result) };
      }
      if (method === "Runtime.releaseObjectGroup") return {};
      throw new Error(`Unexpected command ${method}`);
    },
  );
  return {
    controller,
    install,
    command,
    window,
    client: {
      command,
      async evaluate<T>(expression: string): Promise<T> {
        return vm.runInNewContext(expression, globals) as T;
      },
    },
  };
}

describe("native RPC steering owner discovery", () => {
  it("installs only on the Controller paired with this committed app scope and releases handles", async () => {
    const f = fixture();
    await expect(installRendererRpcSteeringDirect(f.client)).resolves.toBe(true);
    expect(f.install).toHaveBeenCalledExactlyOnceWith(f.controller);
    expect(f.command).toHaveBeenLastCalledWith("Runtime.releaseObjectGroup", {
      objectGroup: expect.any(String),
    });
  });
  it.each([{ foreign: true }, { ambiguous: true }])(
    "fails closed for an unverified owner: %j",
    async (options) => {
      const f = fixture(options);
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await expect(installRendererRpcSteeringDirect(f.client)).resolves.toBe(false);
      expect(logged).toHaveBeenCalledOnce();
      expect(f.install).not.toHaveBeenCalled();
      expect(f.command).toHaveBeenLastCalledWith("Runtime.releaseObjectGroup", {
        objectGroup: expect.any(String),
      });
      logged.mockRestore();
    },
  );
  it("backs off heap discovery after a failure instead of repeating it every monitor tick", async () => {
    const f = fixture({ ambiguous: true });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let now = 1_000;
    const discoveries = () =>
      f.command.mock.calls.filter(([method]) => method === "Runtime.queryObjects").length;
    await installRendererRpcSteeringDirect(f.client, () => now);
    expect(discoveries()).toBe(1);
    now += 4_999;
    await installRendererRpcSteeringDirect(f.client, () => now);
    expect(discoveries()).toBe(1);
    now += 1;
    await installRendererRpcSteeringDirect(f.client, () => now);
    expect(discoveries()).toBe(2);
    now += 9_999;
    await installRendererRpcSteeringDirect(f.client, () => now);
    expect(discoveries()).toBe(2);
    logged.mockRestore();
  });
  it("keeps a wrapper that still owns forHost and reinstalls one a later install displaced", async () => {
    const f = fixture();
    const release = vi.fn(() => delete f.window.__codexhostRpcSteeringV1);
    f.window.__codexhostRpcSteeringV1 = {
      controller: f.controller,
      forHost: f.controller.forHost,
      release,
    };
    await expect(installRendererRpcSteeringDirect(f.client)).resolves.toBe(false);
    expect(release).not.toHaveBeenCalled();
    expect(f.install).not.toHaveBeenCalled();

    f.controller.forHost = () => undefined;
    await expect(installRendererRpcSteeringDirect(f.client)).resolves.toBe(true);
    expect(release).toHaveBeenCalledOnce();
    expect(f.window.__codexhostRpcSteeringV1).toBeUndefined();
    expect(f.install).toHaveBeenCalledExactlyOnceWith(f.controller);
  });
  it("treats a page that cannot be evaluated as not installed", async () => {
    const f = fixture();
    const client = { command: f.command, evaluate: () => Promise.reject(new Error("closed")) };
    await expect(installRendererRpcSteeringDirect(client)).resolves.toBe(false);
  });
});
