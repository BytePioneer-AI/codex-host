import { describe, expect, it } from "vitest";
import { closeCodes, deriveId, headers, paths, registrationContent } from "../src/protocol.js";

describe("relay protocol", () => {
  it("derives the 128-bit lowercase RFC 4648 ID from a fixed Ed25519 public key", () => {
    const publicKey = Buffer.from(
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
      "hex",
    );
    expect(deriveId(publicKey)).toBe("eh7ddx5bksrgcytl7bkai36se4");
    expect(deriveId(publicKey)).toMatch(/^[a-z2-7]{26}$/);
  });

  it("binds the signed content to the control address and challenge", () => {
    expect(registrationContent("relay.example", "abc-_123")).toBe(
      "codexhost-relay-register-v1\nrelay.example\nabc-_123",
    );
    expect(registrationContent("RELAY.Example.:4480", "abc-_123")).toBe(
      "codexhost-relay-register-v1\nrelay.example\nabc-_123",
    );
    expect(paths).toEqual({
      agent: "/v1/agent",
      authenticated: "/v1/authenticated",
      register: "/v1/register",
      tcp: "/v1/tcp",
      notice: "/v1/notice",
    });
    expect(headers).toEqual({
      challenge: "relay-challenge",
      publicKey: "relay-public-key",
      signature: "relay-signature",
      name: "relay-name",
      invite: "relay-invite",
      clientAddress: "relay-client-address",
      clientPort: "relay-client-port",
      connectionId: "relay-connection-id",
    });
    expect(closeCodes).toEqual({
      invalidSignature: 4401,
      registrationTimeout: 4408,
      replaced: 4409,
      invite: 4410,
      nameTaken: 4411,
      banned: 4412,
      full: 4413,
    });
  });
});
