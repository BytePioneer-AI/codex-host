import { PassThrough } from "node:stream";

import { expect, it, vi } from "vitest";

import type { AppServerHostOptions } from "../src/app-server-host.js";
import type * as RemoteAppServer from "../src/remote-app-server.js";
import type {
  DelegationControlApi,
  DelegationControlRegistration,
  DelegationThreadListResult,
} from "../src/delegation-types.js";

const state = vi.hoisted(() => ({
  api: undefined as DelegationControlApi | undefined,
  hosts: [] as AppServerHostOptions[],
  lists: [] as ReturnType<typeof vi.fn>[],
  result: undefined as DelegationThreadListResult | undefined,
  store: { initialize: vi.fn(async () => {}), close: vi.fn(async () => {}) },
  scope: {},
}));

vi.mock("../src/app-server-host.js", () => ({
  AppServerHost: class {
    constructor(options: AppServerHostOptions) {
      state.hosts.push(options);
      const list = vi.fn(async () => ({
        threads: [{ threadId: "native", harnessId: "codex", deepLink: "", status: "completed" }],
        nextCursor: "native-cursor",
      }));
      state.lists.push(list);
      options.onDelegationApi?.({ list } as unknown as DelegationControlRegistration);
    }
    async run() {
      const api = state.api;
      if (!api) throw new Error("Missing delegation Registry");
      state.result = await api.list({ limit: 2, sort: "created-desc" });
      return 0;
    }
  },
  officialEnvironment: (environment: NodeJS.ProcessEnv) => environment,
}));
vi.mock("../src/native-account-host.js", () => ({
  prepareLocalCodex: async () => ({
    officialRuntimeScope: state.scope,
    accountControl: {},
    close: async () => {},
  }),
}));
vi.mock("../src/delegation-control-server.js", () => ({
  startDelegationControlServer: async ({ api }: { api: DelegationControlApi }) => {
    state.api = api;
    return { endpoint: "http://127.0.0.1:1", close: async () => {} };
  },
}));
vi.mock("../src/delegation-skill.js", () => ({ installDelegationSkills: async () => [] }));
vi.mock("../src/installed-harness-plugins.js", () => ({
  installedHarnessPluginOptions: () => ({}),
}));
vi.mock("../src/external-thread-repository.js", () => ({
  createProductionExternalThreadStore: () => state.store,
}));
vi.mock("../src/model-prices.js", () => ({
  ModelPriceCatalog: class {
    async start() {}
  },
  defaultModelPriceDirectory: () => "/synthetic/prices",
}));
vi.mock("../src/usage-statistics.js", () => ({ UsageStatistics: vi.fn() }));
vi.mock("../src/remote-control-app-server.js", () => ({
  createRemoteControlAppServerPlan: () => ({
    environment: {},
    officialArguments: [],
    pipePath: "\\\\.\\pipe\\synthetic-catalog-test",
  }),
  publishRemoteControlAppServerDescriptor: async () => {},
}));
vi.mock("../src/remote-app-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteAppServer>()),
  createRemoteAppServerWebSocketListener: (options: {
    createSession(streams: {
      input: PassThrough;
      output: PassThrough;
      diagnosticOutput: PassThrough;
    }): unknown;
  }) => ({
    async listen() {
      options.createSession({
        input: new PassThrough(),
        output: new PassThrough(),
        diagnosticOutput: new PassThrough(),
      });
    },
    async close() {},
  }),
}));

it("registers the primary Remote Control Host as the catalog for its attached sessions", async () => {
  // Exercise the production composition without installing skills or starting a native process.
  const { runHostRuntime } = await import("../src/run-host-runtime.js");
  expect(
    await runHostRuntime({
      arguments: [],
      environment: { CODEXHOST_STOCK_CODEX_PATH: "/synthetic/codex" },
    }),
  ).toBe(0);
  expect(state.hosts).toHaveLength(2);
  for (const host of state.hosts) {
    expect(host.mappingStore).toBe(state.store);
    expect(host.officialRuntimeScope).toBe(state.scope);
  }
  expect(state.lists[0]).toHaveBeenCalledExactlyOnceWith({ limit: 2, sort: "created-desc" });
  expect(state.lists[1]).not.toHaveBeenCalled();
  expect(state.result?.threads.map((entry) => entry.threadId)).toEqual(["native"]);
  expect(state.result?.nextCursor).toBe("native-cursor");
});
