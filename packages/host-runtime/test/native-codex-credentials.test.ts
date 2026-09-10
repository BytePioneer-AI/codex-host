import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import {
  InvalidNativeCodexCredentialsError,
  NativeCodexCredentials,
  sameCodexCredentialIdentity,
} from "../src/account/native-codex-credentials.js";
import { syntheticNativeCredentials } from "./fixtures/codex-account-fixtures.js";

const nativeA = syntheticNativeCredentials({ subject: "user-a" });

describe("native Codex credential association", () => {
  it("distinguishes different users of one workspace", () => {
    const a = NativeCodexCredentials.parse(nativeA);
    const b = NativeCodexCredentials.parse(syntheticNativeCredentials({ subject: "user-b" }));
    expect(a.identity.workspaceId).toBe(b.identity.workspaceId);
    expect(sameCodexCredentialIdentity(a.identity, b.identity)).toBe(false);
    expect(a.email).toBe("user-a@example.com");
    expect(a.planType).toBe("team");
  });

  it("keeps identity stable across rotation and email changes", () => {
    const initial = NativeCodexCredentials.parse(nativeA);
    const updated = NativeCodexCredentials.parse(
      syntheticNativeCredentials({
        subject: "user-a",
        generation: 2,
        email: "new@example.com",
      }),
    );
    expect(sameCodexCredentialIdentity(initial.identity, updated.identity)).toBe(true);
    expect(updated.email).toBe("new@example.com");
    expect(initial.serializeForNativeStore()).not.toBe(updated.serializeForNativeStore());
  });

  it("preserves the entire native document without rewriting refresh or unknown fields", () => {
    const serialized = `  ${nativeA}\n`;
    expect(NativeCodexCredentials.parse(serialized).serializeForNativeStore()).toBe(serialized);
  });

  it("does not expose raw tokens to JSON, object spread or inspection", () => {
    const credentials = NativeCodexCredentials.parse(nativeA);
    const tokens = JSON.parse(nativeA).tokens;
    for (const output of [
      JSON.stringify(credentials),
      JSON.stringify({ ...credentials }),
      inspect(credentials, { showHidden: true }),
    ]) {
      expect(output).not.toContain(tokens.access_token);
      expect(output).not.toContain(tokens.id_token);
      expect(output).not.toContain(tokens.refresh_token);
    }
  });

  it.each(["account_id", "id_token", "access_token"])(
    "rejects mismatched %s without leaking input",
    (field) => {
      const document = JSON.parse(nativeA);
      const b = JSON.parse(
        syntheticNativeCredentials({ subject: "user-b", workspaceId: "other-team" }),
      );
      document.tokens[field] = b.tokens[field];
      expect(() => NativeCodexCredentials.parse(JSON.stringify(document))).toThrow(
        InvalidNativeCodexCredentialsError,
      );
    },
  );

  it.each([
    { auth_mode: "apikey", OPENAI_API_KEY: "synthetic-secret" },
    { auth_mode: "chatgptAuthTokens", tokens: { access_token: "synthetic-secret" } },
    { auth_mode: "chatgpt", tokens: { refresh_token: "synthetic-secret" } },
  ])("rejects unsupported documents with a fixed, cause-free error", (document) => {
    let error: unknown;
    try {
      NativeCodexCredentials.parse(JSON.stringify(document));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InvalidNativeCodexCredentialsError);
    expect(inspect(error, { showHidden: true })).not.toContain("synthetic-secret");
    expect(error).not.toHaveProperty("cause");
  });

  it("rejects oversized and malformed input without including it in the error", () => {
    expect(() => NativeCodexCredentials.parse("synthetic-secret ".repeat(30_000))).toThrow(
      "Native Codex credentials are invalid or unsupported",
    );
    expect(() => NativeCodexCredentials.parse('{"synthetic-secret":')).toThrow(
      "Native Codex credentials are invalid or unsupported",
    );
  });

  it("does not label unverified decoded claims as an authenticated session", () => {
    // Parsing is intentionally possible with synthetic signatures. Runtime authentication
    // is a separate mandatory step before saveVerifiedAccount/current-account commit.
    const credentials = NativeCodexCredentials.parse(nativeA);
    expect(credentials).not.toHaveProperty("verified");
    expect(credentials).not.toHaveProperty("authenticated");
  });
});
