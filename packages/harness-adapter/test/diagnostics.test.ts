import { describe, expect, it } from "vitest";

import { sanitizeDiagnosticTail } from "../src/diagnostics.js";

describe("diagnostic output", () => {
  it("redacts credentials and keeps only the tail", () => {
    const output = sanitizeDiagnosticTail(
      `${"x".repeat(8_100)}\nAPI_KEY=secret-value Authorization: Bearer token-value`,
    );

    expect(output.length).toBeLessThanOrEqual(8_000);
    expect(output).toContain("API_KEY=[redacted]");
    expect(output).toContain("Authorization: [redacted]");
    expect(output).not.toContain("secret-value");
    expect(output).not.toContain("token-value");
  });
});
