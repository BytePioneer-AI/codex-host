import { describe, expect, it } from "vitest";

import { compositeModelRefIds } from "../src/composite-model-ref.js";

describe("compositeModelRefIds", () => {
  it("uses provider/model and keeps colliding pairs distinguishable", () => {
    const entries = [
      { provider: "codex-pi", model: "gpt-5.6-sol" },
      { provider: "xxx", model: "xxx/xxx/xxx[1m]" },
      { provider: "team/proxy", model: "model" },
      { provider: "team", model: "proxy/model" },
    ];
    const ids = compositeModelRefIds(entries, (entry) => `legacy:${entry.provider}|${entry.model}`);

    expect([...ids.keys()]).toEqual([
      "codex-pi/gpt-5.6-sol",
      "xxx/xxx/xxx/xxx[1m]",
      "legacy:team/proxy|model",
      "legacy:team|proxy/model",
    ]);
    expect(ids.get("xxx/xxx/xxx/xxx[1m]")).toBe(entries[1]);
  });
});
