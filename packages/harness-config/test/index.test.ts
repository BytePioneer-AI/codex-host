import { describe, expect, it } from "vitest";
import {
  getHarnessConfig,
  parseHarnessConfig,
  resolveHarnessRuntimeEnv,
  sessionConfigFingerprint,
} from "../src/index.js";

describe("harness configuration", () => {
  it("parses independent endpoint and model settings per harness", () => {
    const config = parseHarnessConfig({
      version: 1,
      harnesses: {
        gemini: { baseUrl: "https://gateway.example/gemini", apiKeyEnv: "GEMINI_KEY", model: "gemini-pro" },
        other: { baseUrl: "https://other.example", apiKeyEnv: "OTHER_KEY", model: "other-model" },
      },
    });
    expect(getHarnessConfig(config, "gemini")).toMatchObject({ baseUrl: "https://gateway.example/gemini", model: "gemini-pro" });
    expect(getHarnessConfig(config, "other")?.baseUrl).toBe("https://other.example");
  });

  it("rejects malformed API key environment names", () => {
    expect(() => parseHarnessConfig({ harnesses: { gemini: { apiKeyEnv: "not valid" } } })).toThrow();
  });

  it("resolves Gemini child environment from the configured key reference", () => {
    const result = resolveHarnessRuntimeEnv(
      { baseUrl: "https://gateway.example", apiKeyEnv: "CUSTOM_KEY", model: "gemini-pro" },
      { CUSTOM_KEY: "secret", PATH: "/bin" },
    );
    expect(result).toMatchObject({ GOOGLE_GEMINI_BASE_URL: "https://gateway.example", GEMINI_API_KEY: "secret", GEMINI_MODEL: "gemini-pro", PATH: "/bin" });
    expect(result).not.toHaveProperty("CUSTOM_KEY", undefined);
  });

  it("changes the session binding when endpoint or model changes", () => {
    const a = sessionConfigFingerprint("gemini", { baseUrl: "https://one", model: "pro" });
    const b = sessionConfigFingerprint("gemini", { baseUrl: "https://two", model: "pro" });
    const c = sessionConfigFingerprint("gemini", { baseUrl: "https://one", model: "flash" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(64);
  });
});
