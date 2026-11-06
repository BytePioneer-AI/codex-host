import { expect, it } from "vitest";
import { webRelayStateSchema } from "../src/web-access-tokens.js";

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
