import { describe, expect, it } from "vitest";

import { filterAmbientNodeWarnings, sanitizeDiagnosticTail } from "../src/diagnostics.js";

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

describe("ambient Node warning filtering", () => {
  const UNDICI_EHPA_WARNING = [
    "(node:34177) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time.",
    "(Use `node --trace-warnings ...` to show where the warning was created)",
  ].join("\n");

  it("drops UNDICI-EHPA warnings and their trace-warnings hint", () => {
    const filtered = filterAmbientNodeWarnings(`${UNDICI_EHPA_WARNING}\n`);
    expect(filtered).toBe("");
  });

  it("keeps substantive stderr when warnings are interleaved", () => {
    const filtered = filterAmbientNodeWarnings(
      `${UNDICI_EHPA_WARNING}\nreal diagnostic failure\n(Use \`node --trace-warnings ...\` to show where the warning was created)\n`,
    );
    expect(filtered).toBe("real diagnostic failure\n");
  });

  it("does not touch output that merely mentions node", () => {
    const filtered = filterAmbientNodeWarnings(
      "error: cannot find module ./node-helper\n(node-inspector) attached\n",
    );
    expect(filtered).toBe("error: cannot find module ./node-helper\n(node-inspector) attached\n");
  });
});
