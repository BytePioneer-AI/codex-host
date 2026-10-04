import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extendModelCatalog, readBundledModelCatalog } from "../src/account/codex-model-catalog.js";
import {
  parseCodexConfigOverride,
  resolveCodexStartupCatalogConfig,
} from "../src/account/codex-config-overrides.js";
import { prepareCodexServiceTierCatalog } from "../src/account/codex-service-tier-startup.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-tier-catalog-"));
  directories.push(home);
  const model = {
    slug: "model-a",
    display_name: "模型 {A}",
    supported_reasoning_levels: [],
    context_window: 10000,
    service_tiers: [{ id: "priority", name: "Original Fast" }],
  };
  const executable = path.join(home, "synthetic-codex");
  await writeFile(
    executable,
    Buffer.concat([
      Buffer.from([0, 255, 254]),
      Buffer.from(JSON.stringify({ models: [model] })),
      Buffer.from([0]),
    ]),
  );
  return { home, executable, model };
}

describe("Codex service tier catalog", () => {
  it("extracts UTF-8 metadata without duplicating tiers or altering model capabilities", async () => {
    const f = await fixture();
    const catalog = JSON.parse(readBundledModelCatalog(f.executable).json);
    expect({ ...catalog.models[0], service_tiers: f.model.service_tiers }).toEqual(f.model);
    expect(catalog.models[0].service_tiers).toEqual([
      { id: "priority", name: "Original Fast" },
      { id: "ultrafast", name: "Ultrafast", description: "" },
    ]);
    expect(JSON.parse(extendModelCatalog(JSON.stringify(catalog)).json)).toEqual(catalog);
  });

  it("preloads both tiers through process arguments and leaves official config unchanged", async () => {
    const f = await fixture();
    const source = 'model_provider = "custom"\nmodel = "model-a"\n';
    await writeFile(path.join(f.home, "config.toml"), source);
    const input = { codexHome: f.home, stockCodexPath: f.executable, arguments: ["app-server"] };
    const prepared = await prepareCodexServiceTierCatalog(input);
    expect(prepared.available).toBe(true);
    expect(prepared.arguments.slice(0, 2)).toEqual(["app-server", "-c"]);
    const override = prepared.arguments[2];
    if (!override) throw new Error("Missing model catalog override");
    const file = JSON.parse(override.slice("model_catalog_json=".length)) as string;
    expect(
      JSON.parse(await readFile(file, "utf8")).models[0].service_tiers.map(
        (t: { id: string }) => t.id,
      ),
    ).toEqual(["priority", "ultrafast"]);
    expect(await readFile(path.join(f.home, "config.toml"), "utf8")).toBe(source);
    expect(await prepareCodexServiceTierCatalog(input)).toEqual(prepared);
    expect(await readdir(path.dirname(file))).toHaveLength(1);
  });

  it("preserves a user catalog and all of its metadata", async () => {
    const f = await fixture();
    const source = JSON.stringify({
      metadata: { version: 42 },
      models: [{ ...f.model, slug: "custom-only", context_window: 25000 }],
    });
    await writeFile(path.join(f.home, "custom.json"), source);
    await writeFile(
      path.join(f.home, "config.toml"),
      'model_provider = "custom"\nmodel_catalog_json = "custom.json"\n',
    );
    const prepared = await prepareCodexServiceTierCatalog({
      codexHome: f.home,
      stockCodexPath: "missing",
      arguments: ["app-server"],
    });
    const override = prepared.arguments[2];
    if (!override) throw new Error("Missing model catalog override");
    const file = JSON.parse(override.slice("model_catalog_json=".length)) as string;
    const result = JSON.parse(await readFile(file, "utf8"));
    expect(result.metadata).toEqual({ version: 42 });
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({ slug: "custom-only", context_window: 25000 });
    expect(await readFile(path.join(f.home, "custom.json"), "utf8")).toBe(source);
  });

  it("respects a selected profile and explicit catalog override", async () => {
    const f = await fixture();
    await writeFile(
      path.join(f.home, "config.toml"),
      '[profiles.relay]\nmodel_provider = "custom"\n',
    );
    const file = path.join(f.home, "override.json");
    await writeFile(file, JSON.stringify({ models: [f.model] }));
    const args = [
      "app-server",
      "--profile",
      "relay",
      "-c",
      `model_catalog_json=${JSON.stringify(file)}`,
    ];
    const prepared = await prepareCodexServiceTierCatalog({
      codexHome: f.home,
      stockCodexPath: f.executable,
      arguments: args,
    });
    expect(prepared.available).toBe(true);
    expect(prepared.arguments.slice(0, args.length)).toEqual(args);
  });

  it("tolerates the real Desktop `-c` overrides, including `@` keys", async () => {
    const f = await fixture();
    await writeFile(path.join(f.home, "config.toml"), 'model_provider = "custom"\n');
    const args = [
      "-c",
      "features.code_mode_host=true",
      "-c",
      "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true",
      "app-server",
      "--analytics-default-enabled",
    ];
    const prepared = await prepareCodexServiceTierCatalog({
      codexHome: f.home,
      stockCodexPath: f.executable,
      arguments: args,
    });
    expect(prepared.available).toBe(true);
    expect(prepared.arguments.slice(0, args.length)).toEqual(args);
    const override = prepared.arguments.at(-1);
    expect(prepared.arguments.at(-2)).toBe("-c");
    if (!override?.startsWith("model_catalog_json=")) throw new Error("Missing catalog override");
    const file = JSON.parse(override.slice("model_catalog_json=".length)) as string;
    const catalog = JSON.parse(await readFile(file, "utf8"));
    expect(catalog.models[0].service_tiers.map((t: { id: string }) => t.id)).toContain("ultrafast");
  });

  it("parses overrides with Codex CLI semantics and skips unrelated keys", () => {
    expect(parseCodexConfigOverride("a.b@c-d.e=true")).toEqual({
      path: ["a", "b@c-d", "e"],
      value: true,
    });
    expect(parseCodexConfigOverride("model=gpt-5=fast")).toEqual({
      path: ["model"],
      value: "gpt-5=fast",
    });
    expect(parseCodexConfigOverride('model_provider="relay"')).toEqual({
      path: ["model_provider"],
      value: "relay",
    });
    expect(parseCodexConfigOverride("=x")).toBeNull();
    expect(parseCodexConfigOverride("no-separator")).toBeNull();
    expect(parseCodexConfigOverride("a..b=1")).toBeNull();

    const config = { model_provider: "openai", profiles: { relay: { model: "m" } } };
    expect(
      resolveCodexStartupCatalogConfig(config, [
        "-c",
        "plugins.x@y.enabled=true",
        "-c",
        "broken",
        "-c",
        "model_provider=custom",
      ]),
    ).toEqual({ model_provider: "custom" });
    // A selected profile overrides root values, as in Codex.
    expect(
      resolveCodexStartupCatalogConfig(config, [
        "-c",
        "profiles.relay.model_provider=relay",
        "--profile",
        "relay",
      ]),
    ).toEqual({ model_provider: "relay" });
    expect(
      resolveCodexStartupCatalogConfig(config, [
        "-c",
        'profiles.relay={model_provider="inline"}',
        "-c",
        "profile=relay",
      ]),
    ).toEqual({ model_provider: "inline" });
  });

  it("keeps OpenAI and unreadable catalogs on the native startup path", async () => {
    const f = await fixture();
    for (const config of [
      "",
      'model_provider = "openai"',
      'model_provider = "custom"\nmodel_catalog_json = "missing"',
    ]) {
      await writeFile(path.join(f.home, "config.toml"), config);
      expect(
        await prepareCodexServiceTierCatalog({
          codexHome: f.home,
          stockCodexPath: f.executable,
          arguments: ["app-server"],
        }),
      ).toEqual({ arguments: ["app-server"], available: false });
    }
    expect(() => extendModelCatalog('{"models":[]}')).toThrow();
    expect(() => extendModelCatalog('{"models":[{"slug":"broken"}]}')).toThrow();
  });
});
