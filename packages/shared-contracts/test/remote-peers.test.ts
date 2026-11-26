import { describe, expect, it } from "vitest";

import {
  REMOTE_PEER_COLORS,
  defaultRemotePeerColor,
  peerDelegationHostSummarySchema,
  remotePeerAddParamsSchema,
  remotePeerColorSchema,
  remotePeerIntroduceParamsSchema,
  remotePeerIntroduceResultSchema,
  remotePeerManifestSchema,
  remotePeerPairingReportSchema,
  remotePeerNodeIdSchema,
  remotePeerSummarySchema,
  remotePeerSyncMeshParamsSchema,
  remotePeerTestResultSchema,
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

  it("keeps pairing opt-in and validates the credential-bearing request separately from public results", () => {
    const introduction = { origin: "https://a.example", token: "secret", expectedNodeId: "node-a" };
    expect(remotePeerIntroduceParamsSchema.parse({ ...introduction, name: " A " }).name).toBe("A");
    expect(
      remotePeerIntroduceParamsSchema.safeParse({ ...introduction, pairBack: true }).success,
    ).toBe(false);
    const result = {
      status: "updated",
      peerId: "a-1",
      hostId: "remote-peer:a-1",
      nodeId: "node-a",
    };
    expect(remotePeerIntroduceResultSchema.parse({ ...introduction, ...result })).toEqual(result);
    expect(remotePeerSyncMeshParamsSchema.parse({})).toEqual({});
    expect(
      remotePeerSyncMeshParamsSchema.safeParse({ peerIds: Array(65).fill("peer") }).success,
    ).toBe(false);
    const add = {
      ...introduction,
      pairBack: true,
      meshPeerIds: ["a-1"],
      selfOrigin: "https://b.example",
    };
    expect(remotePeerAddParamsSchema.parse(add)).toMatchObject({
      pairBack: true,
      meshPeerIds: ["a-1"],
      selfOrigin: add.selfOrigin,
    });
    const report = {
      results: [
        {
          targetPeerId: "a-1",
          targetName: "A",
          introducedHost: "local",
          introducedName: "B",
          status: "skipped",
        },
      ],
    };
    expect(remotePeerPairingReportSchema.parse(report)).toEqual(report);
    const testResult = { ok: true, supportsPeerPairing: true, pairedBack: false, nodeId: "node-a" };
    expect(remotePeerTestResultSchema.parse(testResult)).toEqual(testResult);
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

  it("validates optional nodeId and anonymous peerNodes on manifest and host summaries", () => {
    expect(remotePeerNodeIdSchema.parse("node_a-01")).toBe("node_a-01");
    expect(() => remotePeerNodeIdSchema.parse("")).toThrow();
    expect(() => remotePeerNodeIdSchema.parse("bad/id")).toThrow();
    expect(() => remotePeerNodeIdSchema.parse("a".repeat(65))).toThrow();

    const baseManifest = {
      version: "0.26.1",
      platform: "darwin",
      hostname: "node-b",
      epoch: "epoch-1",
      projects: [],
    };
    // Legacy peer manifest without nodeId / peerNodes stays valid.
    expect(remotePeerManifestSchema.parse(baseManifest).nodeId).toBeUndefined();

    const withNodes = remotePeerManifestSchema.parse({
      ...baseManifest,
      nodeId: "node-b-uuid",
      capabilities: { peerPairing: 1 },
      peerNodes: {
        "remote-peer:peer-a": "node-a-uuid",
        "remote-peer:peer-c": "node-c-uuid",
      },
    });
    expect(withNodes.nodeId).toBe("node-b-uuid");
    expect(withNodes.capabilities).toEqual({ peerPairing: 1 });
    expect(withNodes.peerNodes).toEqual({
      "remote-peer:peer-a": "node-a-uuid",
      "remote-peer:peer-c": "node-c-uuid",
    });

    // Reject invalid peerNodes key, invalid nodeId value, and >128 entries.
    expect(() =>
      remotePeerManifestSchema.parse({
        ...baseManifest,
        peerNodes: { local: "node-a-uuid" },
      }),
    ).toThrow();
    expect(() =>
      remotePeerManifestSchema.parse({
        ...baseManifest,
        peerNodes: { "remote-peer:peer-a": "https://secret.example" },
      }),
    ).toThrow();
    const tooMany = Object.fromEntries(
      Array.from({ length: 129 }, (_, i) => [`remote-peer:p${i}`, `node-${i}`]),
    );
    expect(() => remotePeerManifestSchema.parse({ ...baseManifest, peerNodes: tooMany })).toThrow();

    expect(
      remotePeerSummarySchema.parse({
        peerId: "peer-1",
        hostId: "remote-peer:peer-1",
        nodeId: "node-b-uuid",
        name: "Mac Studio",
        origin: "https://peer.r.chost.dev",
        transportKind: "relay",
        encrypted: true,
        enabled: true,
        state: "connected",
        projectCount: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }).nodeId,
    ).toBe("node-b-uuid");

    expect(
      peerDelegationHostSummarySchema.parse({
        hostId: "remote-peer:peer-1",
        nodeId: "node-b-uuid",
        displayName: "Mac Studio",
        online: true,
        state: "connected",
        delegation: true,
        projects: [],
      }).nodeId,
    ).toBe("node-b-uuid");
  });
});
