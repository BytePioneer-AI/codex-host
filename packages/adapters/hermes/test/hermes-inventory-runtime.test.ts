import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as childProcess from "node:child_process";
import { spawnSync } from "node:child_process";
import { readHermesModelInventory, catalogModelsFromInventory } from "../src/hermes-inventory.js";

const nativeCommand = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof childProcess>();
  const { promisify } = await import("node:util");
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: nativeCommand }) };
});
beforeEach(() => vi.resetAllMocks());

function runtime(stdout: string, exitCode = 0) {
  nativeCommand.mockResolvedValue({
    stdout: JSON.stringify([
      process.execPath,
      "-e",
      `process.stdout.write(${JSON.stringify(stdout)});process.exitCode=${exitCode}`,
    ]),
  });
}

const python = process.platform === "win32" ? "python" : "python3";
const pythonAvailable = spawnSync(python, ["--version"]).status === 0;

// Execute the actual probe with native API fixtures, not a second TS identity parser.
function fixtureRuntime(input: Record<string, unknown>) {
  nativeCommand.mockImplementation(async (_executable, args: string[]) => {
    const fixture = `
import sys, types, json
from types import SimpleNamespace
fixture = json.loads(${JSON.stringify(JSON.stringify(input))})
pkg = types.ModuleType('hermes_cli')
sys.modules['hermes_cli'] = pkg
for name in ('inventory', 'providers', 'models', 'main'):
    mod = types.ModuleType('hermes_cli.' + name)
    setattr(pkg, name, mod)
    sys.modules[mod.__name__] = mod
pkg.inventory.load_picker_context = lambda: SimpleNamespace(
    current_provider=fixture['provider'], current_model=fixture['model'],
    user_providers={}, custom_providers=[])
pkg.inventory.build_models_payload = lambda context, **kwargs: {'providers': fixture['rows']}
pkg.providers.custom_provider_slug = lambda name, key='': (
    (key or name).strip().lower().replace(' ', '-') if (key or name).strip().lower().startswith('custom:')
    else 'custom:' + (key or name).strip().lower().replace(' ', '-'))
def resolve(name, **kwargs):
    route = fixture.get('routes', {}).get(name)
    return SimpleNamespace(id=route) if route else None
pkg.providers.resolve_provider_full = resolve
def parse(raw, current):
    for route in sorted(fixture.get('routes', {}), key=len, reverse=True):
        if raw.startswith(route + ':'):
            return fixture['routes'][route], raw[len(route) + 1:]
    return current, raw
pkg.models.parse_model_input = parse
pkg.main._has_any_provider_configured = lambda: True
if fixture.get('legacy_api'):
    del pkg.providers.resolve_provider_full
    del pkg.providers.custom_provider_slug
    del pkg.models.parse_model_input
`;
    return { stdout: JSON.stringify([python, "-c", fixture + "\n" + args[9]]) };
  });
}

