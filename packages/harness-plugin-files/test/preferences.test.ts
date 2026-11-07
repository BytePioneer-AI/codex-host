import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harnessPreferencePatchSchema } from "@codexhost/shared-contracts";
import { HarnessPreferencesStore, HarnessPreferenceConflict } from "../src/preferences.js";

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
  it("rejects the reserved native Codex identity in the external scope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-pref-scopes-"));
    const store = new HarnessPreferencesStore(directory);
    try {
      expect(
        harnessPreferencePatchSchema.safeParse({
          operations: [{ kind: "favorite", harnessId: "codex", modelId: "m", enabled: true }],
        }).success,
      ).toBe(false);
      expect(() =>
        harnessPreferencePatchSchema.parse({ scope: "web-codex:" + "a".repeat(64) }),
      ).toThrow();
      expect((await store.get()).values.favorites).toEqual({});
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
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

  it("announces atomic file replacement and refuses stale revisions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-pref-notifications-"));
    const writer = new HarnessPreferencesStore(directory);
    const observer = new HarnessPreferencesStore(directory);
    try {
      const changed = Promise.withResolvers<number>();
      await observer.subscribe((revision) => changed.resolve(revision));
      const result = await writer.patch(
        harnessPreferencePatchSchema.parse({
          operations: [{ kind: "idleRelease", value: { enabled: true, timeoutMinutes: 10 } }],
        }),
      );
      expect(await changed.promise).toBe(result.revision);
      await expect(
        writer.patch(
          harnessPreferencePatchSchema.parse({
            expectedRevision: 0,
            operations: [{ kind: "idleRelease", value: { enabled: false, timeoutMinutes: 30 } }],
          }),
        ),
      ).rejects.toBeInstanceOf(HarnessPreferenceConflict);
      expect((await observer.get()).values.idleRelease?.enabled).toBe(true);
    } finally {
      await writer.close();
      await observer.close();
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
