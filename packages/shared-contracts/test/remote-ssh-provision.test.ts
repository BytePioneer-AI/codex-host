import { describe, expect, it } from "vitest";

import {
  classifyRemoteSshOccupancy,
  isRemoteSshHostId,
  remoteSshProvisionParamsSchema,
  sshTargetFromRemoteHostId,
} from "../src/remote-ssh-provision.js";

describe("remote SSH Host identity", () => {
  it("extracts SSH targets from Desktop Host IDs", () => {
    expect(sshTargetFromRemoteHostId("remote-ssh-discovered:uts")).toBe("uts");
    expect(sshTargetFromRemoteHostId("remote-ssh:company")).toBe("company");
    expect(sshTargetFromRemoteHostId("remote-ssh-codex-managed:%E5%85%AC%E5%8F%B8")).toBe("公司");
    expect(sshTargetFromRemoteHostId("local")).toBeNull();
    expect(isRemoteSshHostId("remote-ssh-discovered:uts")).toBe(true);
    expect(isRemoteSshHostId("local")).toBe(false);
  });

  it("accepts an explicit SSH target", () => {
    expect(
      remoteSshProvisionParamsSchema.parse({
        hostId: "remote-ssh-discovered:uts",
        sshTarget: "uts",
      }),
    ).toEqual({ hostId: "remote-ssh-discovered:uts", sshTarget: "uts" });
  });

  it("classifies official remote-control occupancy before other states", () => {
    expect(
      classifyRemoteSshOccupancy({
        grokPath: "/home/pengqlu/.local/bin/grok",
        ownerCommand: "codex app-server --remote-control --listen unix://",
      }),
    ).toBe("official-remote-control");
    expect(
      classifyRemoteSshOccupancy({
        grokPath: "/usr/bin/grok",
        ownerCommand: "codex app-server --listen unix://",
      }),
    ).toBe("unknown-busy");
    expect(classifyRemoteSshOccupancy({ grokPath: null, ownerCommand: null })).toBe("grok-missing");
    expect(classifyRemoteSshOccupancy({ grokPath: "/usr/bin/grok", ownerCommand: null })).toBe(
      "idle",
    );
  });
});
