import { mkdtemp, readFile, rm } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import type { JsonObject, JsonValue } from "@codexhost/protocol-core";
import { mobileModelCatalog, mobileCatalogPage } from "../src/mobile-model-catalog.js";
import { MobileModelPreferences } from "../src/mobile-model-preferences.js";
import { MobileModelProtocol } from "../src/mobile-model-protocol.js";
import type { SharedThreadPeer } from "../src/shared-thread-peer.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function setup() {
  const directory = await mkdtemp("/tmp/ch-mobile-models-");
  directories.push(directory);
  const preferences = new MobileModelPreferences({ CODEXHOST_DATA_DIR: directory });
  const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
  const entries = await mobileModelCatalog(new Map([["pi", adapter]]), new Map());
  const owner = {
    request: vi.fn(async () => ({ result: { data: entries } })),
  } as unknown as SharedThreadPeer;
  const protocol = new MobileModelProtocol(owner, preferences);
  const native = vi.fn(async (method: string): Promise<JsonObject> => ({
    result:
      method === "model/list"
        ? { data: [{ id: "native", model: "native" }], nextCursor: null }
        : {
            config: { model: "native", sandbox_mode: "read-only" },
            origins: {},
            layers: [
              {
                name: { type: "user", file: `${directory}/config.toml` },
                version: "native-version",
                config: {},
              },
            ],
          },
  }));
  return { directory, preferences, entries, protocol, native };
}
it("projects real catalog labels and only each model's native thinking choices", async () => {
  const { entries } = await setup();
  expect(entries).toHaveLength(2);
  expect(entries[0]?.displayName).toBe("Fake Primary");
  expect(entries[1]?.supportedReasoningEfforts).toEqual([
    { reasoningEffort: "off", description: "Off" },
    { reasoningEffort: "low", description: "Low" },
  ]);
  expect(entries[1]?.serviceTiers).toEqual([]);
  const first = mobileCatalogPage(entries, { limit: 1 });
  if (typeof first.nextCursor !== "string") throw new Error("Expected next page");
  const cursor = first.nextCursor;
  expect(mobileCatalogPage(entries, { limit: 1, cursor }).data).toEqual([entries[1]]);
  expect(() => mobileCatalogPage([...entries, { id: "changed" }], { cursor })).toThrow("changed");
});
it("combines native and Harness catalogs without replacing native models", async () => {
  const { protocol, native, entries } = await setup();
  const reply = await protocol.handle(
    { id: 1, method: "model/list", params: { limit: 100 } },
    native,
  );
  expect((reply?.result as JsonObject).data).toEqual([
    { id: "native", model: "native" },
    ...entries,
  ]);
});
it("persists mobile defaults separately with consistent read origins and version conflicts", async () => {
  const { protocol, native, entries, preferences, directory } = await setup();
  const [primary, secondary] = entries;
  if (
    !primary ||
    !secondary ||
    typeof primary.model !== "string" ||
    typeof secondary.model !== "string"
  )
    throw new Error("Expected two catalog models");
  const write = (value: JsonValue, expectedVersion: string) =>
    protocol.handle(
      {
        id: 1,
        method: "config/batchWrite",
        params: { expectedVersion, edits: [{ keyPath: "model", value, mergeStrategy: "replace" }] },
      },
      native,
    );
  const saved = await write(secondary.model, "native-version");
  expect(JSON.parse(await readFile(preferences.file, "utf8")).model).toBe(secondary.model);
  await expect(readFile(`${directory}/config.toml`)).rejects.toThrow();
  const read = await protocol.handle(
    { id: 2, method: "config/read", params: { includeLayers: true } },
    native,
  );
  expect((read?.result as JsonObject).config).toEqual({
    model: secondary.model,
    sandbox_mode: "read-only",
    model_reasoning_effort: "off",
    service_tier: null,
  });
  expect(JSON.stringify((read?.result as JsonObject).origins)).toContain(preferences.file);
  await expect(write(primary.model, "native-version")).rejects.toThrow("changed");
  await write(primary.model, (saved?.result as JsonObject).version as string);
  expect(native.mock.calls.every(([method]) => method === "config/read")).toBe(true);
});
it("rejects mixed preference and security edits before any write", async () => {
  const { protocol, native, preferences } = await setup();
  await expect(
    protocol.handle(
      {
        id: 1,
        method: "config/batchWrite",
        params: {
          edits: [
            { keyPath: "model", value: "native", mergeStrategy: "replace" },
            { keyPath: "sandbox_mode", value: "danger-full-access", mergeStrategy: "replace" },
          ],
        },
      },
      native,
    ),
  ).rejects.toThrow("separately");
  expect(native).not.toHaveBeenCalled();
  expect(await preferences.read()).toEqual({});
});
