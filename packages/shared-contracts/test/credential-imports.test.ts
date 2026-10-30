import { describe, expect, it } from "vitest";
import {
  credentialImportsParamsSchema,
  credentialImportsResultSchema,
} from "../src/credential-imports.js";

describe("credential import bridge boundary", () => {
  it("requires explicit confirmation and rejects credentials/paths supplied by the browser", () => {
    const request = { action: "import", sourceId: "source", name: "codex", confirmed: true };
    expect(
      credentialImportsParamsSchema.safeParse({ targetHarnessId: "pi", request }).success,
    ).toBe(true);
    for (const extra of [
      { confirmed: false },
      { confirmed: undefined },
      { token: "secret" },
      { path: "/tmp/auth.json" },
      { name: "../escape" },
    ]) {
      expect(
        credentialImportsParamsSchema.safeParse({
          targetHarnessId: "pi",
          request: { ...request, ...extra },
        }).success,
      ).toBe(false);
    }
  });
  it("rejects a response with secret-bearing fields", () => {
    const source = { id: "source", harnessId: "grok", provider: "xai", label: "account" };
    expect(
      credentialImportsResultSchema.safeParse({ sources: [source], targets: [] }).success,
    ).toBe(true);
    expect(
      credentialImportsResultSchema.safeParse({
        sources: [{ ...source, access: "secret" }],
        targets: [],
      }).success,
    ).toBe(false);
  });
});
