import { describe, expect, it } from "vitest";

import {
  REMOTE_PEER_COLORS,
  defaultRemotePeerColor,
  remotePeerAddParamsSchema,
  remotePeerColorSchema,
  remotePeerSummarySchema,
  remotePeerUpdateParamsSchema,
  resolveRemotePeerColor,
} from "@codexhost/shared-contracts";

describe("remote peer host colors", () => {
  it("exports the restrained 7-color palette in canonical order", () => {
    expect(REMOTE_PEER_COLORS).toEqual([
      "blue",
      "purple",
      "cyan",
      "green",
      "amber",
      "rose",
      "slate",
    ]);
    for (const color of REMOTE_PEER_COLORS) {
      expect(remotePeerColorSchema.parse(color)).toBe(color);
    }
    expect(() => remotePeerColorSchema.parse("magenta")).toThrow();
  });

  it("assigns deterministic fallback colors per hostId and spreads across distinct hosts", () => {
    const first = defaultRemotePeerColor("remote-peer:us-vps");
    expect(REMOTE_PEER_COLORS).toContain(first);
    expect(defaultRemotePeerColor("remote-peer:us-vps")).toBe(first);

    const assigned = new Set(
      [
        "remote-peer:us-vps",
        "remote-peer:jp-box",
        "remote-peer:eu-dev",
        "remote-peer:mac-studio",
        "remote-peer:gpu-node-01",
        "remote-peer:gpu-node-02",
        "remote-peer:build-01",
        "remote-peer:build-02",
      ].map((hostId) => defaultRemotePeerColor(hostId)),
    );
    expect(assigned.size).toBeGreaterThan(2);
  });

  it("resolves explicit valid colors and falls back deterministically otherwise", () => {
    const hostId = "remote-peer:studio";
    const fallback = defaultRemotePeerColor(hostId);
    expect(resolveRemotePeerColor(hostId, "rose")).toBe("rose");
    expect(resolveRemotePeerColor(hostId, undefined)).toBe(fallback);
    expect(resolveRemotePeerColor(hostId, null)).toBe(fallback);
    expect(resolveRemotePeerColor(hostId, "not-a-color")).toBe(fallback);
  });

  it("validates optional color in add/summary schemas and nullable color in update schema", () => {
    expect(
      remotePeerAddParamsSchema.parse({
        connectionUrl: "https://peer.r.chost.dev/#token=abc",
        color: "cyan",
      }).color,
    ).toBe("cyan");
    expect(
      remotePeerUpdateParamsSchema.parse({
        peerId: "peer-1",
        color: "amber",
      }).color,
    ).toBe("amber");
    expect(
      remotePeerUpdateParamsSchema.parse({
        peerId: "peer-1",
        color: null,
      }).color,
    ).toBeNull();
    expect(
      remotePeerSummarySchema.parse({
        peerId: "peer-1",
        hostId: "remote-peer:peer-1",
        name: "Mac Studio",
        color: "green",
        origin: "https://peer.r.chost.dev",
        transportKind: "relay",
        encrypted: true,
        enabled: true,
        state: "connected",
        projectCount: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }).color,
    ).toBe("green");
  });
});
