import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectToken, type ProjectCredential } from "../src/project-token.js";
import { ZcodeError } from "../src/errors.js";

const credential: ProjectCredential = {
  origin: "https://business.invalid",
  loginToken: "synthetic-login",
  location: { organizationId: "org", projectId: "project", apiKeyId: "key" },
  accountScope: "fixture-scope",
};
function response(overrides: object = {}) {
  return new Response(
    JSON.stringify({
      code: 200,
      data: {
        accessToken: "synthetic-project-token",
        tokenType: "Bearer",
        expiresIn: 3600,
        expiresAt: Date.now() / 1000 + 3600,
        ...overrides,
      },
    }),
  );
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ZCode request-time project token", () => {
  it("refreshes before expiry only when requested and scopes cached tokens to login and project", async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => response());
    const tokens = new ProjectToken();
    const read = (value = credential) =>
      tokens.resolve(value, "3.16.3", new AbortController().signal);
    await read();
    await read();
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 3_500_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await read();
    expect(fetch).toHaveBeenCalledTimes(2);
    await read({ ...credential, loginToken: "new-login" });
    await read({ ...credential, location: { ...credential.location, projectId: "other" } });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it.each([
    { enable: false },
    { expiresAt: 1 },
    { expiresIn: 0 },
    { accessToken: "" },
    { tokenType: "unknown" },
  ])("rejects disabled, expired or malformed responses: %j", async (data) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => response(data));
    await expect(
      new ProjectToken().resolve(credential, "3.16.3", new AbortController().signal),
    ).rejects.toThrow("project credentials are unavailable");
  });

  it("does not expose HTTP bodies or thrown transport errors", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const fail of [
      async () => new Response("synthetic-login synthetic-project-token", { status: 401 }),
      async () => {
        throw new Error("synthetic-login synthetic-project-token");
      },
      async () => new Response(JSON.stringify({ code: 403, data: {} })),
    ]) {
      fetch.mockImplementation(fail);
      try {
        await new ProjectToken().resolve(credential, "3.16.3", new AbortController().signal);
        throw new Error("unexpected success");
      } catch (error) {
        expect(String(error)).toContain("project credentials are unavailable");
        expect(String(error)).not.toContain("synthetic-");
      }
    }
  });

  it("aborts the token request and never caches a response after cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("synthetic-cancellation-reason");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      controller.abort(reason);
      expect(init?.signal?.aborted).toBe(true);
      return response();
    });
    const tokens = new ProjectToken();
    await expect(tokens.resolve(credential, "3.16.3", controller.signal)).rejects.toBe(reason);
    fetch.mockImplementation(async () => response());
    await tokens.resolve(credential, "3.16.3", new AbortController().signal);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports deadline expiry as retryable unavailability without leaking the native message", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("synthetic-login", "TimeoutError"),
    );
    const result = new ProjectToken().resolve(credential, "3.16.3", new AbortController().signal);
    await expect(result).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
      message: "ZCode project token request timed out. Try again.",
    });
  });

  it("preserves an existing adapter error classification", async () => {
    const error = new ZcodeError("unavailable", "Sanitized adapter failure", true);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
    await expect(
      new ProjectToken().resolve(credential, "3.16.3", new AbortController().signal),
    ).rejects.toBe(error);
  });
});
