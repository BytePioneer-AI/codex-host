import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  encodeHarnessPluginRoute,
  harnessIdSchema,
  harnessInspectionSchema,
  harnessCommandCatalogSchema,
  harnessInstallationStateSchema,
  localizeHarnessPresentation,
  localizeHarnessText,
  threadUsageInspectionSchema,
  accountCreditsWindowLabel,
  type JsonObject,
} from "@codexhost/shared-contracts";
import {
  createFixture,
  requestId,
  startExternalThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

const id = harnessIdSchema.parse("previously-unknown-plugin");
const permissions = {
  defaultModeId: "custom",
  modes: [
    {
      id: "custom",
      label: "Custom rule",
      dangerous: true,
      localizations: { "zh-CN": { label: "插件规则", description: "插件自己的解释" } },
    },
  ],
};
const commands = {
  commands: [
    {
      id: "custom.command",
      invocation: "/unfamiliar",
      label: "Native command",
      argumentMode: "none",
      localizations: { "zh-CN": { label: "插件命令" } },
    },
  ],
};
const quota = {
  usedPercent: 24,
  periodType: "five_hour",
  productUsage: [
    {
      product: "Unrelated display wording",
      periodType: "seven_day",
      scope: { id: "model-1", label: "Model", localizations: { "zh-CN": { label: "模型" } } },
      usagePercent: 42,
    },
  ],
};
const installation = {
  currentVersion: "1.0.0",
  latestVersion: "2.0.0",
  updateAvailable: true,
  canUpdate: false,
  notice: { en: "Native update policy", "zh-CN": "插件更新策略" },
};

async function fixtureFor(credits: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "codexhost-plugin-presentation-"));
  const location = path.join(directory, id);
  await mkdir(location);
  await writeFile(
    path.join(directory, "enabled.json"),
    JSON.stringify({ version: 1, enabled: [id] }),
  );
  await writeFile(
    path.join(location, "manifest.json"),
    JSON.stringify({
      manifestVersion: 1,
      adapterApiVersion: 1,
      id,
      name: "Unknown plugin",
      version: "1",
      entry: "plugin.mjs",
    }),
  );
  await writeFile(
    path.join(location, "plugin.mjs"),
    `
    import { FakeHarnessAdapter } from ${JSON.stringify(pathToFileURL(path.resolve("packages/harness-adapter/dist/testing.js")).href)};
    export function createHarnessAdapter() {
      return Object.assign(new FakeHarnessAdapter(${JSON.stringify(id)}, undefined, true, true, { totalTokens: 10 }, ${JSON.stringify(permissions)}), {
        commandCatalog: ${JSON.stringify(commands)},
        installation: async () => (${JSON.stringify(installation)}),
        ${credits}
      });
    }
  `,
  );
  const fixture = createFixture({ pluginDirectory: directory, externalAdapters: new Map() });
  let request = 100;
  const rpc = async (method: string, params: JsonObject = {}) => {
    await fixture.ready;
    const id = request++;
    writeRequest(fixture.desktopInput, { id, method, params });
    const response = await fixture.collector.waitFor((message) => requestId(message, id));
    expect(response).not.toHaveProperty("error");
    return response.result;
  };
  return {
    fixture,
    rpc,
    close: async () => {
      try {
        await stopFixture(fixture);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

describe("installed plugin presentation through Host RPC", () => {
  it("loads an unknown plugin and transports its permissions, commands, notices and quota without client registration", async () => {
    const f = await fixtureFor(`credits: () => (${JSON.stringify(quota)}),`);
    try {
      const inspection = harnessInspectionSchema.parse(
        await f.rpc("codexhost/harness/inspect", { harnessId: id }),
      );
      expect(inspection.status).toBe("ready");
      if (inspection.status !== "ready") throw new Error("Plugin unavailable");
      const mode = inspection.permissionModes?.modes[0];
      if (!mode) throw new Error("Missing permission metadata");
      expect(localizeHarnessPresentation(mode, "zh-CN").label).toBe("插件规则");
      expect(mode.dangerous).toBe(true);
      const catalog = harnessCommandCatalogSchema.parse(
        await f.rpc("codexhost/harness/commands/inspect", { harnessId: id }),
      );
      const command = catalog.commands[0];
      if (!command) throw new Error("Missing command metadata");
      expect(localizeHarnessPresentation(command, "zh-CN").label).toBe("插件命令");
      const state = harnessInstallationStateSchema.parse(
        await f.rpc("codexhost/harness/installation", { harnessId: id, action: "check" }),
      );
      if (!state.notice) throw new Error("Missing installation notice");
      expect(localizeHarnessText(state.notice, "zh-CN")).toBe("插件更新策略");
      const threadId = await startExternalThread(
        f.fixture,
        encodeHarnessPluginRoute({ harnessId: id }),
      );
      const usage = threadUsageInspectionSchema.parse(
        await f.rpc("codexhost/thread/usage/inspect", { threadId }),
      );
      expect(usage.accountCreditsSupported).toBe(true);
      expect(usage.accountCredits).toEqual(quota);
      const product = usage.accountCredits?.productUsage?.[0];
      if (!product) throw new Error("Missing quota window");
      expect(accountCreditsWindowLabel(product, "zh-CN", (period) => period)).toBe(
        "模型 · seven_day",
      );
    } finally {
      await f.close();
    }
  });

  it("passes a cached prepaid balance only when no percentage quota exists", async () => {
    const balance = { amount: 12.34, currency: "CNY", label: "DeepSeek API" };
    const f = await fixtureFor(
      `balance: () => (${JSON.stringify(balance)}), refreshBalance: async () => null,`,
    );
    try {
      const threadId = await startExternalThread(
        f.fixture,
        encodeHarnessPluginRoute({ harnessId: id }),
      );
      const usage = threadUsageInspectionSchema.parse(
        await f.rpc("codexhost/thread/usage/inspect", { threadId }),
      );
      expect(usage.accountCreditsSupported).toBe(true);
      expect(usage.accountBalance).toEqual(balance);
      expect(usage).not.toHaveProperty("accountCredits");
    } finally {
      await f.close();
    }
    const both = await fixtureFor(
      `credits: () => (${JSON.stringify(quota)}), balance: () => (${JSON.stringify(balance)}),`,
    );
    try {
      const threadId = await startExternalThread(
        both.fixture,
        encodeHarnessPluginRoute({ harnessId: id }),
      );
      const usage = threadUsageInspectionSchema.parse(
        await both.rpc("codexhost/thread/usage/inspect", { threadId }),
      );
      expect(usage.accountCredits).toEqual(quota);
      expect(usage).not.toHaveProperty("accountBalance");
    } finally {
      await both.close();
    }
  });

  it.each([
    ["pending balance", "balance: () => null,"],
    ["bad balance", "balance: () => ({ amount: -1, currency: 'must-not-escape' }),"],
    ["throwing balance", "balance: () => { throw new Error('secret'); },"],
    [
      "throwing balance refresh",
      "balance: () => null, refreshBalance: async () => { throw new Error('secret'); },",
    ],
  ] as const)("isolates %s without losing Thread usage", async (_label, code) => {
    const f = await fixtureFor(code);
    try {
      const threadId = await startExternalThread(
        f.fixture,
        encodeHarnessPluginRoute({ harnessId: id }),
      );
      const response = await f.rpc("codexhost/thread/usage/inspect", { threadId });
      expect(response).toMatchObject({ accountCreditsSupported: true, usage: { totalTokens: 10 } });
      expect(response).not.toHaveProperty("accountBalance");
      expect(JSON.stringify(response)).not.toContain("secret");
      expect(JSON.stringify(response)).not.toContain("must-not-escape");
    } finally {
      await f.close();
    }
  });

  it.each([
    ["no capability", "", false],
    ["pending quota", "credits: () => null,", true],
    ["bad snapshot", "credits: () => ({ token: 'must-not-escape' }),", true],
    ["throwing reader", "credits: () => { throw new Error('secret'); },", true],
    [
      "throwing refresh",
      "credits: () => null, refreshCredits: async () => { throw new Error('secret'); },",
      true,
    ],
  ] as const)("isolates %s without losing Thread usage", async (_label, code, supported) => {
    const f = await fixtureFor(code);
    try {
      const threadId = await startExternalThread(
        f.fixture,
        encodeHarnessPluginRoute({ harnessId: id }),
      );
      const response = await f.rpc("codexhost/thread/usage/inspect", { threadId });
      expect(response).toMatchObject({
        accountCreditsSupported: supported,
        usage: { totalTokens: 10 },
      });
      expect(response).not.toHaveProperty("accountCredits");
      expect(JSON.stringify(response)).not.toContain("secret");
      expect(JSON.stringify(response)).not.toContain("must-not-escape");
    } finally {
      await f.close();
    }
  });
});
