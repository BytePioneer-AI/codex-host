import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import type * as filesystemPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { harnessModelCatalogSchema } from "@codexhost/shared-contracts";
import {
  ensurePiFastExtension,
  PI_FAST_ACK,
  PI_FAST_COMMAND,
  PI_FAST_EXTENSION,
  piFastModelKeys,
  withPiFast,
} from "../src/pi-fast-mode.js";
import { decodePiModelRef, encodePiModelRef } from "../src/pi-model-catalog.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof filesystemPromises>();
  return { ...filesystem, rename: vi.fn(filesystem.rename) };
});

const homes: string[] = [];
afterEach(async () => {
  vi.mocked(rename).mockReset();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
function codexCredential() {
  const claims = Buffer.from(
    JSON.stringify({ iss: "https://auth.openai.com", client_id: "app_EMoamEEZ73f0CkXaXp7hrann" }),
  ).toString("base64url");
  return {
    type: "oauth",
    access: `header.${claims}.signature`,
    refresh: "fixture",
    expires: 9999999999999,
  };
}

describe("Pi Host Fast", () => {
  it("requires Codex OAuth, the Codex API and priority metadata, including alias and imported Providers", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "pi-fast-"));
    homes.push(home);
    await mkdir(path.join(home, ".pi/agent"), { recursive: true });
    await mkdir(path.join(home, ".codex"));
    await writeFile(
      path.join(home, ".pi/agent/auth.json"),
      JSON.stringify({
        c: codexCredential(),
        "codex-alice": { ...codexCredential(), codexhostImportId: "owned" },
        "openai-codex": { type: "api_key", key: "fixture" },
        other: { type: "oauth", access: "invalid" },
      }),
    );
    await writeFile(
      path.join(home, ".codex/models_cache.json"),
      JSON.stringify({
        models: [{ slug: "supported", service_tiers: [{ id: "priority" }] }, { slug: "ordinary" }],
      }),
    );
    const model = {
      provider: "c",
      id: "supported",
      reasoning: true,
      api: "openai-codex-responses",
    };
    const keys = await piFastModelKeys(
      [
        model,
        { ...model, provider: "codex-alice" },
        { ...model, provider: "openai-codex" },
        { ...model, provider: "other" },
        { ...model, id: "ordinary" },
        { ...model, api: "openai-responses" },
      ],
      { HOME: home },
    );
    expect([...keys]).toEqual([
      encodePiModelRef(model).id,
      encodePiModelRef({ ...model, provider: "codex-alice" }).id,
    ]);
    const catalog = withPiFast(
      harnessModelCatalogSchema.parse({
        models: [{ ref: encodePiModelRef(model), label: "c / supported" }],
        thinkingOptions: [],
      }),
      keys,
    );
    const fast = catalog.models[0]?.fastModel;
    if (!fast) throw new Error("Missing Fast choice");
    expect(decodePiModelRef(fast)).toEqual({ provider: "c", id: "supported", fast: true });
    await rm(path.join(home, ".codex/models_cache.json"));
    expect(await piFastModelKeys([model], { HOME: home })).toEqual(new Set());
  });

  it("writes the bundled extension only under Host storage and handles concurrent starts", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "pi-fast-resource-"));
    homes.push(home);
    const [file, second] = await Promise.all([
      ensurePiFastExtension({ HOME: home }),
      ensurePiFastExtension({ HOME: home }),
    ]);
    if (!file) throw new Error("Missing bundled resource");
    expect(file).toBe(second);
    expect(file).toContain(path.join(".codexhost", "extensions", "pi-codex-fast"));
    expect(await readFile(file, "utf8")).toBe(PI_FAST_EXTENSION);
    await expect(readFile(path.join(home, ".pi/agent/settings.json"))).rejects.toThrow();
    const dataDirectory = path.join(home, "host-data");
    expect(
      await ensurePiFastExtension({ HOME: home, CODEXHOST_DATA_DIR: dataDirectory }),
    ).toContain(path.join(dataDirectory, "extensions", "pi-codex-fast"));
  });

  it("accepts a concurrent publisher after Windows refuses the replacement and removes its temporary file", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "pi-fast-resource-race-"));
    homes.push(home);
    const failure = Object.assign(new Error("Windows refused replacement"), { code: "EPERM" });
    vi.mocked(rename).mockImplementationOnce(async (_temporary, file) => {
      await writeFile(file, PI_FAST_EXTENSION);
      throw failure;
    });

    const file = await ensurePiFastExtension({ HOME: home });
    expect(await readFile(file, "utf8")).toBe(PI_FAST_EXTENSION);
    expect(await readdir(path.dirname(file))).toEqual([path.basename(file)]);
    vi.mocked(rename).mockClear();
    expect(await ensurePiFastExtension({ HOME: home })).toBe(file);
    expect(rename).not.toHaveBeenCalled();
  });

  it.each(["missing", "invalid"])(
    "preserves rename errors when the published resource is %s and removes its temporary file",
    async (state) => {
      const home = await mkdtemp(path.join(os.tmpdir(), "pi-fast-resource-failure-"));
      homes.push(home);
      const failure = Object.assign(new Error("Windows refused replacement"), { code: "EPERM" });
      vi.mocked(rename).mockImplementationOnce(async (_temporary, file) => {
        if (state === "invalid") await writeFile(file, "not the bundled extension");
        throw failure;
      });

      await expect(ensurePiFastExtension({ HOME: home })).rejects.toBe(failure);
      const files = await readdir(path.join(home, ".codexhost", "extensions", "pi-codex-fast"));
      expect(files).toHaveLength(state === "invalid" ? 1 : 0);
      expect(files.every((file) => file.endsWith(".mjs"))).toBe(true);
    },
  );

  it("is inert until enabled and decorates the existing Provider without replacing its authentication or reasoning", async () => {
    type Model = { provider: string; id: string; api: string };
    type Stream = (model: Model, context: unknown, options?: Record<string, unknown>) => unknown;
    type Provider = {
      id: string;
      name: string;
      auth: unknown;
      stream: Stream;
      streamSimple: Stream;
    };
    const stream = vi.fn<Stream>();
    // Like Pi's streamSimple -> buildBaseOptions path, serialize only supported
    // options: serviceTier is dropped, but the native onPayload hook is retained.
    const streamSimple = vi.fn<Stream>(async (model, _context, options) => {
      const payload = { model: model.id };
      const onPayload = options?.onPayload;
      const replacement =
        typeof onPayload === "function" ? await onPayload(payload, model) : undefined;
      return JSON.stringify(replacement === undefined ? payload : replacement);
    });
    const auth = { oauth: { fixture: true } };
    let provider: Provider = { id: "c", name: "c", auth, stream, streamSimple };
    const register = vi.fn((value: Provider) => {
      provider = value;
    });
    const notify = vi.fn();
    const model: Model = { provider: "c", id: "supported", api: "openai-codex-responses" };
    const ctx = { model, modelRegistry: { getProvider: () => provider }, ui: { notify } };
    type Handler = (args: string, context: typeof ctx) => Promise<void>;
    const commands = new Map<string, { handler: Handler }>();
    let start: ((event: unknown, context: typeof ctx) => void) | undefined;
    let modelSelect: typeof start;
    const pi = {
      on: (name: string, handler: NonNullable<typeof start>) => {
        if (name === "session_start") start = handler;
        else if (name === "model_select") modelSelect = handler;
      },
      registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command),
      registerProvider: register,
    };
    new Function(PI_FAST_EXTENSION.replace("export default function", "return function"))()(pi);
    if (!start) throw new Error("Missing session handler");
    start({}, ctx);
    const command = commands.get(PI_FAST_COMMAND);
    if (!command) throw new Error("Missing Fast command");
    expect(register).not.toHaveBeenCalled();
    await command.handler("on nonce", ctx);
    expect(notify).toHaveBeenCalledWith(`${PI_FAST_ACK}nonce:on`, "info");
    expect(provider.auth).toBe(auth);
    const options = { reasoning: "high", apiKey: "fixture", onPayload: vi.fn() };
    expect(JSON.parse((await provider.streamSimple(model, {}, options)) as string)).toEqual({
      model: model.id,
      service_tier: "priority",
    });
    expect(options.onPayload).toHaveBeenCalledWith(
      { model: model.id, service_tier: "priority" },
      model,
    );
    expect(streamSimple.mock.lastCall?.[2]).toMatchObject({ reasoning: "high", apiKey: "fixture" });
    provider.stream(model, {}, options);
    expect(stream.mock.lastCall?.[2]).toMatchObject({
      serviceTier: "priority",
      onPayload: expect.any(Function),
    });
    expect(JSON.parse((await provider.streamSimple(model, {})) as string)).toEqual({
      model: model.id,
      service_tier: "priority",
    });
    // Preserve mutations, async replacements and failures from existing hooks.
    const mutated = { model: model.id, service_tier: "priority", extra: "kept" };
    options.onPayload.mockImplementationOnce((payload) => {
      payload.extra = "kept";
    });
    expect(JSON.parse((await provider.streamSimple(model, {}, options)) as string)).toEqual(
      mutated,
    );
    const replacement = Object.freeze({
      model: model.id,
      service_tier: "default",
      extra: "replacement",
    });
    options.onPayload.mockResolvedValueOnce(replacement);
    expect(JSON.parse((await provider.streamSimple(model, {}, options)) as string)).toEqual({
      ...replacement,
      service_tier: "priority",
    });
    expect(replacement.service_tier).toBe("default");
    options.onPayload.mockRejectedValueOnce(new Error("Hook rejected request"));
    await expect(provider.streamSimple(model, {}, options)).rejects.toThrow(
      "Hook rejected request",
    );
    for (const other of [
      { ...model, provider: "other" },
      { ...model, api: "other" },
    ]) {
      expect(JSON.parse((await provider.streamSimple(other, {}, options)) as string)).toEqual({
        model: model.id,
      });
      expect(streamSimple.mock.lastCall?.[2]).toBe(options);
    }
    await provider.streamSimple({ ...model, id: "ordinary" }, {}, options);
    expect(streamSimple.mock.lastCall?.[2]).toBe(options);
    if (!modelSelect) throw new Error("Missing Model switch handler");
    modelSelect({}, { ...ctx, model: { ...model, id: "ordinary" } });
    expect(JSON.parse((await provider.streamSimple(model, {}, options)) as string)).toEqual({
      model: model.id,
    });
    expect(streamSimple.mock.lastCall?.[2]).toBe(options);
    await command.handler("on nonce", ctx);
    await command.handler("off nonce", ctx);
    expect(JSON.parse((await provider.streamSimple(model, {}, options)) as string)).toEqual({
      model: model.id,
    });
    expect(register).toHaveBeenCalledOnce();
    expect(streamSimple.mock.lastCall?.[2]).toBe(options);
    await expect(
      command.handler("on nonce", { ...ctx, model: { ...model, api: "other" } }),
    ).rejects.toThrow("Codex API");
  });
});
