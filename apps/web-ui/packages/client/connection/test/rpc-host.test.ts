/** Regression tests for HostConnectionService.requestRejection without browserAuth (#1020). */

import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { HostConnectionService } from "../src/rpc-host.ts";
import type { BrowserAuth } from "../src/browser-auth.ts";
import type { ConnectionTrustRequest } from "../src/rpc.ts";

function request(origin: string | undefined): ConnectionTrustRequest {
  const headers: Record<string, string> = { host: "127.0.0.1:4400" };
  if (origin !== undefined) headers.origin = origin;
  return { headers } as ConnectionTrustRequest;
}

describe("HostConnectionService.requestRejection without browserAuth", () => {
  it("admits a trusted loopback request when the Web backend mounts Connection without an auth owner", () => {
    const service = new HostConnectionService(new Context(), [], undefined);
    expect(service.requestRejection(request(undefined))).toBeUndefined();
    expect(service.requestRejection(request("http://127.0.0.1:4400"))).toBeUndefined();
  });

  it("still refuses untrusted origins while browserAuth is absent", () => {
    const service = new HostConnectionService(new Context(), [], undefined);
    expect(service.requestRejection(request("http://evil.example:4400"))).toBe(403);
  });

  it("keeps browser authentication when an owner is provided", () => {
    const service = new HostConnectionService(new Context(), [], {
      isAuthenticated: () => false,
    } as unknown as BrowserAuth);
    expect(service.requestRejection(request(undefined))).toBe(401);
  });
});
