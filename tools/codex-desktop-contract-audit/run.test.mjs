import { describe, expect, it } from "vitest";

import { parseAuditArguments, validateLoopbackEndpoint } from "./run.mjs";

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
});