describe.skipIf(!pythonAvailable)("Hermes inventory native identity projection", () => {
  it.each([
    { name: "built-in", provider: "zai", slug: "zai", routes: { zai: "zai" } },
    {
      name: "legacy display name",
      provider: "custom:Sol Gateway",
      slug: "custom:sol-gateway",
      routes: { "custom:sol-gateway": "custom:sol-gateway" },
    },
    {
      name: "legacy bare row slug",
      provider: "custom:sol-gateway",
      slug: "sol-gateway",
      routes: { "sol-gateway": "custom:sol-gateway", "custom:sol-gateway": "custom:sol-gateway" },
    },
    {
      name: "keyed provider with a separate display name",
      provider: "custom:display-name",
      slug: "custom:stable-key",
      routes: {
        "custom:display-name": "custom:stable-key",
        "custom:stable-key": "custom:stable-key",
      },
    },
    {
      name: "user configured built-in route",
      provider: "openai",
      slug: "openai",
      routes: { openai: "openai" },
    },
    {
      name: "direct base_url",
      provider: "custom",
      slug: "custom",
      routes: { custom: "custom:must-not-select-first" },
    },
    {
      name: "local runtime",
      provider: "llamacpp",
      slug: "llamacpp",
      routes: { llamacpp: "llamacpp" },
    },
    {
      name: "qualified legacy model string",
      provider: "",
      slug: "zai",
      routes: { zai: "zai" },
      model: "zai:Model:Beta/Exact",
    },
  ])(
    "resolves $name without changing the model identifier",
    async ({ provider, slug, routes, model }) => {
      const expectedProvider =
        provider === "custom" ? "custom" : routes[slug as keyof typeof routes];
      fixtureRuntime({
        provider,
        model: model ?? "Model:Beta/Exact",
        routes,
        rows: [
          {
            slug,
            name: "Display Name",
            models: ["Model:Beta/Exact"],
            aliases: ["custom:custom:invalid", slug],
          },
        ],
      });
      const inventory = await readHermesModelInventory("/selected/hermes", 5000);
      expect(inventory.models[0]?.modelId).toBe(`${expectedProvider}:Model:Beta/Exact`);
      expect(inventory.currentModelId).toBe(inventory.models[0]?.modelId);
      expect(catalogModelsFromInventory(inventory).defaultModel).not.toBeNull();
    },
  );

  it("retains opaque routes on older native APIs without identity helpers", async () => {
    fixtureRuntime({
      provider: "custom:legacy",
      model: "Model",
      legacy_api: true,
      rows: [
        {
          slug: "custom:legacy",
          name: "Legacy",
          models: ["Model"],
          aliases: ["custom:custom:legacy"],
        },
      ],
    });
    const inventory = await readHermesModelInventory("/selected/hermes", 5000);
    expect(inventory.currentModelId).toBe("custom:legacy:Model");
    expect(inventory.models[0]?.modelId).toBe("custom:legacy:Model");
  });

  it("does not advertise native unavailable providers as selectable", async () => {
    fixtureRuntime({
      provider: "",
      model: "",
      rows: [
        { slug: "first", name: "First", models: ["Model"], authenticated: false },
        { slug: "second", name: "Second", models: ["Model"], available: false },
      ],
    });
    const inventory = await readHermesModelInventory("/selected/hermes", 5000);
    expect(catalogModelsFromInventory(inventory).models).toEqual([]);
  });

  it("keeps provider ownership for identical model names", async () => {
    fixtureRuntime({
      provider: "custom:second",
      model: "Model",
      routes: {},
      rows: [
        { slug: "custom:first", name: "First", models: ["Model"] },
        { slug: "custom:second", name: "Second", models: ["Model"] },
      ],
    });
    const inventory = await readHermesModelInventory("/selected/hermes", 5000);
    const catalog = catalogModelsFromInventory(inventory);
    expect(catalog.defaultModel).toEqual(catalog.models[1]?.ref);
    expect(catalog.models).toHaveLength(2);
  });
});

describe("Hermes installation-bound inventory runtime", () => {
  it("uses the native runtime command, retaining bootstrap and reading configuration evidence", async () => {
    runtime(
      'codexhost_inventory={"models":[],"currentModelId":null,"configured":false}\n1 loop, best of 1: 1 usec per loop\n',
    );
    expect(
      await readHermesModelInventory("/selected/hermes", 1000, {
        environment: { HERMES_HOME: "/selected/home" },
      }),
    ).toEqual({ models: [], currentModelId: null, configured: false });
    const call = nativeCommand.mock.calls[0];
    if (!call) throw new Error("Expected native runtime resolution");
    const [executable, args, options] = call;
    expect(executable).toBe("/selected/hermes");
    expect(args.slice(0, 10)).toEqual([
      "--print-runtime-command",
      "--module",
      "timeit",
      "--",
      "-n",
      "1",
      "-r",
      "1",
      "-s",
      expect.stringContaining("_has_any_provider_configured"),
    ]);
    expect(options.env.HERMES_HOME).toBe("/selected/home");
    expect(options.timeout).toBe(1000);
  });

  it("does not silently fall back when an advertised runtime fails", async () => {
    runtime("", 1);
    await expect(readHermesModelInventory("/selected/hermes")).rejects.toThrow(
      "probe exited with 1",
    );
  });

  it("rejects malformed inventory rather than guessing configuration from missing models", async () => {
    runtime("codexhost_inventory=invalid\n");
    await expect(readHermesModelInventory("/selected/hermes")).rejects.toThrow("malformed output");
  });

  it("falls back to legacy discovery when the native runtime interface is unsupported", async () => {
    nativeCommand.mockRejectedValue(new Error("unknown option"));
    await expect(
      readHermesModelInventory("/nonexistent-codexhost-hermes/bin/hermes"),
    ).rejects.toThrow("inventory interpreter not found");
  });
});
