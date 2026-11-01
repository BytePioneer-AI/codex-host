import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeBuddyCopyCleanup } from "../src/copy-cleanup.js";

afterEach(() => vi.unstubAllGlobals());

async function announce(cleanup: CodeBuddyCopyCleanup, endpoint = "http://127.0.0.1:12345") {
  const output = cleanup.protocolOutput(
    Readable.from([
      `CodeBuddy Code HTTP Server\n  \u001b[32mEndpoint\u001b[0m    ${endpoint}\nPassword    ${cleanup.password}\n`,
      '{"jsonrpc":"2.0","id":1,"result":{}}\n',
    ]),
  );
  const chunks: Buffer[] = [];
  for await (const chunk of output) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

describe("CodeBuddy native temporary copy cleanup", () => {
  it("keeps the native server process-local and strips banners before ACP parsing", async () => {
    const cleanup = new CodeBuddyCopyCleanup("owned-copy", "/workspace");
    const environment = cleanup.environment({
      CODEBUDDY_GATEWAY_AUTH: "none",
      CODEBUDDY_GATEWAY_BASE_PATH: "/user",
    });
    expect(environment).toMatchObject({
      CODEBUDDY_GATEWAY_AUTH: "password",
      CODEBUDDY_GATEWAY_BASE_PATH: "",
      CODEBUDDY_GATEWAY_PASSWORD: cleanup.password,
    });
    expect(cleanup.arguments).toEqual([
      "--acp",
      "--serve",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--auth",
      "password",
    ]);
    expect(await announce(cleanup)).toBe('{"jsonrpc":"2.0","id":1,"result":{}}\n');
  });

  it("deletes only its owned copy using authentication and the native request header", async () => {
    const cleanup = new CodeBuddyCopyCleanup("owned-copy", "/workspace with spaces");
    await announce(cleanup);
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    await cleanup.remove();
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:12345/api/v1/sessions/owned-copy?cwd=%2Fworkspace%20with%20spaces",
      expect.objectContaining({
        method: "DELETE",
        headers: { Authorization: `Bearer ${cleanup.password}`, "x-codebuddy-request": "true" },
        redirect: "error",
      }),
    );
  });

  it.each([400, 401, 404, 500])("reports retained data on native HTTP %s", async (status) => {
    const cleanup = new CodeBuddyCopyCleanup("owned-copy", "/workspace");
    await announce(cleanup);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
    await expect(cleanup.remove()).rejects.toThrow(
      `Native cleanup failed (${status}); temporary Session owned-copy remains`,
    );
  });

  it("reports failed requests without exposing transport details or its password", async () => {
    const cleanup = new CodeBuddyCopyCleanup("owned-copy", "/workspace");
    await announce(cleanup);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(cleanup.password)));
    await expect(cleanup.remove()).rejects.toThrow(
      "Native cleanup request failed; temporary Session owned-copy remains",
    );
  });

  it("does not send credentials to an unrecognized or non-loopback endpoint", async () => {
    const cleanup = new CodeBuddyCopyCleanup("owned-copy", "/workspace");
    await announce(cleanup, "https://other.invalid:12345");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(cleanup.remove()).rejects.toThrow("endpoint was not reported");
    expect(fetch).not.toHaveBeenCalled();
  });
});
