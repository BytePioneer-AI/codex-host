import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harnessPreferencePatchSchema } from "@codexhost/shared-contracts";
import { HarnessPreferencesStore } from "../src/preferences.js";

describe("shared Harness preferences", () => {
  it("merges granular writes, migrates only missing values, and survives restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-preferences-"));
    const store = new HarnessPreferencesStore(directory);
    const patch = (input: unknown) => store.patch(harnessPreferencePatchSchema.parse(input));
    try {
      await Promise.all([
        patch({ operations: [{ kind: "favorite", harnessId: "pi", modelId: "a", enabled: true }] }),
        patch({ operations: [{ kind: "favorite", harnessId: "pi", modelId: "b", enabled: true }] }),
      ]);
      await patch({
        operations: [
          {
            kind: "newThread",
            lastHarness: "pi",
            harnessId: "pi",
            configuration: { model: { id: "new" } },
          },
          { kind: "idleRelease", value: { enabled: true, timeoutMinutes: 15 } },
        ],
      });
      const confirmed = await store.get();
      await patch({
        initializeOnly: true,
        operations: [
          { kind: "favorites", harnessId: "pi", modelIds: ["stale"] },
          {
            kind: "newThread",
            lastHarness: "claude-code",
            harnessId: "pi",
            configuration: { model: { id: "stale" } },
          },
          { kind: "idleRelease", value: { enabled: false, timeoutMinutes: 30 } },
        ],
      });
      expect(await store.get()).toEqual(confirmed);
      await store.close();
      const reopened = new HarnessPreferencesStore(directory);
      expect(await reopened.get()).toEqual(confirmed);
      expect(confirmed.values.favorites.pi).toEqual(["a", "b"]);
      expect(JSON.parse(await readFile(store.file, "utf8")).version).toBe(1);
      await reopened.close();
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("accepts official Codex preferences in the shared external scope but rejects retired scopes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-pref-scopes-"));
    const store = new HarnessPreferencesStore(directory);
    try {
      expect(
        harnessPreferencePatchSchema.safeParse({
          operations: [{ kind: "favorite", harnessId: "codex", modelId: "m", enabled: true }],
        }).success,
      ).toBe(true);
      expect(() =>
        harnessPreferencePatchSchema.parse({ scope: "web-codex:" + "a".repeat(64) }),
      ).toThrow();
      expect((await store.get()).values.favorites).toEqual({});
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("stores, replaces and clears delegation defaults independently of new Thread defaults", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-preferences-"));
    const store = new HarnessPreferencesStore(directory);
    const patch = (operations: unknown[], initializeOnly = false) =>
      store.patch(harnessPreferencePatchSchema.parse({ operations, initializeOnly }));
    const delegation = (harnessId: string, configuration: unknown) => ({
      kind: "delegation",
      harnessId,
      configuration,
    });
    try {
      expect(await patch([delegation("codex", null)])).toMatchObject({ revision: 0 });
      const normal = await patch([
        {
          kind: "newThread",
          lastHarness: "codex",
          harnessId: "codex",
          configuration: { model: { id: "normal" } },
        },
      ]);
      const codex = { model: { id: "delegated" }, thinkingOptionId: "high" };
      const external = { thinkingOptionId: "low" };
      const written = await patch([
        delegation("codex", codex),
        delegation("local-agent", external),
      ]);
      expect(written.revision).toBe(normal.revision + 1);
      expect(written.values.delegation?.byHarness).toEqual({ codex, "local-agent": external });

      const replacement = { model: { id: "replacement" } };
      const replaced = await patch([delegation("codex", replacement)]);
      expect(replaced.revision).toBe(written.revision + 1);
      expect(replaced.values.delegation?.byHarness).toEqual({
        codex: replacement,
        "local-agent": external,
      });
      expect(await patch([delegation("codex", replacement)])).toEqual(replaced);

      const initialized = await patch(
        [delegation("codex", codex), delegation("local-agent", null), delegation("pi", external)],
        true,
      );
      expect(initialized.values.delegation?.byHarness).toEqual({
        codex: replacement,
        "local-agent": external,
        pi: external,
      });
      const cleared = await patch([delegation("codex", null)]);
      expect(cleared.revision).toBe(initialized.revision + 1);
      expect(cleared.values.delegation?.byHarness).toEqual({
        "local-agent": external,
        pi: external,
      });
      expect(cleared.values.newThread).toEqual(normal.values.newThread);
      expect(await patch([delegation("codex", null)])).toEqual(cleared);
      const reopened = new HarnessPreferencesStore(directory);
      try {
        expect(await reopened.get()).toEqual(cleared);
      } finally {
        await reopened.close();
      }
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([undefined, {}, { model: { id: "m" }, permissionModeId: "default" }])(
    "rejects an incomplete or non-delegation configuration: %j",
    (configuration) => {
      expect(
        harnessPreferencePatchSchema.safeParse({
          operations: [{ kind: "delegation", harnessId: "codex", configuration }],
        }).success,
      ).toBe(false);
    },
  );

  it("reads external preferences beside retired scopes and keeps those scopes on write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-preferences-"));
    const store = new HarnessPreferencesStore(directory);
    const retired = { favorites: { codex: ["gpt"] }, newThread: { byHarness: {} } };
    const legacyScope = "web-codex:" + "a".repeat(64);
    try {
      await writeFile(
        join(directory, "harness-preferences-v1.json"),
        JSON.stringify({
          version: 1,
          revision: 7,
          scopes: { external: { favorites: { pi: ["a"] } }, [legacyScope]: retired },
        }),
      );
      expect(await store.get()).toMatchObject({
        revision: 7,
        values: { favorites: { pi: ["a"] } },
      });
      await store.patch(
        harnessPreferencePatchSchema.parse({
          operations: [{ kind: "favorite", harnessId: "pi", modelId: "b", enabled: true }],
        }),
      );
      const saved = JSON.parse(
        await readFile(join(directory, "harness-preferences-v1.json"), "utf8"),
      ) as { revision: number; scopes: Record<string, unknown> };
      expect(saved.revision).toBe(8);
      expect(saved.scopes[legacyScope]).toEqual(retired);
      expect(saved.scopes.external).toEqual({ favorites: { pi: ["a", "b"] } });
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects corrupt files without overwriting them and recovers after repair", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-pref-corrupt-"));
    const store = new HarnessPreferencesStore(directory);
    try {
      await writeFile(store.file, "broken");
      const input = harnessPreferencePatchSchema.parse({
        operations: [{ kind: "idleRelease", value: { enabled: true, timeoutMinutes: 10 } }],
      });
      await expect(store.patch(input)).rejects.toThrow("Could not read");
      expect(await readFile(store.file, "utf8")).toBe("broken");
      await writeFile(store.file, JSON.stringify({ version: 1, revision: 0, scopes: {} }));
      expect((await store.patch(input)).values.idleRelease?.enabled).toBe(true);
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
