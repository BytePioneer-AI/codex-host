import { describe, expect, it } from "vitest";

import { LOCAL_USAGE_HOST_ID, usageHostOptions } from "../../src/console/usage/usage-hosts.js";

describe("usage statistics machine options", () => {
  it("keeps the local machine first and names remote machines by their connection name", () => {
    expect(
      usageHostOptions(
        [
          { hostId: "remote-ssh-codex-managed:fixture", label: "Build machine" },
          { hostId: "remote-ssh-discovered:mac" },
        ],
        "This machine",
        LOCAL_USAGE_HOST_ID,
      ),
    ).toEqual([
      { key: LOCAL_USAGE_HOST_ID, label: "This machine" },
      { key: "remote-ssh-codex-managed:fixture", label: "Build machine" },
      // A machine with no connection name is still selectable under its Host ID.
      { key: "remote-ssh-discovered:mac", label: "remote-ssh-discovered:mac" },
    ]);
  });

  it("does not repeat a Host ID offered twice, including the local one", () => {
    expect(
      usageHostOptions(
        [
          { hostId: LOCAL_USAGE_HOST_ID, label: "local" },
          { hostId: "remote-ssh-codex-managed:fixture", label: "Build machine" },
          { hostId: "remote-ssh-codex-managed:fixture", label: "Build machine again" },
        ],
        "本机",
        LOCAL_USAGE_HOST_ID,
      ),
    ).toEqual([
      { key: LOCAL_USAGE_HOST_ID, label: "本机" },
      { key: "remote-ssh-codex-managed:fixture", label: "Build machine" },
    ]);
  });

  it("keeps a selected machine visible after it stops being offered", () => {
    // The machine is still selected: the page must show which Host its numbers come from.
    expect(usageHostOptions(undefined, "This machine", "remote-ssh-codex-managed:gone")).toEqual([
      { key: LOCAL_USAGE_HOST_ID, label: "This machine" },
      { key: "remote-ssh-codex-managed:gone", label: "remote-ssh-codex-managed:gone" },
    ]);
  });

  it("offers one option when only the local machine exists", () => {
    expect(usageHostOptions([], "This machine", LOCAL_USAGE_HOST_ID)).toEqual([
      { key: LOCAL_USAGE_HOST_ID, label: "This machine" },
    ]);
  });
});
