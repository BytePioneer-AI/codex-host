import { describe, expect, it, vi } from "vitest";
import { bounded, CopilotOperationError, nativeError, sessionError } from "../src/errors.js";

describe("Copilot error diagnostics", () => {
  it.each([
    [
      Object.assign(new Error("connect timed out"), { code: "ETIMEDOUT" }),
      "nativeFailure",
      true,
      /timed out/,
    ],
    [
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
      "nativeFailure",
      false,
      /permissions/,
    ],
    [
      new Error("Model was rejected by policy"),
      "configurationRequired",
      false,
      /model configuration/,
    ],
    [new Error("Session does not exist"), "sessionNotFound", false, /not found/],
    [new Error("corrupt session transcript"), "protocolError", false, /history/],
    [
      new Error(
        "session resume failed: Session file is corrupted (line 1: key must be a string at line 1 column 2)",
      ),
      "protocolError",
      false,
      /history/,
    ],
    [new Error("SDK protocol version mismatch"), "protocolError", false, /incompatible/],
    [new Error("connection closed"), "processExited", true, /connection/],
    [
      { statusCode: 401, message: "request rejected" },
      "authenticationRequired",
      false,
      /authentication/,
    ],
  ])(
    "classifies native errors without replacing the reason with one generic message",
    (error, code, retryable, message) => {
      expect(nativeError(error, "session.resume")).toMatchObject({
        code,
        retryable,
        message: expect.stringMatching(message as RegExp),
        stage: "session.resume",
      });
      expect(nativeError(error).diagnostic).toBeTruthy();
    },
  );

  it("redacts credentials, auth headers, URL secrets, and quoted secret values", () => {
    for (const message of [
      'Native request failed GH_TOKEN=synthetic-token password="two word password"',
      "Native request failed secret=unquoted secret words",
      'Native request failed {"api_key":"quoted secret value"}',
      "Native request failed Authorization: Basic dXNlcjpwYXNz",
      "Native request failed Cookie: session=sensitive-cookie; other=value",
      "Native request failed github_pat_SecretValue123 ghp_SecretValue123 sk-SecretValue123",
      "Native request failed https://user:password@host/path?secret=secret-query&other=other-query",
      "Native request failed\nstderr: raw-secret-from-stderr",
    ]) {
      const result = JSON.stringify(
        nativeError(
          Object.assign(new Error(message), {
            stderr: "stderr-secret",
            data: { answer: "data-secret" },
          }),
          "model.select",
        ),
      );
      for (const secret of [
        "synthetic-token",
        "two word password",
        "quoted secret value",
        "dXNlcjpwYXNz",
        "sensitive-cookie",
        "SecretValue123",
        "user:password",
        "secret-query",
        "other-query",
        "raw-secret-from-stderr",
        "stderr-secret",
        "data-secret",
        "unquoted secret words",
      ])
        expect(result).not.toContain(secret);
      expect(result).toContain("model.select");
    }
  });

  it("does not copy secret answers even when they have no recognizable token format", () => {
    const secret = "ordinary words used as a private answer";
    expect(JSON.stringify(nativeError(new Error(secret), "interaction"))).not.toContain(secret);
    expect(
      JSON.stringify(nativeError(new Error(`Invalid answer: ${secret}`), "turn.start")),
    ).not.toContain(secret);
    expect(
      JSON.stringify(
        nativeError(new CopilotOperationError("unsupported", secret, secret), "interaction"),
      ),
    ).not.toContain(secret);
    const corrupt = nativeError(
      new Error(`Session file is corrupted near "${secret}" at line 7 column 2`),
      "session.resume",
    );
    expect(corrupt.diagnostic).toContain("line 7");
    expect(corrupt.diagnostic).toContain("column 2");
    expect(corrupt.diagnostic).not.toContain(secret);
  });

  it("keeps typed operation failures and sanitized stage-specific diagnostics", () => {
    const problem = nativeError(
      new CopilotOperationError(
        "configurationRequired",
        "Copilot rejected permission mode.",
        "policy denied token=secret-value",
        false,
        "permissionMode.select",
      ),
      "session.create",
    );
    expect(problem).toMatchObject({
      code: "configurationRequired",
      message: "Copilot rejected permission mode.",
      stage: "permissionMode.select",
      retryable: false,
    });
    expect(problem.diagnostic).toContain("policy denied");
    expect(problem.diagnostic).not.toContain("secret-value");
    expect(nativeError(new Error("x".repeat(20000))).diagnostic?.length).toBeLessThanOrEqual(2000);
    expect(
      sessionError({ statusCode: 401, message: "Authorization: Bearer secret" }),
    ).toMatchObject({ code: "authenticationRequired", stage: "turn.execute" });
  });

  it("reports the bounded timeout duration", async () => {
    vi.useFakeTimers();
    try {
      const result = bounded(new Promise<never>(() => {}), 25).catch((error) =>
        nativeError(error, "inspect.start"),
      );
      await vi.advanceTimersByTimeAsync(25);
      expect(await result).toMatchObject({
        code: "nativeFailure",
        retryable: true,
        stage: "inspect.start",
        diagnostic: expect.stringContaining("25 ms"),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
