import { createHash } from "node:crypto";
import type * as FileSystemPromises from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extendModelCatalog, readBundledModelCatalog } from "../src/account/codex-model-catalog.js";
import {
  parseCodexConfigOverride,
  resolveCodexStartupCatalogConfig,
} from "../src/account/codex-config-overrides.js";
import { prepareCodexServiceTierCatalog } from "../src/account/codex-service-tier-startup.js";

const fsFault = vi.hoisted(() => ({
  writeFailures: 0,
  renameFailures: 0,
  publishOnRenameFailure: null as string | null,
  matches: (target: string): boolean => target.length > 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof FileSystemPromises>();
  return {
    ...original,
    async writeFile(
      target: Parameters<typeof original.writeFile>[0],
      data: Parameters<typeof original.writeFile>[1],
      options?: Parameters<typeof original.writeFile>[2],
    ): Promise<void> {
      if (fsFault.writeFailures > 0 && fsFault.matches(String(target))) {
        fsFault.writeFailures -= 1;
        const error = new Error("synthetic catalog write failure") as NodeJS.ErrnoException;
        error.code = "ENOSPC";
        throw error;
      }
      return original.writeFile(target, data, options);
    },
    async rename(
      oldPath: Parameters<typeof original.rename>[0],
      newPath: Parameters<typeof original.rename>[1],
    ): Promise<void> {
      if (fsFault.renameFailures > 0 && fsFault.matches(String(newPath))) {
        fsFault.renameFailures -= 1;
        const concurrent = fsFault.publishOnRenameFailure;
        // Simulates a concurrent process completing the exact expected publish first.
        if (concurrent !== null) await original.writeFile(String(newPath), concurrent, "utf8");
        const error = new Error("synthetic catalog rename failure") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return original.rename(oldPath, newPath);
    },
  };
});

const directories: string[] = [];
afterEach(async () => {
  fsFault.writeFailures = 0;
  fsFault.renameFailures = 0;
  fsFault.publishOnRenameFailure = null;
  fsFault.matches = (target: string): boolean => target.length > 0;
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

/** The published catalog name is the SHA-256 of its exact content. */
function catalogFile(home: string, contents: string): string {
  const hash = createHash("sha256").update(contents).digest("hex");
  return path.join(home, "codexhost", "service-tier-catalogs", `${hash}.json`);
}

async function catalogEntries(home: string): Promise<string[]> {
  return (await readdir(path.join(home, "codexhost", "service-tier-catalogs"))).sort();
}

function faultOnCatalog(target: string): boolean {
  return target.includes("service-tier-catalogs");
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
    // A selected legacy profile overrides root values, as in legacy Codex profiles.
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

  it("records the selected legacy profile layer only when it supplied the catalog", () => {
    const config = {
      model_provider: "custom",
      model_catalog_json: "root.json",
      profile: "a",
      profiles: {
        a: { model_catalog_json: "a.json" },
        b: { model_catalog_json: "b.json" },
        c: {},
      },
    };
    const rootOnly = { model_provider: "custom", model_catalog_json: "root.json" };
    // No selected profile: the root layer stays and no profile metadata appears.
    expect(resolveCodexStartupCatalogConfig({ ...config, profile: undefined }, [])).toEqual(
      rootOnly,
    );
    expect(resolveCodexStartupCatalogConfig(config, [])).toEqual({
      model_provider: "custom",
      model_catalog_json: "a.json",
      catalogProfileName: "a",
    });
    // A profile flag or a `-c profile=` override selects a different legacy profile.
    expect(resolveCodexStartupCatalogConfig(config, ["-p", "b"])).toEqual({
      model_provider: "custom",
      model_catalog_json: "b.json",
      catalogProfileName: "b",
    });
    // A selected profile without its own catalog keeps the root source.
    expect(resolveCodexStartupCatalogConfig(config, ["--profile", "c"])).toEqual(rootOnly);
    expect(
      resolveCodexStartupCatalogConfig(config, [
        "-c",
        'profiles.b.model_catalog_json="cli.json"',
        "-c",
        "profile=b",
      ]),
    ).toEqual({
      model_provider: "custom",
      model_catalog_json: "cli.json",
      catalogProfileName: "b",
    });
    expect(
      resolveCodexStartupCatalogConfig(config, [
        "-c",
        'profiles.b={model_catalog_json="inline.json"}',
        "-c",
        "profile=b",
      ]),
    ).toEqual({
      model_provider: "custom",
      model_catalog_json: "inline.json",
      catalogProfileName: "b",
    });
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

  it("repairs damaged catalogs atomically and reuses only complete matching content", async () => {
    const f = await fixture();
    await writeFile(path.join(f.home, "config.toml"), 'model_provider = "custom"\n');
    const input = { codexHome: f.home, stockCodexPath: f.executable, arguments: ["app-server"] };
    const expected = readBundledModelCatalog(f.executable).json;
    const file = catalogFile(f.home, expected);
    const prepared = await prepareCodexServiceTierCatalog(input);
    expect(prepared.available).toBe(true);
    expect(await readFile(file, "utf8")).toBe(expected);

    // A truncated file and a parseable-but-different file are both republished.
    for (const damaged of [expected.slice(0, 40), '{"models": []}']) {
      await writeFile(file, damaged);
      expect(await prepareCodexServiceTierCatalog(input)).toEqual(prepared);
      expect(await readFile(file, "utf8")).toBe(expected);
      expect(await catalogEntries(f.home)).toEqual([path.basename(file)]);
    }

    // Complete matching content is reused: no publish is attempted.
    fsFault.writeFailures = 1;
    fsFault.matches = faultOnCatalog;
    expect(await prepareCodexServiceTierCatalog(input)).toEqual(prepared);
    expect(await catalogEntries(f.home)).toEqual([path.basename(file)]);
  });

  it("publishes equivalent catalogs for concurrent preparations without partial files", async () => {
    const f = await fixture();
    await writeFile(path.join(f.home, "config.toml"), 'model_provider = "custom"\n');
    const input = { codexHome: f.home, stockCodexPath: f.executable, arguments: ["app-server"] };
    const expected = readBundledModelCatalog(f.executable).json;
    const file = catalogFile(f.home, expected);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => prepareCodexServiceTierCatalog(input)),
    );
    for (const result of results) {
      expect(result.available).toBe(true);
      expect(result).toEqual(results[0]);
    }
    expect(await readFile(file, "utf8")).toBe(expected);
    // No temporary directory or partially named file survives any publisher.
    expect(await catalogEntries(f.home)).toEqual([path.basename(file)]);
  });

  it("falls back to the original arguments and leaves no temporary files when publishing fails", async () => {
    const f = await fixture();
    await writeFile(path.join(f.home, "config.toml"), 'model_provider = "custom"\n');
    const input = { codexHome: f.home, stockCodexPath: f.executable, arguments: ["app-server"] };
    const expected = readBundledModelCatalog(f.executable).json;
    const file = catalogFile(f.home, expected);

    // A failed temporary write keeps the original arguments and removes its directory.
    fsFault.writeFailures = 1;
    fsFault.matches = faultOnCatalog;
    expect(await prepareCodexServiceTierCatalog(input)).toEqual({
      arguments: ["app-server"],
      available: false,
    });
    expect(await catalogEntries(f.home)).toEqual([]);

    // A failed rename never removes or replaces a target holding other content.
    await writeFile(file, "user-edited contents");
    fsFault.renameFailures = 1;
    expect(await prepareCodexServiceTierCatalog(input)).toEqual({
      arguments: ["app-server"],
      available: false,
    });
    expect(await readFile(file, "utf8")).toBe("user-edited contents");
    expect(await catalogEntries(f.home)).toEqual([path.basename(file)]);

    // When a concurrent publisher completed the exact expected content, reuse it.
    fsFault.renameFailures = 1;
    fsFault.publishOnRenameFailure = expected;
    const prepared = await prepareCodexServiceTierCatalog(input);
    expect(prepared.available).toBe(true);
    expect(await readFile(file, "utf8")).toBe(expected);
    expect(await catalogEntries(f.home)).toEqual([path.basename(file)]);
  });

  it("selects the generated catalog through the profile layer for a legacy profile with its own catalog", async () => {
    for (const selection of [
      ["--profile", "relay"],
      ["-p", "relay"],
      ["--profile=relay"],
      [],
    ] as const) {
      const f = await fixture();
      const source =
        'model_provider = "custom"\nprofile = "relay"\n[profiles.relay]\nmodel_catalog_json = "relay.json"\n';
      const relaySource = JSON.stringify({ models: [{ ...f.model, slug: "relay-only" }] });
      await writeFile(path.join(f.home, "config.toml"), source);
      await writeFile(path.join(f.home, "relay.json"), relaySource);
      const prepared = await prepareCodexServiceTierCatalog({
        codexHome: f.home,
        stockCodexPath: "missing",
        arguments: ["app-server", ...selection],
      });
      expect(prepared.available).toBe(true);
      const profileOverride = prepared.arguments.at(-1);
      expect(prepared.arguments.at(-2)).toBe("-c");
      if (!profileOverride?.startsWith("profiles.relay.model_catalog_json=")) {
        throw new Error("Missing profile catalog override");
      }
      const file = JSON.parse(
        profileOverride.slice("profiles.relay.model_catalog_json=".length),
      ) as string;
      expect(prepared.arguments.at(-4)).toBe("-c");
      expect(prepared.arguments.at(-3)).toBe(`model_catalog_json=${JSON.stringify(file)}`);
      expect(await readFile(file, "utf8")).toBe(extendModelCatalog(relaySource).json);
      // Re-applying the prepared arguments actually selects the generated source.
      const again = resolveCodexStartupCatalogConfig(parse(source), prepared.arguments);
      expect(again).toMatchObject({ model_catalog_json: file, catalogProfileName: "relay" });
      expect(again.model_provider).toBe("custom");
      // The user's own config and catalog stay untouched.
      expect(await readFile(path.join(f.home, "config.toml"), "utf8")).toBe(source);
      expect(await readFile(path.join(f.home, "relay.json"), "utf8")).toBe(relaySource);
    }
  });

  it.each(["a.b", "a=b", " relay "])(
    "conservatively keeps the original arguments for profile name %j",
    async (name) => {
      const f = await fixture();
      const quoted = JSON.stringify(name);
      const relaySource = JSON.stringify({ models: [f.model] });
      await writeFile(
        path.join(f.home, "config.toml"),
        `model_provider = "custom"\nprofile = ${quoted}\n[profiles.${quoted}]\nmodel_catalog_json = "relay.json"\n`,
      );
      await writeFile(path.join(f.home, "relay.json"), relaySource);
      expect(
        await prepareCodexServiceTierCatalog({
          codexHome: f.home,
          stockCodexPath: f.executable,
          arguments: ["app-server"],
        }),
      ).toEqual({ arguments: ["app-server"], available: false });
      expect(await readFile(path.join(f.home, "relay.json"), "utf8")).toBe(relaySource);
      expect(await readdir(f.home)).not.toContain("codexhost");
    },
  );

  it("appends only the root override when the selected profile has no catalog of its own", async () => {
    const f = await fixture();
    await writeFile(
      path.join(f.home, "config.toml"),
      'model_provider = "custom"\n[profiles.relay]\nmodel = "model-a"\n',
    );
    const input = {
      codexHome: f.home,
      stockCodexPath: f.executable,
      arguments: ["app-server", "--profile", "relay"],
    };
    const prepared = await prepareCodexServiceTierCatalog(input);
    expect(prepared.available).toBe(true);
    expect(prepared.arguments).toHaveLength(5);
    expect(prepared.arguments.slice(0, 3)).toEqual(input.arguments);
    expect(prepared.arguments[3]).toBe("-c");
    expect(prepared.arguments[4]?.startsWith("model_catalog_json=")).toBe(true);
    expect(
      resolveCodexStartupCatalogConfig(
        parse(await readFile(path.join(f.home, "config.toml"), "utf8")),
        prepared.arguments,
      ),
    ).not.toHaveProperty("catalogProfileName");
  });
});
