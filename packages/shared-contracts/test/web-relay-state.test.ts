import { expect, it } from "vitest";
import { webAccessStateSchema, webRelayStateSchema } from "../src/web-access-tokens.js";

it("retains refusal reasons, capacity retry, remembered hostname and quota recovery", () => {
  for (const reason of ["invite", "name-taken", "banned"]) {
    expect(webRelayStateSchema.parse({ status: "off", reason })).toEqual({ status: "off", reason });
  }
  expect(webRelayStateSchema.parse({ status: "connecting", reason: "full" })).toEqual({
    status: "connecting",
    reason: "full",
  });
  const relay = {
    state: { status: "connecting", reason: "full" },
    identityPath: "/identity.pem",
    hostname: "alice.relay.test",
    quotaUntil: "2026-11-07T00:00:00.000Z",
  };
  expect(
    webAccessStateSchema.parse({
      secret: "token",
      lastUsedAt: null,
      networkUrls: [],
      tailscale: { status: "not-installed" },
      relay,
    }).relay,
  ).toEqual(relay);
  expect(webRelayStateSchema.safeParse({ status: "off", reason: "full" }).success).toBe(false);
});

it("requires certificate state on registered relays and retains issuance/failure details", () => {
  for (const status of ["connected", "missing-certificate"]) {
    const state = {
      status,
      url: "https://computer.relay.test/",
      certificate: {
        expiresAt: "2027-01-01T00:00:00Z",
        issuing: false,
        failure: { detail: "CAA refused", retryAt: "2026-12-01T00:00:00Z", paused: true },
      },
    };
    expect(webRelayStateSchema.parse(state)).toEqual(state);
    expect(webRelayStateSchema.safeParse({ status, url: state.url }).success).toBe(false);
    expect(webRelayStateSchema.parse({ ...state, certificate: { issuing: true } })).toEqual({
      ...state,
      certificate: { issuing: true },
    });
  }
});
