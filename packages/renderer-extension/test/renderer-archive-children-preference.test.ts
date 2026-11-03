import { describe, expect, it } from "vitest";

import {
  ARCHIVE_CHILDREN_STORAGE_KEY,
  readArchiveChildrenMode,
  setArchiveChildrenMode,
  subscribeArchiveChildrenMode,
} from "../src/renderer-archive-children-preference.js";

function ownerWindow(): Window {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  return Object.assign(new EventTarget(), { localStorage: storage }) as unknown as Window;
}

describe("archive children preference", () => {
  it("defaults to asking and ignores unknown stored values", () => {
    const owner = ownerWindow();
    expect(readArchiveChildrenMode(owner)).toBe("ask");
    owner.localStorage.setItem(ARCHIVE_CHILDREN_STORAGE_KEY, "sometimes");
    expect(readArchiveChildrenMode(owner)).toBe("ask");
  });

  it("stores a remembered choice, clears it for ask, and notifies listeners", () => {
    const owner = ownerWindow();
    let changes = 0;
    const dispose = subscribeArchiveChildrenMode(owner, () => (changes += 1));

    setArchiveChildrenMode(owner, "always");
    expect(readArchiveChildrenMode(owner)).toBe("always");
    setArchiveChildrenMode(owner, "never");
    expect(readArchiveChildrenMode(owner)).toBe("never");
    setArchiveChildrenMode(owner, "ask");
    expect(owner.localStorage.getItem(ARCHIVE_CHILDREN_STORAGE_KEY)).toBeNull();
    expect(changes).toBe(3);

    const storage = new Event("storage") as Event & { key: string | null };
    Object.defineProperty(storage, "key", { value: ARCHIVE_CHILDREN_STORAGE_KEY });
    owner.dispatchEvent(storage);
    expect(changes).toBe(4);

    dispose();
    setArchiveChildrenMode(owner, "always");
    expect(changes).toBe(4);
  });

  it("falls back to asking when storage throws", () => {
    const owner = Object.assign(new EventTarget(), {
      localStorage: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
      },
    }) as unknown as Window;
    expect(readArchiveChildrenMode(owner)).toBe("ask");
    expect(() => setArchiveChildrenMode(owner, "always")).not.toThrow();
  });
});
