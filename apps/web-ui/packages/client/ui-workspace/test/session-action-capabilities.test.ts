import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import {
  canForkSession,
  canPinSession,
  isRemoteSessionSummary,
} from "../src/client/session-actions/capabilities.ts";

describe("session action remote capabilities", () => {
  it("allows pin and fork for local sessions", () => {
    const local = { id: SessionId("local-thread-1"), projectionValues: {} };
    assert.equal(isRemoteSessionSummary(local), false);
    assert.equal(canPinSession(local), true);
    assert.equal(canForkSession(local), true);
  });

  it("allows pin and hides fork for remote-peer sessions", () => {
    const peer = {
      id: SessionId("web-remote:WyJyZW1vdGUtcGVlcjp2cHMiLCJ0MSJd"),
      projectionValues: {
        remoteHost: { hostId: "remote-peer:vps", displayName: "VPS", state: "connected" },
      },
    };
    assert.equal(isRemoteSessionSummary(peer), true);
    assert.equal(canPinSession(peer), true);
    assert.equal(canForkSession(peer), false);
  });

  it("hides both pin and fork for non-peer Desktop remote sessions", () => {
    const ssh = {
      id: SessionId("web-remote:WyJyZW1vdGUtc3NoOmJveCIsInQxIl0"),
      projectionValues: {
        remoteHost: { hostId: "remote-ssh:box", displayName: "SSH Box", state: "connected" },
      },
    };
    const control = {
      id: SessionId("web-remote:WyJyZW1vdGUtY29udHJvbDphYmMiLCJ0MSJd"),
      projectionValues: {
        remoteHost: { hostId: "remote-control:abc", displayName: "Remote", state: "connected" },
      },
    };
    assert.equal(canPinSession(ssh), false);
    assert.equal(canForkSession(ssh), false);
    assert.equal(canPinSession(control), false);
    assert.equal(canForkSession(control), false);
  });

  it("hides both pin and fork for unhydrated remote IDs and missing summaries", () => {
    const unhydrated = { id: SessionId("web-remote:unhydrated") };
    assert.equal(isRemoteSessionSummary(unhydrated), true);
    assert.equal(canPinSession(unhydrated), false);
    assert.equal(canForkSession(unhydrated), false);
    assert.equal(isRemoteSessionSummary(undefined), false);
    assert.equal(canPinSession(undefined), false);
    assert.equal(canForkSession(undefined), false);
  });
});
