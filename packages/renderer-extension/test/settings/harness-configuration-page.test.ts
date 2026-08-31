import { harnessConfigurationProfileSummarySchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  appendHarnessConfigurationProfile,
  applyHarnessConfigurationProfileEdits,
  editableAuthenticationTypesForHarness,
  removeHarnessConfigurationProfile,
  supportsFirstClassEndpointConfiguration,
} from "../../src/settings/harness-configuration-page.js";

const profile = harnessConfigurationProfileSummarySchema.parse({
  id: "proxy",
  label: "Proxy",
  authType: "third-party-gateway",
  baseUrl: "https://gateway.example/v1",
  apiKeyConfigured: true,
  apiKeyHint: "...1234",
  model: "gemini-2.5-pro",
  environmentKeys: ["KEEP_ME", "REMOVE_ME"],
});

describe("Harness configuration profile edits", () => {
  it("exposes first-class endpoint fields only where a native translator exists", () => {
    expect(supportsFirstClassEndpointConfiguration("gemini")).toBe(true);
    expect(supportsFirstClassEndpointConfiguration("claude-code")).toBe(true);
    expect(supportsFirstClassEndpointConfiguration("grok")).toBe(true);
    expect(supportsFirstClassEndpointConfiguration("deepseek-harness")).toBe(true);
    expect(supportsFirstClassEndpointConfiguration("pi")).toBe(false);
    expect(editableAuthenticationTypesForHarness("pi", "none")).toEqual([
      "oauth",
      "environment",
      "none",
    ]);
    expect(editableAuthenticationTypesForHarness("gemini", "none")).toContain(
      "third-party-gateway",
    );
    expect(editableAuthenticationTypesForHarness("deepseek-harness", "none")).not.toContain(
      "oauth",
    );
  });

  it("creates and removes profiles while retaining at least one profile", () => {
    const appended = appendHarnessConfigurationProfile([profile]);
    expect(appended.activeProfileId).toBe("profile-2");
    expect(appended.profiles).toHaveLength(2);

    const removed = removeHarnessConfigurationProfile(appended.profiles, appended.activeProfileId);
    expect(removed).toMatchObject({ activeProfileId: "proxy", profiles: [profile] });
    expect(removeHarnessConfigurationProfile([profile], "proxy")).toBeNull();
  });

  it("preserves an existing API key and unchanged environment variables when inputs stay blank", () => {
    const result = applyHarnessConfigurationProfileEdits(profile, {
      label: "Proxy",
      authType: "third-party-gateway",
      baseUrl: "https://gateway.example/v1",
      apiKey: "",
      clearApiKey: false,
      apiKeyEnv: "",
      model: "gemini-2.5-pro",
      command: "",
      environment: {},
      presentEnvironmentKeys: new Set(["KEEP_ME", "REMOVE_ME"]),
    });

    expect(result).not.toHaveProperty("apiKey");
    expect(result).not.toHaveProperty("clearApiKey");
    expect(result).not.toHaveProperty("environment");
    expect(result).not.toHaveProperty("removeEnvironmentKeys");
  });

  it("expresses explicit secret removal and only removes environment keys absent from the editor", () => {
    const result = applyHarnessConfigurationProfileEdits(profile, {
      label: "Renamed proxy",
      authType: "third-party-gateway",
      baseUrl: "https://gateway.example/v1",
      apiKey: "",
      clearApiKey: true,
      apiKeyEnv: "",
      model: "gemini-2.5-flash",
      command: "gemini --acp",
      environment: { NEW_VALUE: "secret-value" },
      presentEnvironmentKeys: new Set(["KEEP_ME", "NEW_VALUE"]),
    });

    expect(result).toMatchObject({
      label: "Renamed proxy",
      clearApiKey: true,
      environment: { NEW_VALUE: "secret-value" },
      removeEnvironmentKeys: ["REMOVE_ME"],
    });
    expect(result).not.toHaveProperty("apiKey");
  });
});
