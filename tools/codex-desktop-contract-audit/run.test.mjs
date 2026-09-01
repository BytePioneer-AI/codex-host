import { describe, expect, it } from "vitest";

import { parseAuditArguments, readDesktopIdentity, validateLoopbackEndpoint } from "./run.mjs";

const explicitIdentityArguments = [
  "--desktop-platform",
  "macos",
  "--desktop-version",
  "26.825.41651",
  "--desktop-build",
  "7345",
  "--asar-integrity",
  `sha256:${"a".repeat(64)}`,
];

describe("Codex Desktop contract audit CLI", () => {
  it("defaults to read-only loopback inspection", () => {
    expect(parseAuditArguments([])).toMatchObject({
      mode: "read-only",
      endpoint: "http://127.0.0.1:9222",
      inspectorEndpoint: "http://127.0.0.1:9223",
      baselinePath: null,
    });
  });

  it("requires controlled mode explicitly", () => {
    expect(parseAuditArguments(["--mode", "controlled"]).mode).toBe("controlled");
    expect(() => parseAuditArguments(["--mode", "automatic"])).toThrow(
      "--mode must be read-only or controlled",
    );
  });

  it("rejects non-loopback endpoints", () => {
    expect(() => validateLoopbackEndpoint("http://example.com:9222", "--endpoint")).toThrow(
      "loopback HTTP URL",
    );
    expect(() => parseAuditArguments(["--endpoint", "https://127.0.0.1:9222"])).toThrow(
      "loopback HTTP URL",
    );
  });

  it("reads all four explicitly supplied bounded identity fields", () => {
    expect(readDesktopIdentity(parseAuditArguments(explicitIdentityArguments))).toEqual({
      platform: "macos",
      version: "26.825.41651",
      build: "7345",
      asarIntegrity: `sha256:${"a".repeat(64)}`,
    });
  });

  it("rejects a partial explicit identity instead of mixing fixture and launcher values", () => {
    expect(() =>
      readDesktopIdentity(
        parseAuditArguments(
          explicitIdentityArguments.slice(0, explicitIdentityArguments.length - 2),
        ),
      ),
    ).toThrow(/all four|platform.*version.*build.*asar/i);
  });
});
