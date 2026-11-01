import { describe, expect, it } from "vitest";
import {
  readModelFavorites,
  writeModelFavorites,
  type ModelFavoritesStorage,
} from "../src/renderer-model-favorites.js";

describe("model favorites", () => {
  it("persists opaque refs separately for each Harness", () => {
    const data = new Map<string, string>();
    const storage: ModelFavoritesStorage = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
    };
    writeModelFavorites("pi", new Set(["model-a", "model-b"]), storage);
    writeModelFavorites("claude", new Set(["model-a"]), storage);
    expect([...readModelFavorites("pi", storage)]).toEqual(["model-a", "model-b"]);
    expect([...readModelFavorites("claude", storage)]).toEqual(["model-a"]);
    writeModelFavorites("pi", new Set(["model-b"]), storage);
    expect([...readModelFavorites("pi", storage)]).toEqual(["model-b"]);
    expect([...readModelFavorites("claude", storage)]).toEqual(["model-a"]);
  });

  it("ignores corrupt values and tolerates unavailable storage", () => {
    const storage: ModelFavoritesStorage = {
      getItem: () => "broken",
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readModelFavorites("pi", storage).size).toBe(0);
    expect(readModelFavorites("pi", null).size).toBe(0);
    expect(() => writeModelFavorites("pi", new Set(["a"]), storage)).not.toThrow();
    expect([
      ...readModelFavorites("pi", { ...storage, getItem: () => '["a",null,2,"","a"]' }),
    ]).toEqual(["a"]);
  });
});
