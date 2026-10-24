import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareNativeVoiceCompatibility,
  type NativeVoiceCompatibility,
} from "../src/codex-runtime/native-voice-compatibility.js";

const homes: string[] = [];
function prepareRequest(mode: NativeVoiceCompatibility) {
  if (!mode.prepareRequest) throw new Error("Missing native compatibility policy");
  return mode.prepareRequest;
}
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true });
});
const officialAlias = `model_provider = "custom"
[model_providers.custom]
name = "OpenAI"
requires_openai_auth = true
supports_websockets = true
wire_api = "responses"
`;
async function prepare(config = officialAlias, args = ["app-server"]) {
  const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-voice-"));
  homes.push(home);
  const file = path.join(home, "config.toml");
  await writeFile(file, config);
  return {
    file,
    mode: await prepareNativeVoiceCompatibility({ home, arguments: args, environment: {} }),
  };
}

describe("native voice compatibility for official history aliases", () => {
  it("uses a real official runtime Provider while leaving the user's configuration intact", async () => {
    const { file, mode } = await prepare();
    expect(mode.arguments).toEqual(["app-server", "-c", 'model_provider="openai"']);
    expect(await readFile(file, "utf8")).toBe(officialAlias);
    expect(mode.prepareRequest).toBeTypeOf("function");
  });

  it("accepts the real Desktop plugin overrides without treating them as route changes", async () => {
    const args = [
      "-c",
      "features.code_mode_host=true",
      "app-server",
      "--analytics-default-enabled",
      "-c",
      "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=false",
    ];
    const { mode } = await prepare(officialAlias, args);
    expect(mode.arguments).toEqual([...args, "-c", 'model_provider="openai"']);
  });

  it.each([
    ["a third-party endpoint", officialAlias + 'base_url = "https://relay.example/v1"\n'],
    ["a local proxy", officialAlias + 'base_url = "http://127.0.0.1:15721/v1"\n'],
    ["provider authentication", officialAlias + 'env_key = "PROVIDER_KEY"\n'],
    ["a nonofficial name", officialAlias.replace('name = "OpenAI"', 'name = "Relay"')],
    [
      "a changed transport",
      officialAlias.replace("supports_websockets = true", "supports_websockets = false"),
    ],
    ["a selected profile", 'profile = "relay"\n' + officialAlias],
    ["a root endpoint override", 'openai_base_url = "https://relay.example/v1"\n' + officialAlias],
    ["an existing built-in override", officialAlias + '[model_providers.openai]\nname = "Relay"\n'],
    ["a future field", officialAlias + 'future_route = "unknown"\n'],
    ["an ordinary official configuration", 'model_provider = "openai"\n'],
  ])("keeps %s on the unchanged native path", async (_name, config) => {
    const { mode } = await prepare(config);
    expect(mode.arguments).toEqual(["app-server"]);
    expect(mode.prepareRequest).toBeUndefined();
  });

  it.each([
    ["app-server", "-c", 'model_provider="other"'],
    ["app-server", '--config=model_providers.custom.base_url="https://relay.example"'],
    ["-p", "work", "app-server"],
    ["app-server", '-cmodel_provider="other"'],
    ["app-server", '--config="model_provider"="other"'],
    ["-pwork", "app-server"],
    ["-C", "/project", "app-server"],
    ["app-server", "-c"],
  ])("does not override an explicit native route: %j", async (...args) => {
    const { mode } = await prepare(officialAlias, args);
    expect(mode.arguments).toEqual(args);
    expect(mode.prepareRequest).toBeUndefined();
  });

  it("keeps old custom history visible, preserves explicit unrelated filters and cursor fields", async () => {
    const { mode } = await prepare();
    const transform = prepareRequest(mode);
    expect(await transform("thread/list", { limit: 7, cursor: "native-page" })).toEqual({
      limit: 7,
      cursor: "native-page",
      modelProviders: ["openai", "custom"],
    });
    expect(await transform("thread/list", { modelProviders: ["openai"] })).toEqual({
      modelProviders: ["openai", "custom"],
    });
    expect(await transform("thread/list", { modelProviders: ["custom"] })).toEqual({
      modelProviders: ["custom", "openai"],
    });
    for (const filter of [null, [], ["other"], ["openai", "custom"]]) {
      const params = { modelProviders: filter };
      expect(await transform("thread/list", params)).toBe(params);
    }
    const resume = { threadId: "legacy-thread" };
    expect(await transform("thread/resume", resume)).toBe(resume);
  });

  it("requires a restart before new work can follow a changed third-party route, without blocking stop", async () => {
    const { file, mode } = await prepare();
    await writeFile(file, officialAlias + 'base_url = "https://relay.example/v1"\n');
    for (const method of [
      "thread/start",
      "thread/resume",
      "thread/fork",
      "turn/start",
      "thread/realtime/start",
      "review/start",
    ]) {
      await expect(prepareRequest(mode)(method, {})).rejects.toThrow(/restart CodexHost/);
    }
    const stop = { threadId: "existing-thread" };
    expect(await prepareRequest(mode)("thread/realtime/stop", stop)).toBe(stop);
  });

  it("allows ordinary preference changes and the official route without changing history files", async () => {
    const { file, mode } = await prepare();
    await writeFile(file, 'model = "gpt-6.1-sol"\n' + officialAlias);
    await expect(prepareRequest(mode)("turn/start", {})).resolves.toEqual({});
    await writeFile(file, 'model_provider = "openai"\n');
    await expect(prepareRequest(mode)("thread/realtime/start", {})).resolves.toEqual({});
  });

  it("does not pin a project-specific Provider to the official startup override", async () => {
    const { file, mode } = await prepare();
    const project = path.join(path.dirname(file), "project");
    const nested = path.join(project, "nested");
    await mkdir(path.join(project, ".codex"), { recursive: true });
    await mkdir(nested);
    await writeFile(path.join(project, ".codex", "config.toml"), 'model_provider = "other"\n');
    await expect(prepareRequest(mode)("thread/start", { cwd: nested })).rejects.toThrow(
      /Project Provider/,
    );
    const home = path.dirname(file);
    const resumed = await prepareNativeVoiceCompatibility({
      home,
      arguments: ["app-server"],
      environment: {},
      lookupThreadCwd: async () => nested,
    });
    await expect(
      prepareRequest(resumed)("thread/resume", { threadId: "project-thread" }),
    ).rejects.toThrow(/Project Provider/);
    await writeFile(path.join(project, ".codex", "config.toml"), 'model = "gpt-6.1-sol"\n');
    await expect(prepareRequest(mode)("thread/start", { cwd: nested })).resolves.toEqual({
      cwd: nested,
    });
  });

  it("leaves environment endpoint overrides on the native path", async () => {
    const { file } = await prepare();
    const mode = await prepareNativeVoiceCompatibility({
      home: path.dirname(file),
      arguments: ["app-server"],
      environment: { OPENAI_BASE_URL: "https://relay.example/v1" },
    });
    expect(mode.prepareRequest).toBeUndefined();
    expect(mode.arguments).toEqual(["app-server"]);
  });
});
